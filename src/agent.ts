/**
 * Agent Runner for NanoClaw
 * Spawns Claude Agent SDK as a local Node.js process and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Max output size before truncation (10MB)
const MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE || '10485760',
  10,
);

// Agent timeout (30min default)
const AGENT_TIMEOUT = parseInt(process.env.AGENT_TIMEOUT || '1800000', 10);

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export async function runAgent(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> {
  const startTime = Date.now();
  const projectRoot = process.cwd();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const isMain = input.isMain;

  const agentRunnerDir = path.join(projectRoot, 'agent');
  const agentRunnerEntry = path.join(agentRunnerDir, 'dist', 'index.js');

  // Per-group sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills into each group's .claude/skills/
  const skillsSrc = path.join(projectRoot, 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Copy agent-runner source into a per-group writable location
  const agentRunnerSrc = path.join(projectRoot, 'agent', 'src');
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }

  // Global memory directory
  const globalDir = path.join(GROUPS_DIR, 'global');

  // Read API credentials directly
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_MODEL',
  ]);

  const agentEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TZ: TIMEZONE,
    NANOCLAW_WORKSPACE_GROUP: groupDir,
    NANOCLAW_WORKSPACE_IPC: groupIpcDir,
    NANOCLAW_WORKSPACE_GLOBAL: globalDir,
    NANOCLAW_WORKSPACE_PROJECT: isMain ? projectRoot : '',
    CLAUDE_CONFIG_DIR: groupSessionsDir,
  };

  if (secrets.ANTHROPIC_API_KEY) {
    agentEnv.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  }
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN) {
    agentEnv.CLAUDE_CODE_OAUTH_TOKEN = secrets.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (secrets.ANTHROPIC_BASE_URL) {
    agentEnv.ANTHROPIC_BASE_URL = secrets.ANTHROPIC_BASE_URL;
  }
  if (secrets.CLAUDE_MODEL) {
    agentEnv.CLAUDE_MODEL = secrets.CLAUDE_MODEL;
  }

  const processName = `nanoclaw-bare-${group.folder}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processName,
      agentRunner: agentRunnerEntry,
      isMain,
    },
    'Spawning agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const agent = spawn('node', [agentRunnerEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: agentRunnerDir,
      env: agentEnv,
    });

    onProcess(agent, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    agent.stdin.write(JSON.stringify(input));
    agent.stdin.end();

    // Streaming output parsing
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;
    const timeoutMs = Math.max(AGENT_TIMEOUT, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Agent timeout, sending SIGTERM',
      );
      agent.kill('SIGTERM');
      setTimeout(() => {
        if (!agent.killed) agent.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    agent.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: AgentOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) newSessionId = parsed.newSessionId;
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    agent.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ agent: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    agent.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${AGENT_TIMEOUT}ms`,
        });
        return;
      }

      // Write log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
      ];
      if (code !== 0 || process.env.LOG_LEVEL === 'debug') {
        logLines.push(
          '',
          `=== Stderr ===`,
          stderr,
          '',
          `=== Stdout ===`,
          stdout,
        );
      }
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, logFile },
          'Agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: AgentOutput = JSON.parse(jsonLine);
        resolve(output);
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    agent.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

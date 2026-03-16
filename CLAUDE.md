# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process on macOS. Telegram bot receives messages, routes them to Claude Agent SDK running as bare metal child processes. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/agent.ts` | Spawns agent processes, handles streaming output |
| `src/channels/telegram.ts` | Telegram bot (grammy) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `agent/src/index.ts` | Agent runner (Claude SDK caller, runs as child process) |
| `agent/src/ipc-mcp-stdio.ts` | MCP server for nanoclaw tools (send_message, schedule_task, etc.) |
| `skills/agent-browser/SKILL.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
cd agent && npm run build  # Rebuild agent runner
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart
```

## Voice Pipeline

Three launchd services run on the host (all auto-start at login, `KeepAlive: true`):

| Service | Plist | Port | Purpose |
|---------|-------|------|---------|
| NanoClaw | `com.nanoclaw.plist` | — | Main orchestrator (Node.js) |
| TTS Server | `com.nanoclaw.tts-server.plist` | 7890 | Persistent Qwen3-TTS model for voice synthesis |
| STT Server | `com.nanoclaw.stt-server.plist` | 7891 | Persistent Parakeet-MLX model for transcription |

The TTS and STT servers keep their ML models loaded in memory so voice requests don't pay a cold-start penalty. `src/voice.ts` tries the server first, falls back to CLI if unreachable.

```bash
# Manage voice servers
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.tts-server  # restart TTS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.stt-server  # restart STT

# Check status
curl -s http://127.0.0.1:7890  # TTS (POST to generate)
curl -s http://127.0.0.1:7891  # STT (POST to transcribe)

# Logs
tail -f logs/tts-server.log
tail -f logs/stt-server.log
```

Voice message flow: Telegram voice note → STT server (port 7891) transcribes to text → stored with `is_voice: true` → agent responds → TTS server (port 7890) synthesizes response → sent as Telegram voice message.

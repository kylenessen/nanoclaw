/**
 * Voice pipeline utilities for NanoClaw.
 * STT: parakeet-mlx (Nvidia Parakeet TDT on Apple Silicon via MLX)
 * TTS: mlx-audio with Qwen3-TTS (local Apple Silicon)
 *
 * Both STT and TTS providers are configurable via .env:
 *   STT_COMMAND, TTS_COMMAND, TTS_MODEL, TTS_VOICE, TTS_INSTRUCT,
 *   TTS_REF_AUDIO, TTS_REF_TEXT
 *
 * Voice cloning mode (Base model + ref_audio) is used when TTS_REF_AUDIO is set.
 * Otherwise falls back to CustomVoice mode with named speaker + instruct.
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

// Configurable via .env, with sensible defaults
const voiceConfig = readEnvFile([
  'TTS_MODEL',
  'TTS_VOICE',
  'TTS_INSTRUCT',
  'TTS_REF_AUDIO',
  'TTS_REF_TEXT',
]);

// Voice cloning mode: Base model + reference audio
const TTS_REF_AUDIO = voiceConfig.TTS_REF_AUDIO || 'audio/c3po_ref.wav';
const TTS_REF_TEXT =
  voiceConfig.TTS_REF_TEXT ||
  'Oh my, this is quite beyond my programming. I do wish you wouldn\'t rush into these things without consulting me first. I am a protocol droid, after all, not a battle droid. Sir, if I may suggest a more cautious approach, I believe we could avoid a great deal of unnecessary trouble. The odds are not in our favor, but with proper planning, I am confident we can manage. Do trust me on this.';

// Resolve ref audio path relative to project root
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const refAudioAbsPath = path.isAbsolute(TTS_REF_AUDIO)
  ? TTS_REF_AUDIO
  : path.join(PROJECT_ROOT, TTS_REF_AUDIO);
const useVoiceClone = fs.existsSync(refAudioAbsPath);

const TTS_MODEL =
  voiceConfig.TTS_MODEL ||
  (useVoiceClone
    ? 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16'
    : 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16');
const TTS_VOICE = voiceConfig.TTS_VOICE || 'Ryan';
const TTS_INSTRUCT =
  voiceConfig.TTS_INSTRUCT || 'Calm, clear, conversational tone.';

/**
 * Transcribe an audio file to text using parakeet-mlx.
 * Accepts any format ffmpeg can handle (ogg, wav, mp3, etc.)
 */
export async function transcribe(audioPath: string): Promise<string> {
  const tmpDir = fs.mkdtempSync('/tmp/nanoclaw-stt-');
  try {
    // Convert to wav (parakeet-mlx works best with wav)
    const wavPath = path.join(tmpDir, 'audio.wav');
    await execAsync(
      `ffmpeg -i ${JSON.stringify(audioPath)} -ar 16000 -ac 1 -y ${JSON.stringify(wavPath)}`,
      { timeout: 30000 },
    );

    // Transcribe with parakeet-mlx
    await execAsync(
      `parakeet-mlx ${JSON.stringify(wavPath)} --output-format txt --output-dir ${JSON.stringify(tmpDir)}`,
      { timeout: 300000 },
    );

    // Read the transcript file
    const txtFile = path.join(tmpDir, 'audio.txt');
    if (fs.existsSync(txtFile)) {
      return fs.readFileSync(txtFile, 'utf-8').trim();
    }

    throw new Error('Transcript file not generated');
  } catch (err) {
    logger.error({ err, audioPath }, 'Transcription failed');
    throw new Error(
      `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Split text into chunks at sentence boundaries, respecting a max character limit.
 * Qwen3-TTS truncates long text, so we chunk and concatenate.
 */
function chunkText(text: string, maxChars = 500): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Find the last sentence boundary within the limit
    let splitAt = -1;
    for (const sep of ['. ', '! ', '? ', '.\n', '!\n', '?\n']) {
      const idx = remaining.lastIndexOf(sep, maxChars);
      if (idx > splitAt) splitAt = idx + sep.length;
    }

    // Fallback: split at last space
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxChars);
    }
    // Last resort: hard split
    if (splitAt <= 0) {
      splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks;
}

/**
 * Convert text to speech using mlx-audio with Qwen3-TTS.
 * Chunks long text to avoid model truncation, then concatenates audio.
 * Returns the path to the generated ogg file.
 */
export async function textToSpeech(text: string): Promise<string> {
  const tmpDir = fs.mkdtempSync('/tmp/nanoclaw-tts-');
  try {
    const chunks = chunkText(text);
    const wavFiles: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkDir = path.join(tmpDir, `chunk_${i}`);
      fs.mkdirSync(chunkDir, { recursive: true });

      const ttsArgs = useVoiceClone
        ? `--model ${JSON.stringify(TTS_MODEL)} --text ${JSON.stringify(chunks[i])} --ref_audio ${JSON.stringify(refAudioAbsPath)} --ref_text ${JSON.stringify(TTS_REF_TEXT)} --output_path ${JSON.stringify(chunkDir)}`
        : `--model ${JSON.stringify(TTS_MODEL)} --text ${JSON.stringify(chunks[i])} --voice ${JSON.stringify(TTS_VOICE)} --instruct ${JSON.stringify(TTS_INSTRUCT)} --output_path ${JSON.stringify(chunkDir)}`;

      await execAsync(`mlx_audio.tts.generate ${ttsArgs}`, {
        timeout: 120000,
      });

      const chunkWav = path.join(chunkDir, 'audio_000.wav');
      if (fs.existsSync(chunkWav)) {
        wavFiles.push(chunkWav);
      }
    }

    if (wavFiles.length === 0) {
      throw new Error('No audio files generated');
    }

    // Concatenate wav files with ffmpeg
    const combinedWav = path.join(tmpDir, 'combined.wav');
    if (wavFiles.length === 1) {
      fs.copyFileSync(wavFiles[0], combinedWav);
    } else {
      const listFile = path.join(tmpDir, 'concat.txt');
      fs.writeFileSync(listFile, wavFiles.map((f) => `file '${f}'`).join('\n'));
      await execAsync(
        `ffmpeg -f concat -safe 0 -i ${JSON.stringify(listFile)} -y ${JSON.stringify(combinedWav)}`,
        { timeout: 30000 },
      );
    }

    // Convert to ogg/opus for Telegram voice messages
    const oggFile = path.join(tmpDir, 'voice.ogg');
    await execAsync(
      `ffmpeg -i ${JSON.stringify(combinedWav)} -c:a libopus -b:a 64k -y ${JSON.stringify(oggFile)}`,
      { timeout: 30000 },
    );

    return oggFile;
  } catch (err) {
    logger.error({ err }, 'TTS failed');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `TTS failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Clean up a TTS temp directory after sending the audio.
 */
export function cleanupTtsFile(filePath: string): void {
  try {
    const dir = path.dirname(filePath);
    if (dir.startsWith('/tmp/nanoclaw-tts-')) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Best effort cleanup
  }
}

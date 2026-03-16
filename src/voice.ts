/**
 * Voice pipeline utilities for NanoClaw.
 * STT: parakeet-mlx (Nvidia Parakeet TDT on Apple Silicon via MLX)
 * TTS: mlx-audio with Qwen3-TTS (local Apple Silicon)
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const TTS_MODEL = 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16';
const TTS_VOICE = 'Ryan';
const TTS_INSTRUCT = 'Calm, clear, conversational tone.';

/**
 * Transcribe an audio file to text using parakeet-mlx.
 * Accepts any format ffmpeg can handle (ogg, wav, mp3, etc.)
 */
export function transcribe(audioPath: string): string {
  const tmpDir = fs.mkdtempSync('/tmp/nanoclaw-stt-');
  try {
    // Convert to wav if needed (parakeet-mlx works best with wav)
    const wavPath = path.join(tmpDir, 'audio.wav');
    execSync(
      `ffmpeg -i ${JSON.stringify(audioPath)} -ar 16000 -ac 1 -y ${JSON.stringify(wavPath)}`,
      { stdio: 'pipe', timeout: 30000 },
    );

    // Transcribe with parakeet-mlx
    const result = execSync(
      `parakeet-mlx ${JSON.stringify(wavPath)} --output-format txt --output-dir ${JSON.stringify(tmpDir)}`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 300000 },
    );

    // Read the transcript file
    const txtFile = path.join(tmpDir, 'audio.txt');
    if (fs.existsSync(txtFile)) {
      return fs.readFileSync(txtFile, 'utf-8').trim();
    }

    // Fallback: parse stdout
    logger.warn('Transcript file not found, parsing stdout');
    return result.trim();
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
export function textToSpeech(text: string): string {
  const tmpDir = fs.mkdtempSync('/tmp/nanoclaw-tts-');
  try {
    const chunks = chunkText(text);
    const wavFiles: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkDir = path.join(tmpDir, `chunk_${i}`);
      fs.mkdirSync(chunkDir, { recursive: true });

      execSync(
        `mlx_audio.tts.generate --model ${JSON.stringify(TTS_MODEL)} --text ${JSON.stringify(chunks[i])} --voice ${JSON.stringify(TTS_VOICE)} --instruct ${JSON.stringify(TTS_INSTRUCT)} --output_path ${JSON.stringify(chunkDir)}`,
        { stdio: 'pipe', timeout: 120000 },
      );

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
      // Create ffmpeg concat list
      const listFile = path.join(tmpDir, 'concat.txt');
      fs.writeFileSync(listFile, wavFiles.map((f) => `file '${f}'`).join('\n'));
      execSync(
        `ffmpeg -f concat -safe 0 -i ${JSON.stringify(listFile)} -y ${JSON.stringify(combinedWav)}`,
        { stdio: 'pipe', timeout: 30000 },
      );
    }

    // Convert to ogg/opus for Telegram voice messages
    const oggFile = path.join(tmpDir, 'voice.ogg');
    execSync(
      `ffmpeg -i ${JSON.stringify(combinedWav)} -c:a libopus -b:a 64k -y ${JSON.stringify(oggFile)}`,
      { stdio: 'pipe', timeout: 30000 },
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

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
 * Convert text to speech using mlx-audio with Qwen3-TTS.
 * Returns the path to the generated audio file.
 */
export function textToSpeech(text: string): string {
  const tmpDir = fs.mkdtempSync('/tmp/nanoclaw-tts-');
  try {
    execSync(
      `mlx_audio.tts.generate --model ${JSON.stringify(TTS_MODEL)} --text ${JSON.stringify(text)} --voice ${JSON.stringify(TTS_VOICE)} --instruct ${JSON.stringify(TTS_INSTRUCT)} --output_path ${JSON.stringify(tmpDir)}`,
      { stdio: 'pipe', timeout: 120000 },
    );

    // mlx_audio saves as audio_000.wav inside the output dir
    const wavFile = path.join(tmpDir, 'audio_000.wav');
    if (!fs.existsSync(wavFile)) {
      // Check for any wav file
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.wav'));
      if (files.length === 0) {
        throw new Error('No audio file generated');
      }
      return path.join(tmpDir, files[0]);
    }

    // Convert to ogg/opus for Telegram voice messages (smaller, required format)
    const oggFile = path.join(tmpDir, 'voice.ogg');
    execSync(
      `ffmpeg -i ${JSON.stringify(wavFile)} -c:a libopus -b:a 64k -y ${JSON.stringify(oggFile)}`,
      { stdio: 'pipe', timeout: 30000 },
    );

    return oggFile;
  } catch (err) {
    logger.error({ err }, 'TTS failed');
    // Clean up on failure
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

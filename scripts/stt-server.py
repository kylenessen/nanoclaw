"""
Persistent STT server for NanoClaw.
Loads the Parakeet-MLX model once and serves transcription requests over HTTP.

Usage:
    uv run scripts/stt-server.py [--port 7891]

Request:
    POST / with JSON body:
    {"audio_path": "/tmp/audio.wav"}

Response:
    {"status": "ok", "text": "transcribed text", "duration": 2.3}
    {"status": "error", "error": "..."}
"""
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "parakeet-mlx",
# ]
# ///
import argparse
import json
import subprocess
import sys
import tempfile
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

from parakeet_mlx import from_pretrained


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7891)
    parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3")
    args = parser.parse_args()

    print(f"Loading STT model: {args.model}", flush=True)
    t0 = time.time()
    model = from_pretrained(args.model)
    print(f"Model loaded in {time.time() - t0:.1f}s", flush=True)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *a):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                audio_path = body["audio_path"]

                # Convert to 16kHz mono wav if needed
                wav_path = audio_path
                tmp_wav = None
                if not audio_path.endswith(".wav"):
                    tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                    tmp_wav.close()
                    wav_path = tmp_wav.name
                    subprocess.run(
                        ["ffmpeg", "-i", audio_path, "-ar", "16000", "-ac", "1", "-y", wav_path],
                        capture_output=True, timeout=30,
                    )

                t0 = time.time()
                result = model.transcribe(wav_path)
                elapsed = time.time() - t0

                # Clean up temp file
                if tmp_wav:
                    Path(tmp_wav.name).unlink(missing_ok=True)

                text = result.text.strip()
                print(f"Transcribed {len(text)} chars in {elapsed:.1f}s", flush=True)

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "ok",
                    "text": text,
                    "duration": round(elapsed, 2),
                }).encode())

            except Exception as e:
                print(f"Error: {e}", file=sys.stderr, flush=True)
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "error",
                    "error": str(e),
                }).encode())

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"STT server listening on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

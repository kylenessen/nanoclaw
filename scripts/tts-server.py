"""
Persistent TTS server for NanoClaw.
Loads the Qwen3-TTS model once and serves requests over HTTP.

Usage:
    uv run scripts/tts-server.py [--port 7890]

Request:
    POST / with JSON body:
    {
        "text": "Hello world",
        "output_path": "/tmp/output.wav",
        "ref_audio": "audio/c3po_ref.wav",  (optional, for voice cloning)
        "ref_text": "transcript of ref audio"  (optional)
    }

Response:
    {"status": "ok", "path": "/tmp/output.wav", "duration": 5.4}
    {"status": "error", "error": "..."}
"""
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "mlx-audio @ git+https://github.com/Blaizzy/mlx-audio.git",
#     "soundfile",
#     "numpy",
# ]
# ///
import argparse
import json
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7890)
    parser.add_argument("--model", default="mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit")
    args = parser.parse_args()

    print(f"Loading TTS model: {args.model}", flush=True)
    t0 = time.time()
    model = load_model(args.model)
    print(f"Model loaded in {time.time() - t0:.1f}s", flush=True)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *a):
            # Suppress default request logging
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                text = body["text"]
                output_path = body["output_path"]
                ref_audio = body.get("ref_audio")
                ref_text = body.get("ref_text")

                t0 = time.time()

                if ref_audio and ref_text:
                    results = list(model.generate(
                        text=text,
                        ref_audio=ref_audio,
                        ref_text=ref_text,
                    ))
                else:
                    voice = body.get("voice", "Ryan")
                    instruct = body.get("instruct", "Calm, clear, conversational tone.")
                    results = list(model.generate_custom_voice(
                        text=text,
                        language="English",
                        speaker=voice,
                        instruct=instruct,
                    ))

                audio = np.array(results[0].audio)
                sr = results[0].sample_rate
                sf.write(output_path, audio, sr)

                duration = len(audio) / sr
                elapsed = time.time() - t0
                print(f"Generated {duration:.1f}s audio in {elapsed:.1f}s ({elapsed/duration:.2f}x realtime)", flush=True)

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "ok",
                    "path": output_path,
                    "duration": round(duration, 2),
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
    print(f"TTS server listening on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

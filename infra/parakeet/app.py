"""Parakeet TDT 0.6B v3 — Hardened OpenAI-compatible STT server.

Based on groxaxo/parakeet-tdt-0.6b-v3-fastapi-openai with security hardening:
- Removed double model load (GPU path was broken, kept clean CPU-only path)
- Removed webbrowser.open_new_tab() (no display server in Docker)
- Removed hardcoded developer IP from OpenAPI spec
- Lowered MAX_CONTENT_LENGTH from 2GB to 100MB
- Stripped unused imports (openai, requests, typing_extensions)
- Set 8 intra-op threads for i7-13700 P-cores
"""

host = "0.0.0.0"
port = 5092
threads = 8

CHUNK_MINUTE = 1.5
SILENCE_THRESHOLD = "-40dB"
SILENCE_MIN_DURATION = 0.5
SILENCE_SEARCH_WINDOW = 30.0
SILENCE_DETECT_TIMEOUT = 300
MIN_SPLIT_GAP = 5.0

import sys

sys.stdout = sys.stderr

import datetime
import json
import math
import os
import re
import subprocess
import time
import uuid

import psutil
from werkzeug.utils import secure_filename

import flask
from flask import Flask, request, jsonify, render_template, Response
from waitress import serve
from pathlib import Path

ROOT_DIR = Path(os.getcwd()).as_posix()
os.environ["HF_HOME"] = ROOT_DIR + "/models"
os.environ["HF_HUB_CACHE"] = ROOT_DIR + "/models"
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "true"

try:
    print("\nLoading Parakeet TDT 0.6B V3 ONNX model with INT8 quantization...")
    import onnx_asr
    import onnxruntime as ort

    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = 8
    sess_options.inter_op_num_threads = 1
    sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    asr_model = onnx_asr.load_model(
        "nemo-parakeet-tdt-0.6b-v3",
        quantization="int8",
        providers=["CPUExecutionProvider"],
        sess_options=sess_options,
    ).with_timestamps()
    print("Model loaded successfully with CPU optimization!")
except Exception as e:
    print(f"Model loading failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("=" * 50)


app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = "temp_uploads"
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024

progress_tracker = {}
PROGRESS_TTL = 60


def evict_stale_progress():
    now = time.time()
    stale = [k for k, v in progress_tracker.items()
             if v.get("status") == "complete" and now - v.get("completed_at", 0) > PROGRESS_TTL]
    for k in stale:
        del progress_tracker[k]


def get_audio_duration(file_path):
    command = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file_path,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        return float(result.stdout)
    except (subprocess.CalledProcessError, ValueError) as e:
        print(f"Could not get duration of file '{file_path}': {e}")
        return 0.0


def detect_silence_points(file_path, silence_thresh=SILENCE_THRESHOLD,
                          silence_duration=SILENCE_MIN_DURATION,
                          total_duration=None):
    if not os.path.exists(file_path):
        print(f"Error: Audio file '{file_path}' not found for silence detection")
        return []

    command = [
        "ffmpeg", "-hide_banner", "-nostats",
        "-i", file_path,
        "-af", f"silencedetect=noise={silence_thresh}:d={silence_duration}",
        "-f", "null", "-"
    ]

    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=SILENCE_DETECT_TIMEOUT)
        silence_points = []
        silence_start = None

        for line in result.stderr.splitlines():
            if 'silence_start:' in line:
                try:
                    silence_start = float(line.split('silence_start:')[1].split()[0])
                except (ValueError, IndexError):
                    silence_start = None
            elif 'silence_end:' in line and silence_start is not None:
                try:
                    silence_end = float(line.split('silence_end:')[1].split()[0])
                    silence_points.append((silence_start, silence_end))
                    silence_start = None
                except (ValueError, IndexError):
                    pass

        if silence_start is not None and total_duration is not None:
            silence_points.append((silence_start, total_duration))

        return silence_points
    except subprocess.TimeoutExpired:
        print(f"Timeout: Silence detection exceeded {SILENCE_DETECT_TIMEOUT}s timeout")
        return []
    except (subprocess.CalledProcessError, OSError) as e:
        print(f"Error running FFmpeg for silence detection: {e}")
        return []


def find_optimal_split_points(total_duration, target_chunk_duration,
                               silence_points, search_window=SILENCE_SEARCH_WINDOW,
                               min_gap=MIN_SPLIT_GAP):
    if not silence_points or total_duration <= target_chunk_duration:
        return []

    split_points = []
    prev = 0.0
    num_chunks = math.ceil(total_duration / target_chunk_duration)

    for i in range(1, num_chunks):
        target_time = i * target_chunk_duration
        search_start = max(0.0, target_time - search_window)
        search_end = min(total_duration, target_time + search_window)

        candidates = [
            (start, end) for (start, end) in silence_points
            if start <= search_end and end >= search_start
        ]

        chosen = None
        if candidates:
            candidates_sorted = sorted(
                candidates,
                key=lambda sr: abs(((sr[0] + sr[1]) / 2.0) - target_time)
            )
            for start, end in candidates_sorted:
                split_point = (start + end) / 2.0
                if split_point > prev + min_gap and split_point <= total_duration - min_gap:
                    chosen = split_point
                    break

        if chosen is None:
            chosen = max(prev + min_gap, min(target_time, total_duration - min_gap))
            if chosen > total_duration:
                chosen = None

        if chosen is not None:
            split_points.append(chosen)
            prev = chosen

    return split_points


def format_srt_time(seconds):
    delta = datetime.timedelta(seconds=seconds)
    s = str(delta)
    if "." in s:
        parts = s.split(".")
        integer_part = parts[0]
        fractional_part = parts[1][:3]
    else:
        integer_part = s
        fractional_part = "000"

    if len(integer_part.split(":")) == 2:
        integer_part = "0:" + integer_part

    return f"{integer_part},{fractional_part}"


def segments_to_srt(segments):
    srt_content = []
    for i, segment in enumerate(segments):
        start_time = format_srt_time(segment["start"])
        end_time = format_srt_time(segment["end"])
        text = segment["segment"].strip()
        if text:
            srt_content.append(str(i + 1))
            srt_content.append(f"{start_time} --> {end_time}")
            srt_content.append(text)
            srt_content.append("")
    return "\n".join(srt_content)


def segments_to_vtt(segments):
    vtt_content = ["WEBVTT", ""]
    for i, segment in enumerate(segments):
        start_time = format_srt_time(segment["start"]).replace(",", ".")
        end_time = format_srt_time(segment["end"]).replace(",", ".")
        text = segment["segment"].strip()
        if text:
            vtt_content.append(f"{start_time} --> {end_time}")
            vtt_content.append(text)
            vtt_content.append("")
    return "\n".join(vtt_content)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return jsonify(
        {"status": "healthy", "model": "parakeet-tdt-0.6b-v3", "quantization": "int8"}
    )


@app.route("/openapi.json")
def openapi_spec():
    return jsonify({
        "openapi": "3.0.0",
        "info": {
            "title": "Parakeet Transcription API",
            "description": "ONNX-optimized speech transcription API, OpenAI-compatible.",
            "version": "1.0.0"
        },
        "paths": {
            "/v1/audio/transcriptions": {
                "post": {
                    "summary": "Transcribe Audio",
                    "operationId": "transcribe_audio",
                    "requestBody": {
                        "content": {
                            "multipart/form-data": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "file": {
                                            "type": "string",
                                            "format": "binary",
                                            "description": "Audio file to transcribe."
                                        },
                                        "model": {
                                            "type": "string",
                                            "default": "parakeet",
                                            "description": "Model ID (ignored, always uses parakeet-tdt-0.6b-v3)."
                                        },
                                        "response_format": {
                                            "type": "string",
                                            "default": "json",
                                            "enum": ["json", "text", "srt", "verbose_json", "vtt"]
                                        }
                                    },
                                    "required": ["file"]
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Successful transcription",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "text": {"type": "string"}
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    })


@app.route("/progress/<job_id>")
def get_progress(job_id):
    if job_id in progress_tracker:
        return jsonify(progress_tracker[job_id])
    return jsonify({"status": "not_found"}), 404


@app.route("/status")
def get_status():
    for job_id, progress in progress_tracker.items():
        if progress.get("status") == "processing":
            return jsonify({"job_id": job_id, **progress})
    return jsonify({"status": "idle"})


@app.route("/metrics")
def get_metrics():
    cpu_percent = psutil.cpu_percent(interval=0.1)
    memory = psutil.virtual_memory()
    return jsonify({
        "cpu_percent": cpu_percent,
        "ram_percent": memory.percent,
        "ram_used_gb": round(memory.used / (1024**3), 2),
        "ram_total_gb": round(memory.total / (1024**3), 2)
    })


@app.route("/v1/audio/transcriptions", methods=["POST"])
def transcribe_audio():
    evict_stale_progress()
    if "file" not in request.files:
        return jsonify({"error": "No file part in the request"}), 400
    file = request.files["file"]
    if not file or not file.filename:
        return jsonify({"error": "No file selected"}), 400

    response_format = request.form.get("response_format", "json")
    if response_format not in {"json", "text", "srt", "verbose_json", "vtt"}:
        response_format = "json"

    original_filename = secure_filename(file.filename)
    allowed_ext = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".mp4", ".webm",
                   ".aac", ".wma", ".opus", ".mkv", ".avi", ".mov"}
    ext = os.path.splitext(original_filename)[1].lower()
    if ext not in allowed_ext:
        return jsonify({"error": f"Unsupported file type: {ext}"}), 415
    unique_id = str(uuid.uuid4())
    temp_original_path = os.path.join(
        app.config["UPLOAD_FOLDER"], f"{unique_id}_{original_filename}"
    )
    target_wav_path = os.path.join(app.config["UPLOAD_FOLDER"], f"{unique_id}.wav")
    temp_files_to_clean = []

    try:
        file.save(temp_original_path)
        temp_files_to_clean.append(temp_original_path)

        print(f"[{unique_id}] Converting '{original_filename}' to standard WAV format...")
        ffmpeg_command = [
            "ffmpeg", "-nostdin", "-y",
            "-i", temp_original_path,
            "-ac", "1", "-ar", "16000",
            target_wav_path,
        ]
        result = subprocess.run(ffmpeg_command, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"FFmpeg error: {result.stderr}")
            return jsonify({"error": "File conversion failed"}), 500
        temp_files_to_clean.append(target_wav_path)

        CHUNK_DURATION_SECONDS = CHUNK_MINUTE * 60
        total_duration = get_audio_duration(target_wav_path)
        if total_duration == 0:
            return jsonify({"error": "Cannot process audio with 0 duration"}), 400

        chunk_paths = []
        split_points = []

        if total_duration > CHUNK_DURATION_SECONDS:
            print(f"[{unique_id}] Detecting silence points for intelligent chunking...")
            silence_points = detect_silence_points(target_wav_path, total_duration=total_duration)

            if silence_points:
                print(f"[{unique_id}] Found {len(silence_points)} silence periods")
                split_points = find_optimal_split_points(
                    total_duration, CHUNK_DURATION_SECONDS, silence_points,
                    search_window=SILENCE_SEARCH_WINDOW
                )
                print(f"[{unique_id}] Optimal split points: {[f'{sp:.2f}s' for sp in split_points]}")
            else:
                print(f"[{unique_id}] No silence detected, using time-based chunking")

        if split_points:
            chunk_boundaries = [0.0] + split_points + [total_duration]
            num_chunks = len(chunk_boundaries) - 1
        else:
            num_chunks = math.ceil(total_duration / CHUNK_DURATION_SECONDS)
            chunk_boundaries = [min(i * CHUNK_DURATION_SECONDS, total_duration)
                                for i in range(num_chunks + 1)]

        progress_tracker[unique_id] = {
            "status": "processing",
            "current_chunk": 0,
            "total_chunks": num_chunks,
            "progress_percent": 0,
            "partial_text": ""
        }

        print(f"[{unique_id}] Total duration: {total_duration:.2f}s. "
              f"Splitting into {num_chunks} chunks.")

        if num_chunks > 1:
            for i in range(num_chunks):
                start_time = chunk_boundaries[i]
                duration = chunk_boundaries[i + 1] - start_time
                chunk_path = os.path.join(
                    app.config["UPLOAD_FOLDER"], f"{unique_id}_chunk_{i}.wav"
                )
                chunk_paths.append(chunk_path)
                temp_files_to_clean.append(chunk_path)

                chunk_command = [
                    "ffmpeg", "-nostdin", "-y",
                    "-ss", str(start_time),
                    "-t", str(duration),
                    "-i", target_wav_path,
                    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                    chunk_path,
                ]
                result = subprocess.run(chunk_command, capture_output=True, text=True)
                if result.returncode != 0:
                    print(f"Warning: Chunk extraction failed: {result.stderr}")
        else:
            chunk_paths.append(target_wav_path)

        all_segments = []
        all_words = []
        cumulative_time_offset = 0.0

        chunk_durations = []
        if num_chunks > 1:
            for i in range(num_chunks):
                chunk_durations.append(chunk_boundaries[i + 1] - chunk_boundaries[i])
        else:
            chunk_durations.append(total_duration)

        def clean_text(text):
            if not text:
                return ""
            text = text.replace("\u2581", " ").strip()
            text = re.sub(r"\s+", " ", text)
            text = text.replace(" '", "'")
            return text

        for i, chunk_path in enumerate(chunk_paths):
            progress_tracker[unique_id].update({
                "current_chunk": i + 1,
                "progress_percent": int((i + 1) / num_chunks * 100)
            })
            print(f"[{unique_id}] Transcribing chunk {i + 1}/{num_chunks}...")

            result = asr_model.recognize(chunk_path)

            if result and result.text:
                start_time = result.timestamps[0] if result.timestamps else 0
                end_time = (result.timestamps[-1]
                            if len(result.timestamps) > 1
                            else start_time + 0.1)

                cleaned_text = clean_text(result.text)

                segment = {
                    "start": start_time + cumulative_time_offset,
                    "end": end_time + cumulative_time_offset,
                    "segment": cleaned_text,
                }
                all_segments.append(segment)

                progress_tracker[unique_id]["partial_text"] += cleaned_text + " "

                for j, (token, timestamp) in enumerate(
                    zip(result.tokens, result.timestamps)
                ):
                    word_end = (result.timestamps[j + 1]
                                if j < len(result.timestamps) - 1
                                else end_time)
                    clean_token = token.replace("\u2581", " ").strip()
                    all_words.append({
                        "start": timestamp + cumulative_time_offset,
                        "end": word_end + cumulative_time_offset,
                        "word": clean_token,
                    })

            cumulative_time_offset += chunk_durations[i]

        print(f"[{unique_id}] All chunks transcribed, merging results.")

        progress_tracker[unique_id]["status"] = "complete"
        progress_tracker[unique_id]["progress_percent"] = 100
        progress_tracker[unique_id]["completed_at"] = time.time()

        full_text = " ".join([seg["segment"] for seg in all_segments])

        if response_format == "srt":
            return Response(segments_to_srt(all_segments), mimetype="text/plain")
        elif response_format == "vtt":
            return Response(segments_to_vtt(all_segments), mimetype="text/plain")
        elif response_format == "text":
            return Response(full_text, mimetype="text/plain")
        elif response_format == "verbose_json":
            return jsonify({
                "task": "transcribe",
                "language": "english",
                "duration": total_duration,
                "text": full_text,
                "segments": [
                    {
                        "id": idx,
                        "seek": 0,
                        "start": seg["start"],
                        "end": seg["end"],
                        "text": seg["segment"],
                        "tokens": [],
                        "temperature": 0.0,
                        "avg_logprob": 0.0,
                        "compression_ratio": 0.0,
                        "no_speech_prob": 0.0,
                    }
                    for idx, seg in enumerate(all_segments)
                ],
            })
        else:
            response = jsonify({"text": full_text})
            response.headers['X-Job-ID'] = unique_id
            return response

    except Exception as e:
        print(f"Error during processing: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": "Internal server error"}), 500
    finally:
        print(f"[{unique_id}] Cleaning up temporary files...")
        for f_path in temp_files_to_clean:
            if os.path.exists(f_path):
                os.remove(f_path)


if __name__ == "__main__":
    print(f"Starting server on {host}:{port} with {threads} threads...")
    print(f"API: POST http://{host}:{port}/v1/audio/transcriptions")
    serve(app, host=host, port=port, threads=threads)

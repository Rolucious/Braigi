FROM python:3.10-slim

LABEL maintainer="homelab"
LABEL description="Parakeet TDT 0.6B v3 — ONNX INT8 STT server (CPU)"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

RUN useradd --create-home --shell /bin/bash parakeet
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY templates/ templates/

RUN mkdir -p temp_uploads models && \
    chown -R parakeet:parakeet /app

USER parakeet

ENV HF_HOME=/app/models
ENV HF_HUB_CACHE=/app/models
ENV HF_HUB_DISABLE_SYMLINKS_WARNING=true
ENV HF_HUB_DISABLE_TELEMETRY=1
ENV PYTHONUNBUFFERED=1

EXPOSE 5092

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5092/health')" || exit 1

CMD ["python", "app.py"]

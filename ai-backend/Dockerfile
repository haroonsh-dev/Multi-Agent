# syntax=docker/dockerfile:1
# Pinned to bookworm: python:3.12-slim now tracks Debian 13 (trixie), which
# dropped libgl1-mesa-glx and renamed the glib runtime — keep a stable base.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    USE_GPU=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/root/.cache/huggingface

WORKDIR /app

# libgl1 + libglib2.0-0 are what opencv-python-headless actually needs at runtime.
# BuildKit cache mounts keep apt/pip/HF downloads on the host between build
# attempts, so a retry on this box's thin uplink resumes instead of restarting.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update -o Acquire::Retries=5 && apt-get install -y --no-install-recommends \
    build-essential \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libgl1 \
    libglib2.0-0

# Torch first, from the CPU-only index (~190 MB vs the ~530 MB default wheel).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --retries 10 --timeout 120 --index-url https://download.pytorch.org/whl/cpu torch

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --retries 10 --timeout 120 -r requirements.txt

COPY . .

# The service resolves local models relative to app/services/embedding_service.py,
# so the model must live under /app/app/data/local_models. Download after COPY:
# COPY includes the config files tracked in Git, while the weight files are
# intentionally gitignored and must be baked into the image here.
ARG EMBEDDING_MODEL=BAAI/bge-large-en-v1.5
ENV EMBEDDING_MODEL=${EMBEDDING_MODEL}
RUN --mount=type=cache,target=/root/.cache/huggingface \
    python -c "import os; from sentence_transformers import SentenceTransformer; n=os.environ['EMBEDDING_MODEL']; d=os.path.join('/app','app','data','local_models', n.replace('/','_').replace('-','_')); os.makedirs(d, exist_ok=True); SentenceTransformer(n, device='cpu').save(d); print('baked', d)"

RUN mkdir -p /app/uploads /app/processed /shared-storage

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

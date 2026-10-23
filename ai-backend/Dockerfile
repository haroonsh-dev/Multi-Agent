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

# Bake the production models into the image so container start needs no network
# and no multi-GB first-boot download over the thin uplink:
#   - BAAI/bge-large-en-v1.5  (1024-dim embeddings — matches the Pinecone index)
#   - cross-encoder/ms-marco-MiniLM-L-6-v2  (RAG reranker)
# The embedding model is saved to the exact path embedding_service.py looks for
# first (data/local_models/<safe_name>), so startup skips the download entirely.
ARG EMBEDDING_MODEL=BAAI/bge-large-en-v1.5
ENV EMBEDDING_MODEL=${EMBEDDING_MODEL}
RUN --mount=type=cache,target=/root/.cache/huggingface \
    python -c "import os; from sentence_transformers import SentenceTransformer, CrossEncoder; n=os.environ['EMBEDDING_MODEL']; d=os.path.join('/app','data','local_models', n.replace('/','_').replace('-','_')); os.makedirs(d, exist_ok=True); SentenceTransformer(n, device='cpu').save(d); CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2', device='cpu'); print('baked', d)"

COPY . .

RUN mkdir -p /app/uploads /app/processed /shared-storage

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

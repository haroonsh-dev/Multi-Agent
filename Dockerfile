FROM node:20-alpine AS frontend-builder

WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    USE_GPU=false

WORKDIR /app

RUN apt-get update -o Acquire::Retries=3 && apt-get install -y --no-install-recommends \
    build-essential \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

COPY backend/ ./backend/
RUN mkdir -p /app/backend/uploads /app/backend/processed

COPY --from=frontend-builder /build/out/ ./frontend/out/
COPY --from=frontend-builder /build/.next/standalone/ ./frontend/
COPY --from=frontend-builder /build/public/ ./frontend/public/
COPY --from=frontend-builder /build/.next/static/ ./frontend/.next/static/

COPY startup.sh /startup.sh
RUN chmod +x /startup.sh

EXPOSE 7860

CMD ["/startup.sh"]

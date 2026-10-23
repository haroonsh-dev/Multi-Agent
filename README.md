# DocuGemma AI — Open-Weight Document Intelligence Platform

> **Hacktoberfest Open-Source AI Prize Challenge Submission**  
> Built with Google Gemma (`gemma-2-2b-it` / `gemma2:2b`), RAG, PaddleOCR, and Multi-Agent Orchestration.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Model: Google Gemma](https://img.shields.io/badge/Model-Google%20Gemma%202B-blue.svg)](https://ai.google.dev/gemma)
[![Hacktoberfest: 2026](https://img.shields.io/badge/Hacktoberfest-2026-orange.svg)](https://hacktoberfest.com/)
[![Next.js](https://img.shields.io/badge/Frontend-Next.js%2016-black.svg)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688.svg)](https://fastapi.tiangolo.com/)

---

## 🌟 Overview & Problem Statement

Enterprises and individuals process thousands of unstructured documents daily—invoices, legal contracts, purchase orders, resumes, compliance certificates, and technical engineering sheets. Closed proprietary APIs pose privacy risks, high inference costs, and vendor lock-in.

**DocuGemma AI** solves this problem by using **open-weight AI (Google Gemma 2B)** combined with retrieval-augmented generation (RAG), neural embeddings, and high-accuracy OCR to provide an end-to-end, privacy-respecting document intelligence and chat system.

---

## 🧠 Open-Source & Open-Weight AI Architecture

DocuGemma AI is built around open-weight models and open-source tooling:

1. **Core Language Model**:
   - **Google Gemma 2 2B (`gemma-2-2b-it` / `gemma2:2b`)**: Primary reasoning engine for document extraction, classification, structured entity parsing, and RAG Q&A.
   - Accessible via **Google Gemini / Google AI Studio API**, **Groq Gemma (`gemma2-9b-it`)**, or **local self-hosted Ollama (`gemma2:2b`)**.
2. **Embeddings & Semantic Search**:
   - Open-weight dense embeddings (`BAAI/bge-large-en-v1.5` / `all-MiniLM-L6-v2`) via Hugging Face Transformers.
   - Vector search powered by local vector indexes with pgvector / Pinecone support.
3. **Cross-Encoder Reranker**:
   - `cross-encoder/ms-marco-MiniLM-L-6-v2` for high-precision citation retrieval.
4. **Computer Vision & OCR**:
   - PaddleOCR open-source engine for multi-lingual scanned text, table, and bounding box detection.

---

## 🏗️ System Architecture

DocuGemma AI is composed of three decoupled, scalable layers:

```
┌─────────────────────────────────────────────────────────────┐
│                    DocuGemma AI Frontend                    │
│     (Next.js 16 • React 19 • Tailwind CSS • Lucide UI)     │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / REST
┌──────────────────────────────▼──────────────────────────────┐
│                    API Gateway Service                      │
│        (Node.js • Express • MongoDB • JWT Auth • RBAC)      │
└──────────────────────────────┬──────────────────────────────┘
                               │ Internal Secure REST
┌──────────────────────────────▼──────────────────────────────┐
│                     AI Backend Engine                       │
│    (Python 3.11+ • FastAPI • PyTorch • HuggingFace • RAG)   │
│                                                             │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────┐  │
│  │ Google Gemma 2B │  │  BAAI Embedding  │  │ PaddleOCR  │  │
│  │   LLM Engine    │  │     Pipeline     │  │  Vision    │  │
│  └─────────────────┘  └──────────────────┘  └────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

| Component | Tech Stack | Role |
| :--- | :--- | :--- |
| **[`frontend/`](./frontend)** | Next.js 16, React 19, Tailwind CSS | Modern responsive dashboard, document viewer, chat workspace, and analytics charts. |
| **[`api-gateway/`](./api-gateway)** | Node.js, Express, MongoDB, JWT | Organization management, access control, audit logging, MCP server integration. |
| **[`ai-backend/`](./ai-backend)** | Python, FastAPI, PyTorch, Gemma | OCR ingestion, vector embedding, similarity matching, RAG generation with Gemma. |

---

## 🚀 Quick Start Guide

### Prerequisites
- Node.js 20+ & npm
- Python 3.10+
- (Optional) Docker & Docker Compose

### 1. Clone the Repository
```bash
git clone https://github.com/YOUR_USERNAME/docugemma-ai.git
cd docugemma-ai
```

### 2. Configure Environment Variables
In `ai-backend/.env` (or via the Admin UI Settings tab):
```bash
# Google Gemini API key (running Gemma 2B)
GEMINI_API_KEY=your_gemini_api_key_here
GEMMA_MODEL=gemma-2-2b-it

# Or use Groq Gemma / Local Ollama:
# GROQ_API_KEY=gsk_your_groq_key
# CUSTOM_BASE_URL=http://localhost:11434/v1
```

### 3. Run Locally (Development)

**Terminal 1 — AI Backend:**
```bash
cd ai-backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python run.py
```

**Terminal 2 — API Gateway:**
```bash
cd api-gateway
npm install
npm run dev
```

**Terminal 3 — Frontend:**
```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3124](http://localhost:3124) in your browser.

---

### 4. Run with Docker Compose
```bash
docker compose up --build
```

---

### 5. Deploy to Render (One-Click Blueprint)

DocuGemma AI includes a preconfigured `render.yaml` Blueprint that deploys all three services (`frontend`, `api-gateway`, and `ai-backend`) with unified internal networking:

1. Fork or push this repository to your GitHub account (`https://github.com/haroonsh-dev/Multi-Agent`).
2. Log in to [Render](https://dashboard.render.com).
3. Click **New +** > **Blueprint**.
4. Select the `Multi-Agent` repository.
5. Render will detect `render.yaml` and configure the 3 services:
   - `docugemma-ai-backend` (Docker Web Service)
   - `docugemma-api-gateway` (Node.js Web Service)
   - `docugemma-frontend` (Next.js Web Service)
6. Provide your environment values when prompted:
   - `MONGO_URI`: Your MongoDB connection string (e.g. MongoDB Atlas free cluster).
   - `GEMINI_API_KEY`: Your Google AI Gemini API key (for Google Gemma 2B).
7. Click **Apply** — Render automatically builds, links, and serves all components live!

---

## 🌟 Key Features

- **Document Understanding**: Upload PDFs, DOCX, scans, and images; automatically classify documents into invoices, contracts, IDs, and HR records.
- **RAG Chat with Citations**: Ask cross-document questions and receive concise answers with verifiable source chunk citations.
- **Agent Orchestrator**: Specialized agents for Finance (AP/AR line items), HR (resumes & letters), Compliance (ISO standards), and Procurement.
- **Model Agnostic & Fallback Ready**: Seamlessly runs with Google Gemma, Ollama, Groq, or self-hosted OpenAI-compatible endpoints.
- **MCP (Model Context Protocol) Ready**: Standardized stdio and SSE MCP endpoints enabling external agent integrations (Claude Desktop, Cursor, Antigravity).

---

## 📄 License

This project is licensed under the [MIT License](./LICENSE).

---

## 🏆 Hacktoberfest Open-Source AI Challenge Compliance Checklist

- [x] **Open-Weight / Open-Source AI**: Core reasoning powered by Google Gemma 2 2B (`gemma-2-2b-it` / `gemma2:2b`).
- [x] **Public Repository**: Clean git history, MIT licensed.
- [x] **Solves Real Problem**: Enterprise document processing without closed API lock-in.
- [x] **Verifiable Code & Tools**: Clear architecture, reproducible setup instructions, and standard APIs.
- [x] **Full Demo & Documentation**: Comprehensive README with diagrams, API mappings, and setup steps.

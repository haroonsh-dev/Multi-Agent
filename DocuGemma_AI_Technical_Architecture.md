# Visibility Docs AI
## Technical Architecture Document

**Version:** 1.0  
**Status:** Draft  
**Product:** Visibility Docs AI  
**Company:** Visibility Bots  
**Tagline:** Smart Solutions using AI & IoT  

---

# 1. Purpose

This document defines the technical architecture for **Visibility Docs AI**, an Enterprise Document Intelligence Platform.

The platform will ingest enterprise documents, extract text and structure, understand layouts, classify document types, extract key information, enable semantic search, support AI chat, and power document-based AI agents.

The architecture is designed for:

- SaaS deployment
- On-premises deployment
- Multi-tenant enterprise use
- AI document processing at scale
- Future integration with VBOS and Visibility Live

---

# 2. Architecture Goals

## Core Goals

- Process enterprise documents automatically.
- Convert documents into structured data.
- Support OCR, layout analysis, table extraction, forms, and key-value extraction.
- Enable semantic search and natural language Q&A.
- Support workflow automation and AI agents.
- Provide API-first architecture.
- Support cloud and on-premises deployments.

## Design Principles

- Modular services
- API-first design
- Secure multi-tenancy
- Background job processing
- Human-in-the-loop review
- Model-agnostic AI layer
- Scalable storage and processing
- Audit-ready architecture

---

# 3. High-Level System Architecture

```text
Users
  |
  v
Web App / Admin Portal
  |
  v
API Gateway / Backend API
  |
  +-----------------------------+
  |                             |
  v                             v
Auth & RBAC              Document Upload Service
                                |
                                v
                         Object Storage
                                |
                                v
                         Processing Queue
                                |
                                v
                    Document Processing Workers
                                |
          +---------------------+---------------------+
          |                     |                     |
          v                     v                     v
        OCR              Layout Analysis        Table/Form Parsing
          |                     |                     |
          +---------------------+---------------------+
                                |
                                v
                    AI Understanding Layer
                                |
          +---------------------+---------------------+
          |                     |                     |
          v                     v                     v
  PostgreSQL Metadata     Vector Database       Knowledge Graph
          |                     |                     |
          +---------------------+---------------------+
                                |
                                v
                         AI Agent Layer
                                |
                                v
              Search / Chat / Validation / Workflows
```

---

# 4. Recommended Technology Stack

## Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- Zustand or Redux Toolkit for state management

## Backend

- Python
- FastAPI
- Pydantic
- SQLAlchemy or SQLModel
- Celery or Dramatiq for background jobs
- Redis for queue broker and cache

## Database

- PostgreSQL
- Supabase for managed PostgreSQL option
- pgvector for embeddings
- Row Level Security for multi-tenancy

## Object Storage

- S3-compatible storage
- MinIO for on-premises deployment
- AWS S3, Cloudflare R2, or Supabase Storage for cloud deployment

## AI Processing

- Florence-2 or equivalent vision-language model
- PaddleOCR or Tesseract as OCR fallback
- Layout-aware document model
- LLM for reasoning and summarization
- Embedding model for semantic search
- Optional local models for private deployments

## Search

- PostgreSQL full-text search
- pgvector semantic search
- Optional OpenSearch for enterprise-scale search

## Workflow Automation

- n8n for integrations and low-code workflows
- Internal workflow engine for approval flows
- Webhooks for external system integration

## Deployment

- Docker
- Docker Compose for development
- Kubernetes for enterprise deployment
- Nginx or Traefik as reverse proxy
- GitHub Actions for CI/CD

---

# 5. Core System Components

## 5.1 Web Application

The web application provides the main user interface.

### Main Features

- Login and organization selection
- Document upload
- Document library
- Document viewer
- AI chat panel
- Search interface
- Review and correction screen
- Workflow approvals
- Admin settings
- User and role management
- API key management

### Recommended Routes

```text
/login
/dashboard
/documents
/documents/:id
/documents/:id/review
/search
/chat
/workflows
/agents
/settings
/admin/users
/admin/roles
/admin/api-keys
```

---

## 5.2 Backend API

The backend API manages application logic, user requests, metadata, permissions, and AI orchestration.

### Main Responsibilities

- Authentication and authorization
- Organization and tenant management
- Document metadata management
- Upload session creation
- Search API
- Chat API
- Workflow API
- AI job orchestration
- Audit logging
- Integration endpoints

### Suggested API Structure

```text
/api/v1/auth
/api/v1/organizations
/api/v1/users
/api/v1/roles
/api/v1/documents
/api/v1/document-types
/api/v1/extractions
/api/v1/search
/api/v1/chat
/api/v1/workflows
/api/v1/agents
/api/v1/integrations
/api/v1/audit-logs
/api/v1/api-keys
```

---

# 6. Document Processing Pipeline

## 6.1 Pipeline Overview

```text
Upload Document
  |
  v
Store Original File
  |
  v
Create Processing Job
  |
  v
Convert Pages to Images
  |
  v
Preprocess Images
  |
  v
OCR
  |
  v
Layout Detection
  |
  v
Table/Form Extraction
  |
  v
Document Classification
  |
  v
Key Information Extraction
  |
  v
Generate Embeddings
  |
  v
Store Results
  |
  v
Mark Document Ready
```

---

## 6.2 Processing Stages

### Stage 1: File Ingestion

Supported file types:

- PDF
- Scanned PDF
- JPG
- PNG
- TIFF
- DOCX
- XLSX
- PPTX

Actions:

- Validate file type
- Check file size
- Store original file
- Generate document ID
- Create metadata record
- Create processing job

---

### Stage 2: Document Conversion

PDFs and office files are converted into page images.

Actions:

- Split document into pages
- Convert each page to image
- Store page image
- Create page records
- Generate thumbnails

---

### Stage 3: Image Preprocessing

Actions:

- Deskew
- Denoise
- Contrast enhancement
- Orientation detection
- Page boundary detection
- Low-quality scan detection

---

### Stage 4: OCR

Outputs:

- Extracted text
- Word-level bounding boxes
- Line-level bounding boxes
- Confidence scores
- Page-level text

OCR engines:

- Primary OCR model
- PaddleOCR fallback
- Tesseract fallback for simple cases

---

### Stage 5: Layout Analysis

Detect:

- Headings
- Paragraphs
- Tables
- Forms
- Images
- Signatures
- Stamps
- Headers
- Footers
- Page numbers
- Checkboxes

Output:

- Layout blocks
- Block type
- Coordinates
- Confidence score
- Reading order

---

### Stage 6: Table Extraction

Extract:

- Table boundaries
- Rows
- Columns
- Cell text
- Merged cells
- Header rows
- Numeric columns
- Totals

Output formats:

- JSON
- CSV
- Markdown table
- Excel export

---

### Stage 7: Document Classification

Classify document into categories:

- Invoice
- Purchase Order
- Contract
- Quotation
- HR Document
- Audit Report
- Certificate
- Financial Report
- Engineering Drawing
- SOP
- Unknown

Classification methods:

- Vision-language model
- Text classifier
- Metadata rules
- User correction feedback

---

### Stage 8: Key Information Extraction

Extract structured fields based on document type.

Example invoice fields:

```json
{
  "vendor_name": "ABC Supplies",
  "invoice_number": "INV-1001",
  "invoice_date": "2026-06-15",
  "due_date": "2026-07-15",
  "currency": "PKR",
  "subtotal": 100000,
  "tax": 18000,
  "total": 118000
}
```

Example contract fields:

```json
{
  "party_a": "Company A",
  "party_b": "Company B",
  "effective_date": "2026-01-01",
  "expiry_date": "2026-12-31",
  "renewal_terms": "Auto-renewal",
  "payment_terms": "30 days",
  "termination_notice": "60 days"
}
```

---

### Stage 9: Semantic Chunking

Documents are split into meaningful chunks.

Chunk types:

- Paragraph
- Clause
- Table
- Page section
- Form section
- Heading group
- Figure caption

Each chunk stores:

- Text
- Page number
- Bounding box
- Section heading
- Document ID
- Tenant ID
- Embedding vector

---

### Stage 10: Embedding Generation

Embeddings are generated for:

- Document summary
- Page text
- Semantic chunks
- Extracted entities
- Tables
- Captions

Stored in:

- pgvector
- Optional vector database if scaling requires it

---

### Stage 11: Human Review

Users can review and correct extracted data.

Features:

- Side-by-side document viewer
- Highlight extracted fields
- Edit extracted values
- Approve/reject extraction
- Confidence-based review queue
- Store corrections for model improvement

---

# 7. AI Architecture

## 7.1 AI Layer Responsibilities

The AI layer handles:

- OCR assistance
- Layout understanding
- Document classification
- Field extraction
- Summarization
- Semantic search
- Visual question answering
- Cross-document reasoning
- Agent actions

---

## 7.2 Model Strategy

Use a model-agnostic architecture.

```text
AI Gateway
  |
  +-- Cloud LLM Provider
  +-- Local LLM
  +-- Vision-Language Model
  +-- OCR Engine
  +-- Embedding Model
```

This allows the system to switch between:

- OpenAI
- Anthropic
- Google Gemini
- Azure OpenAI
- Local open-source models
- Florence-2 or equivalent document vision model

---

## 7.3 AI Gateway

The AI Gateway standardizes calls to different models.

Responsibilities:

- Model routing
- Prompt templates
- Retry logic
- Token tracking
- Cost tracking
- Logging
- Redaction of sensitive data
- Provider fallback

Suggested service:

```text
ai-gateway-service
```

---

# 8. RAG Architecture

## 8.1 RAG Flow

```text
User Question
  |
  v
Query Rewriting
  |
  v
Permission Filter
  |
  v
Hybrid Retrieval
  |
  +-- Keyword Search
  +-- Vector Search
  +-- Metadata Search
  |
  v
Reranking
  |
  v
Context Builder
  |
  v
LLM Answer
  |
  v
Citations + Source Pages
```

---

## 8.2 RAG Requirements

- Tenant-aware retrieval
- Role-aware retrieval
- Page-level citations
- Bounding-box source references
- Table-aware retrieval
- Document-type filters
- Date filters
- Confidence indicators
- No answer when evidence is insufficient

---

# 9. Knowledge Graph Architecture

## 9.1 Purpose

The knowledge graph connects documents, entities, and business relationships.

Examples:

```text
Vendor -> Invoice -> Purchase Order -> Delivery Note -> Payment
Employee -> Contract -> Certificate -> Training Record
Machine -> Calibration Certificate -> Maintenance Report -> Audit Evidence
```

---

## 9.2 Entity Types

- Organization
- Vendor
- Customer
- Employee
- Department
- Machine
- Asset
- Product
- Project
- Contract
- Invoice
- Purchase Order
- Certificate
- Audit
- Policy
- SOP

---

## 9.3 Relationship Types

- issued_by
- belongs_to
- references
- approves
- expires_on
- validates
- conflicts_with
- replaces
- linked_to
- generated_from

---

# 10. Database Architecture

## 10.1 Core Tables

```text
organizations
users
roles
permissions
user_roles
documents
document_pages
document_files
document_types
document_extractions
document_fields
document_chunks
document_embeddings
document_entities
document_relationships
processing_jobs
workflows
workflow_steps
workflow_runs
agent_runs
audit_logs
api_keys
integrations
```

---

## 10.2 Suggested Table Definitions

### organizations

```sql
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'starter',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### documents

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  document_type TEXT,
  status TEXT DEFAULT 'uploaded',
  original_file_url TEXT,
  file_hash TEXT,
  page_count INTEGER,
  language TEXT,
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### document_pages

```sql
CREATE TABLE document_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES documents(id),
  page_number INTEGER NOT NULL,
  image_url TEXT,
  thumbnail_url TEXT,
  raw_text TEXT,
  ocr_confidence NUMERIC,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### document_chunks

```sql
CREATE TABLE document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES documents(id),
  page_id UUID REFERENCES document_pages(id),
  chunk_type TEXT,
  heading TEXT,
  content TEXT NOT NULL,
  bbox JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### document_embeddings

```sql
CREATE TABLE document_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES documents(id),
  chunk_id UUID REFERENCES document_chunks(id),
  embedding VECTOR(1536),
  model_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### document_extractions

```sql
CREATE TABLE document_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES documents(id),
  extraction_type TEXT NOT NULL,
  extracted_data JSONB NOT NULL,
  confidence NUMERIC,
  reviewed BOOLEAN DEFAULT false,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### processing_jobs

```sql
CREATE TABLE processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  document_id UUID REFERENCES documents(id),
  job_type TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  progress INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

# 11. Multi-Tenant Design

## 11.1 Tenant Isolation

Every tenant-owned table must include:

```text
organization_id
```

All queries must filter by organization ID.

Recommended controls:

- Supabase Row Level Security
- Backend-level tenant enforcement
- API key scoped to organization
- Storage path isolation

Example storage path:

```text
/orgs/{organization_id}/documents/{document_id}/original.pdf
/orgs/{organization_id}/documents/{document_id}/pages/page-001.png
```

---

# 12. Security Architecture

## 12.1 Authentication

Supported methods:

- Email/password
- Magic link
- Google Workspace login
- Microsoft login
- SSO/SAML for enterprise clients

## 12.2 Authorization

RBAC roles:

- Owner
- Admin
- Manager
- Reviewer
- Viewer
- API User

Permission examples:

- document.upload
- document.view
- document.delete
- document.review
- document.export
- workflow.approve
- admin.manage_users
- api.use

## 12.3 Security Requirements

- Encryption at rest
- Encryption in transit
- Signed URLs for file access
- API key rotation
- Audit logging
- Tenant isolation
- Data retention policies
- Secure secrets management
- Optional on-premises deployment for sensitive clients

---

# 13. Workflow Engine

## 13.1 Workflow Examples

### Invoice Approval

```text
Invoice Uploaded
  |
  v
Extract Invoice Data
  |
  v
Validate Against PO
  |
  v
Check Amount Threshold
  |
  v
Route to Manager
  |
  v
Approval / Rejection
  |
  v
Send to Accounting System
```

### Certificate Expiry Tracking

```text
Certificate Uploaded
  |
  v
Extract Expiry Date
  |
  v
Create Reminder
  |
  v
Notify Responsible Department
```

---

# 14. AI Agent Architecture

## 14.1 Agent Types

### Finance Agent

- Invoice search
- Duplicate invoice detection
- Payment term extraction
- Expense summary

### Procurement Agent

- Quotation comparison
- PO and invoice validation
- Supplier document search

### Compliance Agent

- Audit evidence collection
- Missing document detection
- Expired certificate tracking

### HR Agent

- Employee document completeness
- Certificate expiry tracking
- Contract search

### Legal Agent

- Contract summary
- Clause extraction
- Risk detection
- Version comparison

---

## 14.2 Agent Flow

```text
User Request
  |
  v
Intent Detection
  |
  v
Permission Check
  |
  v
Tool Selection
  |
  +-- Search Tool
  +-- Document Read Tool
  +-- Extraction Tool
  +-- Workflow Tool
  +-- Integration Tool
  |
  v
Reasoning
  |
  v
Response with Sources
  |
  v
Optional Action
```

---

# 15. Integrations

## 15.1 Initial Integrations

- Email inbox import
- Google Drive
- Microsoft SharePoint
- OneDrive
- S3 bucket
- ERP API
- Webhooks
- n8n workflows

## 15.2 Future Integrations

- SAP
- Oracle
- Odoo
- QuickBooks
- Zoho Books
- Microsoft Dynamics
- Slack
- WhatsApp Business API

---

# 16. Deployment Architecture

## 16.1 Development Deployment

```text
Docker Compose
  |
  +-- Next.js App
  +-- FastAPI Backend
  +-- PostgreSQL
  +-- Redis
  +-- MinIO
  +-- Worker Service
```

## 16.2 SaaS Deployment

```text
Vercel / Container Platform
  |
  +-- Frontend
  +-- Backend API
  +-- Worker Pool
  +-- Managed PostgreSQL
  +-- Managed Redis
  +-- S3 Storage
  +-- AI Provider APIs
```

## 16.3 On-Premises Deployment

```text
Client Server / Private Cloud
  |
  +-- Docker / Kubernetes
  +-- Frontend
  +-- Backend API
  +-- PostgreSQL
  +-- Redis
  +-- MinIO
  +-- AI Workers
  +-- Optional Local LLM
```

---

# 17. Scalability Design

## 17.1 Scaling Units

Scale independently:

- Frontend
- Backend API
- Document workers
- AI workers
- OCR workers
- Embedding workers
- Search service
- Storage

## 17.2 Queue Strategy

Use separate queues:

```text
file_conversion_queue
ocr_queue
layout_queue
extraction_queue
embedding_queue
agent_queue
workflow_queue
```

This prevents heavy OCR jobs from blocking lightweight tasks.

---

# 18. Observability

## 18.1 Logs

Track:

- API requests
- AI calls
- Processing jobs
- Errors
- User actions
- Security events

## 18.2 Metrics

Track:

- Documents processed per day
- Average processing time
- OCR confidence
- Extraction accuracy
- AI cost per document
- Queue length
- Failed jobs
- User activity

## 18.3 Recommended Tools

- Prometheus
- Grafana
- Sentry
- OpenTelemetry
- PostHog

---

# 19. DevOps and CI/CD

## 19.1 Repository Structure

```text
visibility-docs-ai/
  apps/
    web/
    api/
  workers/
    document-worker/
    ai-worker/
  packages/
    shared/
    ui/
    sdk/
  infra/
    docker/
    k8s/
    terraform/
  docs/
```

## 19.2 CI/CD Pipeline

Steps:

1. Lint
2. Type check
3. Unit tests
4. API tests
5. Build Docker images
6. Security scan
7. Deploy staging
8. Run smoke tests
9. Deploy production

---

# 20. Development Milestones

## Milestone 1: Foundation

- Auth
- Organizations
- User roles
- Document upload
- Object storage
- Basic dashboard

## Milestone 2: Processing Pipeline

- PDF conversion
- OCR
- Page images
- Raw text extraction
- Processing job tracking

## Milestone 3: Document Intelligence

- Layout analysis
- Classification
- Field extraction
- Table extraction
- Human review screen

## Milestone 4: Search and Chat

- Full-text search
- Embeddings
- Semantic search
- Document Q&A with citations

## Milestone 5: Workflow and Agents

- Approval workflows
- Finance Agent
- Compliance Agent
- n8n integration
- API keys and webhooks

---

# 21. MVP Scope

## Included in MVP

- Multi-tenant login
- Document upload
- PDF/image processing
- OCR
- Document classification
- Metadata extraction for invoices, contracts, and certificates
- Search
- AI chat over uploaded documents
- Human review screen
- Basic admin dashboard

## Not Included in MVP

- Full ERP integration
- Advanced knowledge graph
- Full workflow builder
- Complex legal reasoning
- Offline mobile app
- Custom model training
- Multi-region deployment

---

# 22. Risks and Mitigations

## Risk: OCR accuracy varies by scan quality

Mitigation:

- Image preprocessing
- Confidence scoring
- Human review
- Multiple OCR fallback engines

## Risk: AI hallucination in document Q&A

Mitigation:

- Source citations
- Retrieval-only answers
- Confidence thresholds
- No-answer mode

## Risk: Enterprise data privacy concerns

Mitigation:

- On-premises deployment
- Local model option
- Encryption
- Audit logs
- Role-based access

## Risk: High AI processing cost

Mitigation:

- Model routing
- Cache results
- Batch processing
- Use smaller models for simple tasks

---

# 23. Future Architecture Extensions

- Mobile capture app
- Offline document scanning
- Advanced knowledge graph
- Industry-specific document packs
- Custom extraction template builder
- Agent marketplace
- Voice interface
- Auto-generated audit packs
- Contract risk scoring
- Export documentation intelligence
- Integration with Visibility Live and VBOS

---

# 24. Strategic Fit

Visibility Docs AI becomes the document intelligence layer of the Visibility Bots ecosystem.

```text
Visibility Live
  Real-time operational intelligence

Visibility Vision
  Computer vision intelligence

Visibility Docs AI
  Document intelligence

VBOS
  AI agents and business automation
```

Together, these systems allow businesses to automate decisions using:

- Live machine and sensor data
- Camera and visual evidence
- Enterprise documents
- AI agents and workflows

This creates a strong foundation for intelligent, autonomous business operations.
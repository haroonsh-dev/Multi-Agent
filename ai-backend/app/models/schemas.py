from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Any
from enum import Enum


class ProviderConfigPayload(BaseModel):
    provider: str
    api_key: str = Field(alias="apiKey")
    model: Optional[str] = ""
    base_url: Optional[str] = Field(default="", alias="baseUrl")

    model_config = ConfigDict(populate_by_name=True)


class DocumentType(str, Enum):
    # Finance
    INVOICE = "invoice"
    FINANCIAL_STATEMENT = "financial_statement"
    EXPENSE_REPORT = "expense_report"
    PAYMENT_RECEIPT = "payment_receipt"
    TAX_DOCUMENT = "tax_document"
    BANK_STATEMENT = "bank_statement"
    BUDGET = "budget"
    # HR
    EMPLOYEE_RECORD = "employee_record"
    HR_DOCUMENT = "hr_document"
    OFFER_LETTER = "offer_letter"
    EMPLOYMENT_CONTRACT = "employment_contract"
    LEAVE_APPLICATION = "leave_application"
    PAYROLL = "payroll"
    ATTENDANCE = "attendance"
    PERFORMANCE_REVIEW = "performance_review"
    TRAINING_CERTIFICATE = "training_certificate"
    RESUME = "resume"
    TRANSCRIPT = "transcript"
    # Legal
    CONTRACT = "contract"
    AGREEMENT = "agreement"
    NDA = "nda"
    SERVICE_AGREEMENT = "service_agreement"
    LEASE_AGREEMENT = "lease_agreement"
    VENDOR_CONTRACT = "vendor_contract"
    # Procurement
    PURCHASE_ORDER = "purchase_order"
    QUOTATION = "quotation"
    SUPPLIER_AGREEMENT = "supplier_agreement"
    VENDOR_LIST = "vendor_list"
    RFQ = "rfq"
    DELIVERY_NOTE = "delivery_note"
    PROCUREMENT_REQUEST = "procurement_request"
    # Compliance
    SOP = "sop"
    AUDIT_REPORT = "audit_report"
    QUALITY_REPORT = "quality_report"
    CERTIFICATE = "certificate"
    MAINTENANCE_REPORT = "maintenance_report"
    ENGINEERING_DRAWING = "engineering_drawing"
    INSPECTION_REPORT = "inspection_report"
    SAFETY_MANUAL = "safety_manual"
    ISO_DOCUMENT = "iso_document"
    COMPLIANCE_FORM = "compliance_form"
    REGULATORY_DOCUMENT = "regulatory_document"
    OTHER = "other"


class DocumentStatus(str, Enum):
    UPLOADED = "uploaded"
    PROCESSING = "processing"
    OCR_DONE = "ocr_done"
    CLASSIFIED = "classified"
    EXTRACTED = "extracted"
    PROCESSED = "processed"
    FAILED = "failed"


class DocumentResponse(BaseModel):
    id: str
    organization_id: str
    title: str
    document_type: Optional[str] = None
    status: DocumentStatus = DocumentStatus.UPLOADED
    file_url: Optional[str] = None
    file_hash: Optional[str] = None
    page_count: Optional[int] = None
    language: Optional[str] = None
    file_size: Optional[int] = None
    raw_text: Optional[str] = None
    error_message: Optional[str] = None
    cv_score: Optional[float] = None
    created_at: str
    updated_at: str


class DocumentListResponse(BaseModel):
    documents: list[DocumentResponse]
    total: int


class UploadResponse(BaseModel):
    id: str
    title: str
    status: str
    message: str


class ClassificationResponse(BaseModel):
    document_id: str = ""
    document_type: DocumentType = DocumentType.OTHER
    agent_type: Optional[str] = None
    confidence: float = 0.0
    reasoning: str = ""
    language: Optional[str] = None
    estimated_quality: Optional[str] = None


class ExtractionResponse(BaseModel):
    document_id: str
    document_type: DocumentType
    extracted_data: dict[str, Any]
    confidence: float


class SearchRequest(BaseModel):
    query: str
    organization_id: str
    document_type: Optional[str] = None
    phase3_agent: Optional[str] = None
    status: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    limit: int = 20
    offset: int = 0


class SearchResult(BaseModel):
    document_id: str
    document_title: str
    document_type: Optional[str] = None
    cv_score: Optional[float] = None
    chunk_text: str
    page_number: Optional[int] = None
    heading: Optional[str] = None
    section: Optional[str] = None
    section_number: Optional[str] = None
    machine_id: Optional[str] = None
    filename: Optional[str] = None
    score: float
    metadata: Optional[dict] = None


class SearchResponse(BaseModel):
    results: list[SearchResult]
    total: int
    query: str


class ChatMessageResponse(BaseModel):
    id: int = 0
    session_id: str = ""
    role: str
    content: str
    sources: Optional[list] = None
    created_at: Optional[str] = None


class ChatSessionResponse(BaseModel):
    id: str
    organization_id: str
    user_id: Optional[str] = None
    document_ids: list[str] = []
    title: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    messages: list[ChatMessageResponse] = []


class ChatSessionListResponse(BaseModel):
    sessions: list[ChatSessionResponse]
    total: int


class ChatRequest(BaseModel):
    document_id: str = ""
    organization_id: str
    user_id: Optional[str] = None
    question: str
    document_ids: Optional[list[str]] = None
    document_type: Optional[str] = None
    phase3_agent: Optional[str] = None
    allowed_agents: Optional[list[str]] = None
    status: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    chat_history: Optional[list[dict]] = None
    session_id: Optional[str] = None
    selected_text: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    provider_config: Optional[ProviderConfigPayload] = None


class ChatResponse(BaseModel):
    answer: str
    sources: list[dict]
    document_id: str
    history: list[dict] = []
    session_id: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    chart_data: Optional[dict] = None


class ProcessRequest(BaseModel):
    organization_id: str


class SignupRequest(BaseModel):
    email: str
    password: str

class LoginRequest(BaseModel):
    email: str
    password: str

class AuthResponse(BaseModel):
    token: str
    user_id: str
    email: str
    organization_id: str

class UserMe(BaseModel):
    user_id: str
    email: str
    organization_id: str

class DocumentExtractionResponse(BaseModel):
    id: int | None = None
    organization_id: Optional[str] = None
    document_id: str
    extraction_type: str
    extracted_data: dict[str, Any]
    confidence: float = 0.0
    reviewed: int | None = None
    created_at: Optional[str] = None


class ExtractionListResponse(BaseModel):
    extractions: list[DocumentExtractionResponse]
    total: int


class ProcessResponse(BaseModel):
    document_id: str
    status: str
    classification: Optional[ClassificationResponse] = None
    extraction: Optional[ExtractionResponse] = None

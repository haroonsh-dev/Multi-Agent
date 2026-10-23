from .agent_orchestrator import classification_agent
from ..models.schemas import DocumentType


class ClassificationService:
    def classify(self, text: str, filename: str = "") -> dict:
        result = classification_agent.classify(text, filename)

        doc_type = str(result.get("document_type", "other")).lower().replace(" ", "_")

        valid_types = {t.value for t in DocumentType}
        if doc_type not in valid_types:
            doc_type = "other"

        return {
            "document_type": doc_type,
            "agent_type": result.get("agent_type", "other_agent"),
            "confidence": float(result.get("confidence", 0)),
            "reasoning": result.get("reasoning", ""),
            "language": result.get("language", "en"),
            "estimated_quality": result.get("estimated_quality", "medium"),
        }


classification_service = ClassificationService()

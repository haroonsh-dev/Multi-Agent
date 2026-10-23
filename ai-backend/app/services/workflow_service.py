import json
import logging
from datetime import datetime
from ..database import SupabaseDB

logger = logging.getLogger("visibility-docs")

INVOICE_APPROVAL_STAGES = [
    {"name": "uploaded", "label": "Uploaded", "order": 0},
    {"name": "extraction_complete", "label": "Data Extracted", "order": 1},
    {"name": "validation_complete", "label": "Validated", "order": 2},
    {"name": "erp_lookup", "label": "ERP Verified", "order": 3},
    {"name": "approval_pending", "label": "Awaiting Approval", "order": 4},
    {"name": "approved", "label": "Approved", "order": 5},
    {"name": "accounting_posted", "label": "Accounting Posted", "order": 6},
    {"name": "payment_initiated", "label": "Payment Initiated", "order": 7},
    {"name": "completed", "label": "Completed", "order": 8},
]


class WorkflowService:
    def create_workflow(self, organization_id: str, workflow_type: str, document_id: str, assigned_to: str = None) -> dict:
        data = {
            "organization_id": organization_id,
            "workflow_type": workflow_type,
            "document_id": document_id,
            "current_stage": "uploaded",
            "status": "active",
            "stages": INVOICE_APPROVAL_STAGES if workflow_type == "invoice_approval" else [],
            "approvals_required": 1,
            "approvals_obtained": 0,
            "assigned_to": assigned_to,
            "metadata": {},
        }
        SupabaseDB.insert("workflow_instances", data)
        logger.info(f"Workflow {workflow_type} created for doc {document_id}")
        return data

    def advance_stage(self, document_id: str, organization_id: str, notes: str = None) -> dict:
        result = SupabaseDB.select("workflow_instances", filters={"document_id": document_id, "organization_id": organization_id})
        data = getattr(result, "data", [])
        if not isinstance(data, list) or not data:
            return {"error": "Workflow not found"}
        wf = data[0] if isinstance(data[0], dict) else {}

        stages = wf.get("stages", [])
        if isinstance(stages, str):
            try:
                stages = json.loads(stages)
            except (json.JSONDecodeError, TypeError):
                stages = []

        current = wf.get("current_stage", "uploaded")
        next_idx = -1
        for i, s in enumerate(stages):
            if isinstance(s, dict) and s.get("name") == current:
                next_idx = i + 1
                break

        if next_idx >= len(stages):
            new_stage = "completed"
            new_status = "completed"
        else:
            new_stage = stages[next_idx]["name"] if isinstance(stages[next_idx], dict) else "completed"
            new_status = "active"

        update = {
            "current_stage": new_stage,
            "status": new_status,
            "updated_at": datetime.utcnow().isoformat(),
        }
        if notes:
            meta = wf.get("metadata", {})
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except (json.JSONDecodeError, TypeError):
                    meta = {}
            meta["last_notes"] = notes
            update["metadata"] = json.dumps(meta)

        if new_stage == "approved":
            update["approvals_obtained"] = (wf.get("approvals_obtained", 0) or 0) + 1

        SupabaseDB.update("workflow_instances", update, "document_id", document_id)
        logger.info(f"Workflow for doc {document_id} advanced to {new_stage}")
        return {"document_id": document_id, "previous_stage": current, "current_stage": new_stage, "status": new_status}

    def get_workflow_status(self, document_id: str, organization_id: str) -> dict:
        result = SupabaseDB.select("workflow_instances", filters={"document_id": document_id, "organization_id": organization_id})
        data = getattr(result, "data", [])
        if isinstance(data, list) and data:
            wf = data[0] if isinstance(data[0], dict) else {}
            stages = wf.get("stages", [])
            if isinstance(stages, str):
                try:
                    stages = json.loads(stages)
                except (json.JSONDecodeError, TypeError):
                    stages = []
            wf["stages"] = stages
            meta = wf.get("metadata", {})
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except (json.JSONDecodeError, TypeError):
                    meta = {}
            wf["metadata"] = meta
            return wf
        return {}

    def list_pending_approvals(self, organization_id: str, assigned_to: str = None) -> list[dict]:
        result = SupabaseDB.select("workflow_instances", filters={"organization_id": organization_id, "current_stage": "approval_pending", "status": "active"})
        data = getattr(result, "data", [])
        if not isinstance(data, list):
            return []
        if assigned_to:
            return [w for w in data if isinstance(w, dict) and w.get("assigned_to") == assigned_to]
        return data

    def approve(self, document_id: str, organization_id: str, approver: str, notes: str = None) -> dict:
        self.advance_stage(document_id, organization_id, notes=f"Approved by {approver}: {notes or ''}")
        logger.info(f"Document {document_id} approved by {approver}")
        return {"status": "approved", "document_id": document_id, "approver": approver}

    def reject(self, document_id: str, organization_id: str, approver: str, reason: str) -> dict:
        SupabaseDB.update("workflow_instances", {
            "status": "rejected",
            "updated_at": datetime.utcnow().isoformat(),
            "error_message": f"Rejected by {approver}: {reason}",
        }, "document_id", document_id)
        SupabaseDB.update("documents", {"status": "rejected"}, "id", document_id)
        logger.info(f"Document {document_id} rejected by {approver}: {reason}")
        return {"status": "rejected", "document_id": document_id, "approver": approver, "reason": reason}


workflow_service = WorkflowService()

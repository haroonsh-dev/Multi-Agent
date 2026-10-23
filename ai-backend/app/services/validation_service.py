import json
import logging
from ..database import SupabaseDB
from .groq_service import groq_service

logger = logging.getLogger("visibility-docs")


class ValidationService:
    def _get_metadata(self, document_id: str, organization_id: str) -> dict:
        result = SupabaseDB.select("documents_metadata", filters={"document_id": document_id, "organization_id": organization_id})
        data = getattr(result, "data", [])
        if isinstance(data, list) and data:
            return data[0] if isinstance(data[0], dict) else {}
        return {}

    def _store_result(self, org_id: str, vtype: str, src_id: str, tgt_id: str,
                      src_field: str, tgt_field: str, expected: str, actual: str,
                      match_status: str, details: str, severity: str):
        SupabaseDB.insert("validation_results", {
            "organization_id": org_id,
            "validation_type": vtype,
            "source_document_id": src_id,
            "target_document_id": tgt_id,
            "source_field": src_field,
            "target_field": tgt_field,
            "expected_value": str(expected) if expected else None,
            "actual_value": str(actual) if actual else None,
            "match_status": match_status,
            "discrepancy_details": details,
            "severity": severity,
        })

    def validate_invoice_po(self, invoice_id: str, po_id: str, organization_id: str) -> list[dict]:
        results = []
        inv = self._get_metadata(invoice_id, organization_id).get("extracted_data", {})
        po = self._get_metadata(po_id, organization_id).get("extracted_data", {})

        if not isinstance(inv, dict):
            inv = {}
        if not isinstance(po, dict):
            po = {}

        inv_total = inv.get("total", 0)
        po_total = po.get("total_amount", 0)
        if inv_total and po_total:
            diff = abs(float(inv_total) - float(po_total))
            threshold = float(po_total) * 0.05
            status = "match" if diff <= threshold else "mismatch"
            self._store_result(organization_id, "invoice_po_match", invoice_id, po_id,
                               "total", "total_amount", str(po_total), str(inv_total),
                               status, f"Difference: {diff} ({'within' if status == 'match' else 'exceeds'} 5% threshold)",
                               "warning" if status == "mismatch" else "info")
            results.append({"type": "total_amount", "status": status, "expected": po_total, "actual": inv_total})

        inv_po_ref = inv.get("po_reference", "")
        po_number = po.get("po_number", "")
        if inv_po_ref and po_number:
            status = "match" if str(inv_po_ref).strip() == str(po_number).strip() else "mismatch"
            self._store_result(organization_id, "invoice_po_match", invoice_id, po_id,
                               "po_reference", "po_number", po_number, inv_po_ref,
                               status, f"PO reference: invoice says {inv_po_ref}, PO says {po_number}",
                               "error" if status == "mismatch" else "info")
            results.append({"type": "po_reference", "status": status, "expected": po_number, "actual": inv_po_ref})

        inv_vendor = (inv.get("vendor_name", "") or "").lower()
        po_vendor = (po.get("vendor_name", "") or "").lower()
        if inv_vendor and po_vendor:
            status = "match" if inv_vendor == po_vendor else "mismatch"
            self._store_result(organization_id, "invoice_po_match", invoice_id, po_id,
                               "vendor_name", "vendor_name", po.get("vendor_name", ""), inv.get("vendor_name", ""),
                               status, f"Vendor mismatch",
                               "error" if status == "mismatch" else "info")
            results.append({"type": "vendor", "status": status})

        inv_currency = inv.get("currency", "")
        po_currency = po.get("currency", "")
        if inv_currency and po_currency:
            status = "match" if inv_currency == po_currency else "mismatch"
            self._store_result(organization_id, "invoice_po_match", invoice_id, po_id,
                               "currency", "currency", po_currency, inv_currency,
                               status, f"Currency mismatch",
                               "error" if status == "mismatch" else "info")
            results.append({"type": "currency", "status": status})

        return results

    def validate_invoice_contract(self, invoice_id: str, contract_id: str, organization_id: str) -> list[dict]:
        results = []
        inv = self._get_metadata(invoice_id, organization_id).get("extracted_data", {})
        contract = self._get_metadata(contract_id, organization_id).get("extracted_data", {})

        if not isinstance(inv, dict):
            inv = {}
        if not isinstance(contract, dict):
            contract = {}

        inv_vendor = (inv.get("vendor_name", "") or "").lower()
        contract_party = (contract.get("party_b_name", "") or "").lower()
        if inv_vendor and contract_party:
            status = "match" if inv_vendor == contract_party else "mismatch"
            self._store_result(organization_id, "invoice_contract_match", invoice_id, contract_id,
                               "vendor_name", "party_b_name", contract.get("party_b_name", ""), inv.get("vendor_name", ""),
                               status, f"Vendor/Party mismatch",
                               "error" if status == "mismatch" else "info")
            results.append({"type": "vendor_party", "status": status})

        inv_total = float(inv.get("total", 0) or 0)
        contract_value = float(contract.get("contract_value", 0) or 0)
        if inv_total and contract_value and inv_total > contract_value:
            self._store_result(organization_id, "invoice_contract_match", invoice_id, contract_id,
                               "total", "contract_value", str(contract_value), str(inv_total),
                               "mismatch", f"Invoice total exceeds contract value by {inv_total - contract_value}",
                               "error")
            results.append({"type": "total_exceeds_contract", "status": "mismatch"})

        return results

    def validate_certificate_asset(self, certificate_id: str, asset_id: str = None, organization_id: str = None) -> list[dict]:
        results = []
        cert = self._get_metadata(certificate_id, organization_id).get("extracted_data", {})
        if not isinstance(cert, dict):
            cert = {}

        expiry = cert.get("expiry_date", "")
        if expiry:
            try:
                from datetime import datetime
                expiry_date = datetime.strptime(expiry, "%Y-%m-%d")
                if expiry_date < datetime.now():
                    self._store_result(organization_id, "certificate_expiry", certificate_id, None,
                                       "expiry_date", None, f"Expired on {expiry}", None,
                                       "alert", f"Certificate expired on {expiry}", "error")
                    results.append({"type": "expired", "status": "expired", "expiry_date": expiry})
                else:
                    days_left = (expiry_date - datetime.now()).days
                    if days_left < 30:
                        self._store_result(organization_id, "certificate_expiry", certificate_id, None,
                                           "expiry_date", None, f"Expires in {days_left} days", None,
                                           "alert", f"Certificate expiring in {days_left} days", "warning")
                        results.append({"type": "expiring_soon", "status": "warning", "days_left": days_left})
            except ValueError:
                pass

        return results

    def detect_duplicate_invoice(self, document_id: str, organization_id: str) -> list[dict]:
        results = []
        meta = self._get_metadata(document_id, organization_id)
        inv = meta.get("extracted_data", {})
        if not isinstance(inv, dict):
            return results

        inv_number = (inv.get("invoice_number", "") or "").strip()
        if not inv_number:
            return results

        all_meta = SupabaseDB.select("documents_metadata", filters={"organization_id": organization_id, "document_type": "invoice"})
        data = getattr(all_meta, "data", [])
        if not isinstance(data, list):
            return results

        for other in data:
            if not isinstance(other, dict):
                continue
            if other.get("document_id") == document_id:
                continue
            other_data = other.get("extracted_data", {})
            if isinstance(other_data, str):
                try:
                    other_data = json.loads(other_data)
                except (json.JSONDecodeError, TypeError):
                    continue
            if isinstance(other_data, dict) and (other_data.get("invoice_number", "") or "").strip() == inv_number:
                self._store_result(organization_id, "duplicate_invoice", document_id, other.get("document_id"),
                                   "invoice_number", "invoice_number", inv_number, inv_number,
                                   "duplicate", f"Same invoice number found in document {other.get('document_id')}",
                                   "error")
                results.append({"type": "duplicate_invoice", "status": "duplicate", "duplicate_of": other.get("document_id")})
                break

        return results

    def run_all_validations(self, document_id: str, organization_id: str) -> dict:
        all_results = {"invoice_po": [], "invoice_contract": [], "certificate": [], "duplicate_invoice": []}

        doc_result = SupabaseDB.select("documents", filters={"id": document_id})
        data = getattr(doc_result, "data", [])
        doc_type = ""
        if isinstance(data, list) and data:
            doc_type = (data[0] if isinstance(data[0], dict) else {}).get("document_type", "")

        if doc_type == "invoice":
            all_results["duplicate_invoice"] = self.detect_duplicate_invoice(document_id, organization_id)

            po_docs = SupabaseDB.select("documents", filters={"organization_id": organization_id, "document_type": "purchase_order"})
            po_data = getattr(po_docs, "data", [])
            if isinstance(po_data, list):
                for po in po_data:
                    if isinstance(po, dict):
                        all_results["invoice_po"].extend(
                            self.validate_invoice_po(document_id, po.get("id", ""), organization_id))

            contract_docs = SupabaseDB.select("documents", filters={"organization_id": organization_id, "document_type": "contract"})
            contract_data = getattr(contract_docs, "data", [])
            if isinstance(contract_data, list):
                for c in contract_data:
                    if isinstance(c, dict):
                        all_results["invoice_contract"].extend(
                            self.validate_invoice_contract(document_id, c.get("id", ""), organization_id))

        if doc_type == "certificate":
            all_results["certificate"] = self.validate_certificate_asset(document_id, organization_id=organization_id)

        return all_results


validation_service = ValidationService()

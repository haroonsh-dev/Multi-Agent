# Document accuracy eval fixtures

Ground-truth set for `npm run eval:accuracy` (`src/scripts/evalDocumentAccuracy.ts`).
This is what answers "how accurate is classification/extraction, really?" instead
of trusting the model's own self-reported confidence score.

## Running it

Needs a live stack (api-gateway + ai-backend + Mongo, with a working AI provider
key configured) — it isn't part of `npm test` / CI, for the same reason none of
the other `eval-*`/`test:*` scripts touch a live server: CI has no Mongo or model
weights available.

```bash
API_BASE_URL=http://localhost:5100/api \
EVAL_EMAIL=you@yourorg.com EVAL_PASSWORD=... \
npm run eval:accuracy
```

Any user with document upload + view permission works. It uploads each fixture
through the real API, waits for processing, checks the returned classification/
agent/extracted fields against `manifest.json`, then deletes what it uploaded.

## The starter fixtures are synthetic — replace/extend them

`invoice_001.txt`, `contract_001.txt`, `certificate_001.txt` are hand-written to
prove the harness works end-to-end, not a claim about real-world accuracy. A
number produced from 3 synthetic documents means very little. What this needs to
become useful:

1. **Real documents** (anonymized — strip real names/amounts/emails if they came
   from an actual customer) covering every `document_type` the product claims to
   support: PO, financial statement, audit report, engineering drawing, etc.
2. **Enough volume per type** to catch inconsistency, not just one lucky/unlucky
   sample — aim for at least 5-10 per document type over time.
3. **Field-level ground truth** filled in from what a human actually reads off
   the document, not from what the pipeline currently outputs (that would just
   be testing the pipeline against itself).

## Adding a fixture

1. Drop the file in this folder (any type `documents.ts`'s upload accepts —
   `.txt` is simplest to author by hand; `.pdf`/`.png` work too and exercise
   OCR, which `.txt` fixtures skip).
2. Add an entry to `manifest.json`:
   ```json
   {
     "file": "your_file.pdf",
     "expectedDocumentType": "purchase_order",
     "expectedAgent": "procurement_agent",
     "expectedFields": { "po_number": "PO-4471", "vendor_name": "Acme Corp" }
   }
   ```
   `expectedFields` values are checked as substrings anywhere in the extracted
   data (not exact key-path matches — the harness doesn't assume ai-backend's
   internal field-naming schema). Keep expected values specific enough that a
   coincidental match is implausible.

## What "good" looks like

Track the printed classification / agent-routing / field-extraction percentages
over time. A drop after a prompt or heuristic-rule change is a real regression
signal — right now nothing catches that before a user does.

-- OCR has been removed from FlowPass. Older local databases that already
-- applied migrations 001-003 keep the unused OCR tables; drop them so the
-- live schema converges with the codebase. Fresh databases never create them.
DROP TABLE IF EXISTS document_field_reviews;
DROP TABLE IF EXISTS document_fields;
DROP TABLE IF EXISTS ocr_raw_payloads;
DROP TABLE IF EXISTS ocr_runs;
DROP TABLE IF EXISTS invoice_fingerprints;

UPDATE program_cycles
SET
  code = CASE
    WHEN code LIKE 'DEMO-%' THEN 'SOFTWARE-SUBSIDY-' || year
    ELSE code
  END,
  name = '軟體補助申請',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  row_version = row_version + 1
WHERE code LIKE 'DEMO-%'
   OR name LIKE '%示範%';

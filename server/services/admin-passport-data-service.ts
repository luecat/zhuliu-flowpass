import { parseEncryptedField, type FieldCrypto } from '../crypto/field-crypto';
import { collectPassportRelationGraph } from '../db/admin-passport-relation-registry';
import type { FlowPassDatabase } from '../db/connection';
import { decryptDatabaseText } from '../db/repositories/encrypted-fields';
import { idempotencyRecordId } from '../db/repositories/idempotency';
import type {
  AdminDataField,
  AdminDataFieldType,
  AdminDataGroup,
  AdminDataRecord,
  AdminDataRecordKind,
  AdminPassportDataSnapshot,
} from '../../shared/admin-data-management-contract';

const GROUPS: Array<[string, string, string[]]> = [
  ['case', '案件與申請人答案', ['cases', 'answer_versions']],
  ['purchase', '購買內容與金額', ['case_purchase_details']],
  ['passport', '護照與歷次護照版本', ['passports', 'passport_versions', 'passport_confirmations', 'passport_follow_up_questions', 'passport_follow_up_answers', 'passport_node_index', 'passport_edge_index', 'passport_tool_index']],
  ['documents', '文件與附件', ['documents']],
  ['tasks', '任務、審查與狀態流轉', ['case_tasks', 'case_state_transitions']],
  ['timeline', '時間軸與通知', ['timeline_events', 'notification_jobs']],
  ['rules', '規則判定與補助計算', ['rule_evaluations', 'subsidy_calculations']],
  ['automation', 'AI、送出與事件', ['ai_runs', 'alerts', 'incident_matches', 'jobs']],
  ['system', '系統關聯與管理稽核', ['audit_logs', 'admin_data_edit_audits', 'api_idempotency_keys']],
];

const TABLE_LABELS: Record<string, string> = {
  cases: '案件', answer_versions: '申請答案', case_purchase_details: '購買資料', passports: '護照', passport_versions: '護照版本',
  passport_confirmations: '護照確認', passport_follow_up_questions: '追問問題', passport_follow_up_answers: '追問回答', passport_node_index: '節點索引',
  passport_edge_index: '關聯索引', passport_tool_index: '工具索引', documents: '附件', case_tasks: '任務', case_state_transitions: '狀態流轉',
  timeline_events: '時間軸事件', notification_jobs: '通知', rule_evaluations: '規則判定', subsidy_calculations: '補助計算', ai_runs: 'AI 執行',
  alerts: '提醒', incident_matches: '事件比對', jobs: '送出紀錄', audit_logs: '系統稽核', admin_data_edit_audits: '資料校正稽核', api_idempotency_keys: '冪等紀錄',
};

const FIELD_LABELS: Record<string, string> = {
  id: '紀錄識別碼', case_id: '案件識別碼', applicant_id: '申請人識別碼', passport_id: '護照識別碼', passport_version_id: '護照版本識別碼', answer_version_id: '答案版本識別碼',
  program_cycle_id: '方案期別識別碼', program_rule_version_id: '規則版本識別碼', rule_evaluation_id: '規則判定識別碼', document_id: '附件識別碼', job_id: '工作識別碼',
  case_code: '案件編號', state: '案件狀態', requested_amount_twd: '申請金額', calculated_amount_twd: '系統計算金額', approved_amount_twd: '核定金額', disbursed_amount_twd: '撥款金額',
  title_enc: '案件標題', decision_reason_enc: '核定說明', submitted_at: '送出時間', closed_at: '結案時間', created_at: '建立時間', updated_at: '更新時間',
  workflow_state: '護照狀態', version_no: '版本', origin: '來源', payload_enc: '護照內容', answers_enc: '申請答案', details_enc: '購買資料',
  original_name_enc: '附件名稱', public_summary: '公開摘要', public_guidance: '處理指引', instructions_enc: '任務說明', due_at: '期限', status: '狀態',
  row_version: '資料版本', content_sha256: '內容摘要', key_id: '加密金鑰版本', byte_size: '檔案大小', media_type: '檔案類型', storage_id: '儲存識別碼',
  created_by_type: '建立者類型', created_by_id: '建立者識別碼', created_by_applicant_id: '建立此版本的申請人', actor_type: '操作者類型', actor_id: '操作者識別碼',
  event_type: '事件類型', from_state: '原狀態', to_state: '新狀態', reason_code: '原因代碼', reason_enc: '原因說明', outcome: '處理結果',
  kind: '類型', requirement_key: '文件需求', started_at: '開始時間', resolved_at: '解決時間', sent_at: '傳送時間', available_at: '可執行時間', leased_until: '租約到期時間',
  error_code: '錯誤代碼', error_public_summary: '錯誤摘要', attempts: '嘗試次數', max_attempts: '最多嘗試次數',
  payload_json: '送出內容', unique_key: '去重識別碼', lease_owner: '處理工作者', lease_until: '租約到期時間', completed_at: '完成時間',
};

const PATH_LABELS: Record<string, string> = {
  material: '會使用的資料', aiPurpose: '使用 AI 的目的', sensitiveData: '是否包含敏感資料', destinationAndAudience: '資料去向與使用對象',
  billingCycle: '計費方式', billingPeriods: '購買期數', softwareFunction: '軟體用途', otherFunction: '其他用途', softwareName: '軟體名稱', companyName: '供應商名稱',
  purchaseDate: '購買日期', payerType: '付款人類型', originalCurrency: '原始幣別', otherCurrency: '其他幣別', originalExpense: '原始金額', convertedTwd: '換算新台幣金額', specialStatus: '是否具特殊身分',
  'use_case.title': '使用情境名稱', 'use_case.purpose': '使用目的', 'use_case.intended_outcome': '預期成果',
  'sharing_scope.audience': '資料分享對象', 'sharing_scope.needs_confirmation': '分享範圍是否待確認',
  'retention.storage_location': '資料保存位置', 'retention.duration': '保存期限', 'retention.deletion_plan': '刪除方式', 'retention.needs_confirmation': '保存方式是否待確認',
  'administrative_hints.requested_tool': '申請使用的工具',
};

function pathLabel(path: string): string {
  if (PATH_LABELS[path]) return PATH_LABELS[path];
  const node = path.match(/^nodes\.(\d+)\.(label|data_category|sensitivity|confidence|needs_confirmation)$/);
  if (node) return `資料節點 ${Number(node[1]) + 1} · ${{ label: '名稱', data_category: '資料類別', sensitivity: '敏感程度', confidence: '信心度', needs_confirmation: '是否待確認' }[node[2]]}`;
  const edge = path.match(/^edges\.(\d+)\.(purpose|confidence|needs_confirmation)$/);
  if (edge) return `資料關聯 ${Number(edge[1]) + 1} · ${{ purpose: '用途', confidence: '信心度', needs_confirmation: '是否待確認' }[edge[2]]}`;
  const safety = path.match(/^safety_actions\.(\d+)\.(action|reason)$/);
  if (safety) return `安全措施 ${Number(safety[1]) + 1} · ${safety[2] === 'action' ? '措施' : '原因'}`;
  return path;
}

const EDITABLE: Record<string, Set<string>> = {
  cases: new Set(['state', 'requested_amount_twd', 'approved_amount_twd', 'title_enc', 'decision_reason_enc', 'closed_at']),
  case_tasks: new Set(['title', 'instructions_enc', 'due_at', 'status']),
  alerts: new Set(['public_summary', 'public_guidance', 'status', 'resolved_at']),
  documents: new Set(['original_name_enc']),
};

const DERIVED_TABLES = new Set(['passport_node_index', 'passport_edge_index', 'passport_tool_index', 'rule_evaluations', 'subsidy_calculations', 'ai_runs', 'incident_matches']);
const HISTORY_TABLES = new Set(['answer_versions', 'passport_versions', 'passport_confirmations', 'passport_follow_up_questions', 'passport_follow_up_answers', 'case_state_transitions', 'timeline_events', 'notification_jobs', 'audit_logs']);

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function typeFor(column: string, value: unknown): AdminDataFieldType {
  if (column.endsWith('_at')) return column === 'purchase_date' ? 'date' : 'datetime';
  if (column.endsWith('_twd')) return 'money';
  if (column.endsWith('_json') || column.endsWith('_enc') && typeof value === 'object') return 'json';
  if (column === 'state' || column === 'status' || column === 'workflow_state' || column === 'outcome') return 'status';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'text';
  if (typeof value === 'boolean') return 'boolean';
  return 'text';
}

function decryptValue(crypto: FieldCrypto, table: string, column: string, id: string, value: string): { value: unknown; keyId?: string } {
  const recordId = table === 'api_idempotency_keys' ? id : id;
  const text = decryptDatabaseText(crypto, table, column, recordId, value);
  const parsed = column.endsWith('_enc') && (text.startsWith('{') || text.startsWith('[')) ? parseJson(text) : text;
  return { value: parsed, keyId: parseEncryptedField(value).keyId };
}

function field(table: string, id: string, column: string, raw: unknown, crypto: FieldCrypto): AdminDataField {
  let value = raw;
  let keyId: string | undefined;
  if (typeof raw === 'string' && column.endsWith('_enc')) {
    try {
      const decrypted = decryptValue(crypto, table, column, id, raw);
      value = decrypted.value;
      keyId = decrypted.keyId;
    } catch {
      value = '無法解密';
    }
  } else if (typeof raw === 'string' && (column.endsWith('_json') || column === 'payload_json')) {
    value = parseJson(raw);
  } else if (column === 'required' || column === 'needs_confirmation' || column === 'special_status') {
    value = raw === 1;
  }
  const editable = EDITABLE[table]?.has(column) ?? false;
  return {
    key: column,
    label: FIELD_LABELS[column] ?? column,
    type: typeFor(column, value),
    value,
    editable,
    ...(!editable ? { lockedReason: DERIVED_TABLES.has(table) ? '此為系統衍生資料' : '此欄位由系統管理' } : {}),
    ...(column.endsWith('_enc') ? { storage: { encrypted: true, ...(keyId ? { keyId } : {}) } } : {}),
    ...(column === 'content_sha256' && typeof raw === 'string' ? { storage: { sha256: raw } } : {}),
    ...(column === 'byte_size' && typeof raw === 'number' ? { storage: { byteSize: raw } } : {}),
  };
}

function flattenObject(prefix: string, value: unknown, output: Array<[string, unknown]>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) flattenObject(prefix ? `${prefix}.${key}` : key, child, output);
    return;
  }
  output.push([prefix, value]);
}

function specialEncryptedFields(table: string, row: Record<string, unknown>, crypto: FieldCrypto): AdminDataField[] | null {
  const column = table === 'answer_versions' ? 'answers_enc' : table === 'case_purchase_details' ? 'details_enc' : table === 'passport_versions' ? 'payload_enc' : null;
  if (!column || typeof row[column] !== 'string') return null;
  try {
    const decrypted = decryptValue(crypto, table, column, String(row.id ?? row.case_id), row[column] as string);
    const flattened: Array<[string, unknown]> = [];
    flattenObject('', decrypted.value, flattened);
    return flattened.map(([path, value]) => ({
      key: path,
      label: pathLabel(path),
      type: typeFor(path, value),
      value,
      editable: table === 'case_purchase_details' || table === 'passport_versions' || table === 'answer_versions',
      storage: { encrypted: true, ...(decrypted.keyId ? { keyId: decrypted.keyId } : {}) },
    }));
  } catch {
    return [{ key: column, label: FIELD_LABELS[column], type: 'text', value: '無法解密', editable: false, lockedReason: '加密資料目前無法讀取' }];
  }
}

function recordKind(table: string): AdminDataRecordKind {
  if (DERIVED_TABLES.has(table)) return 'derived';
  if (HISTORY_TABLES.has(table)) return 'history';
  if (table === 'jobs' || table === 'admin_data_edit_audits' || table === 'api_idempotency_keys') return 'system';
  return 'source';
}

function loadRows(database: FlowPassDatabase, table: string, ids: string[]): Array<Record<string, unknown>> {
  if (ids.length === 0) return [];
  if (table === 'api_idempotency_keys') {
    return ids.map((composite) => {
      const [scope, key] = composite.split('\u0000');
      return database.prepare('SELECT * FROM api_idempotency_keys WHERE scope = ? AND key = ?').get(scope, key) as Record<string, unknown>;
    }).filter(Boolean);
  }
  const key = table === 'case_purchase_details' ? 'case_id' : 'id';
  const placeholders = ids.map(() => '?').join(', ');
  return database.prepare(`SELECT * FROM ${table} WHERE ${key} IN (${placeholders})`).all(...ids) as Array<Record<string, unknown>>;
}

function mapRecord(table: string, row: Record<string, unknown>, crypto: FieldCrypto): AdminDataRecord {
  const id = String(row.id ?? row.case_id ?? `${row.scope}\u0000${row.key}`);
  const encryptedFields = specialEncryptedFields(table, row, crypto);
  const hidden = new Set(['answers_enc', 'details_enc', 'payload_enc', 'response_enc']);
  const fields = [
    ...(encryptedFields ?? []),
    ...Object.entries(row)
      .filter(([column]) => column !== 'id' && !hidden.has(column))
      .map(([column, value]) => field(table, id, column, value, crypto)),
  ];
  if (table === 'api_idempotency_keys') {
    const response = row.response_enc;
    const scope = String(row.scope);
    const key = String(row.key);
    if (typeof response === 'string') {
      try {
        const result = decryptValue(crypto, table, 'response_enc', idempotencyRecordId(scope, key), response);
        fields.push({ key: 'response', label: '回應內容', type: 'json', value: parseJson(String(result.value)), editable: false, lockedReason: '冪等回應不可修改', storage: { encrypted: true, ...(result.keyId ? { keyId: result.keyId } : {}) } });
      } catch {
        fields.push({ key: 'response', label: '回應內容', type: 'text', value: '無法解密', editable: false, lockedReason: '冪等回應不可修改' });
      }
    }
  }
  return {
    resource: table,
    table,
    id,
    rowVersion: typeof row.row_version === 'number' ? row.row_version : undefined,
    kind: recordKind(table),
    title: `${TABLE_LABELS[table] ?? table}${typeof row.version_no === 'number' ? ` 第 ${row.version_no} 版` : ''}`,
    fields,
  };
}

const STATE_LABELS: Record<string, string> = {
  draft: '尚未送出', submitted: '已送出', under_review: '審查中', awaiting_documents: '待補件', returned_for_correction: '待修正',
  resubmitted: '已補件', approved: '已核定', rejected: '未核定', awaiting_disbursement: '待撥款', disbursed: '已撥款', closed: '已結案',
};

export function getAdminPassportDataSnapshot(
  database: FlowPassDatabase,
  crypto: FieldCrypto,
  caseId: string,
): AdminPassportDataSnapshot | null {
  const graph = collectPassportRelationGraph(database, caseId, crypto, true);
  if (!graph) return null;
  const root = database.prepare(`
    SELECT cases.state, cases.updated_at, cases.row_version, cases.current_answer_version_id,
           cases.current_passport_version_id, applicants.display_label_enc
    FROM cases JOIN applicants ON applicants.id = cases.applicant_id
    WHERE cases.id = ?
  `).get(caseId) as { state: string; updated_at: string; row_version: number; current_answer_version_id: string | null; current_passport_version_id: string | null; display_label_enc: string };
  let applicantLabel = '申請人';
  try { applicantLabel = decryptDatabaseText(crypto, 'applicants', 'display_label_enc', graph.applicantId, root.display_label_enc); } catch { /* keep non-sensitive fallback */ }

  const groups: AdminDataGroup[] = GROUPS.map(([key, label, tables]) => ({
    key,
    label,
    records: tables.flatMap((table) => loadRows(database, table, graph.tableIds[table] ?? []).map((row) => mapRecord(table, row, crypto))),
  }));
  for (const record of groups.flatMap((group) => group.records)) {
    const historicalVersion = (record.table === 'answer_versions' && record.id !== root.current_answer_version_id)
      || (record.table === 'passport_versions' && record.id !== root.current_passport_version_id);
    if (historicalVersion) {
      for (const item of record.fields) {
        if (!item.editable) continue;
        item.editable = false;
        item.lockedReason = '歷史版本僅供查閱';
      }
    }
    if (record.fields.some((item) => item.editable)) record.rowVersion = root.row_version;
  }
  const refresh = database.prepare(`
    SELECT 1 FROM admin_data_edit_audits
    WHERE case_id = ? AND requires_ai_refresh = 1 AND outcome = 'ok'
    LIMIT 1
  `).get(caseId);

  return {
    caseId,
    caseCode: graph.caseCode,
    state: root.state,
    stateLabel: STATE_LABELS[root.state] ?? '處理中',
    applicantLabel,
    updatedAt: root.updated_at,
    requiresAiRefresh: Boolean(refresh),
    groups,
  };
}

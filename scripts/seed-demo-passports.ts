import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { KeychainSecretProvider } from '../server/config/keychain';
import { FieldCrypto } from '../server/crypto/field-crypto';
import { initializeFieldCryptoAtStartup } from '../server/crypto/keyring';
import { flowPassDatabasePath, openMigratedDatabase, type FlowPassDatabase } from '../server/db/connection';
import { insertApplicantWithEncryptedDisplayLabel } from '../server/db/repositories/identities';
import { upsertPurchaseDetailsForApplicant } from '../server/db/repositories/purchase-details';
import { ensureApprovedToolProducts } from '../server/db/repositories/tools';
import { createCaseService } from '../server/domain/case-service';
import { createDocumentService } from '../server/domain/document-service';
import { createPassportLifecycle } from '../server/domain/passport-lifecycle';
import { inspectPassportDocument } from '../server/domain/passport-validation';
import { materializePurchaseDetails } from '../server/domain/purchase-details-materialize';
import { createSubmissionService } from '../server/domain/submission-service';
import { DocumentVault } from '../server/services/document-vault';
import { isBlockedAiToolLabel, type ApprovedAiToolCategory } from '../shared/approved-ai-tools';
import type { FlowPassPassport } from '../shared/passport-contract';
import { PurchaseDetailsWriteSchema, type DocumentRequirementKey, type PurchaseDetailsWrite } from '../shared/purchase-details-contract';
import { buildDemoScenarios, RULE_CODES, SCENARIO_GROUPS, type DemoScenario, type RuleCode } from './demo-passports/scenarios';

/**
 * Seeds 100 synthetic passports into a NON-production data root by driving the
 * real case, passport, document and submission services, then verifies every
 * rule outcome against the scenario expectation.
 *
 *   npm run seed:demo-passports -- --data-root .flowpass-local/demo-100
 *   npm run seed:demo-passports -- --data-root /tmp/x --test-key   # dry run, fixed key
 */

const PRODUCTION_DATA_ROOT = join(homedir(), 'Library', 'Application Support', 'FlowPass');
// Year 2000 + "ZZ-" sorts after every real cycle (ORDER BY year DESC, code ASC), so
// applicants never see this program as current; it is closed again after seeding.
const PROGRAM_CODE = 'ZZ-DEMO-100-PASSPORTS';
const ACTOR = 'seed-demo-passports';

const RULE_LABELS: Record<RuleCode, string> = {
  submission_window: '申請期程',
  purchase_window: '購買期程',
  invoice_fingerprint: '發票指紋',
  transaction_fingerprint: '交易指紋',
  payment_source_fingerprint: '付款來源指紋',
  exchange_rate_reasonableness: '匯率合理性',
  tool_consistency: '工具一致性',
  subsidy_estimate: '補助試算',
};

const OUTCOME_LABELS: Record<string, string> = { pass: '通過', fail: '不符', needs_review: '紅燈', missing: '待補' };

const REQUIREMENT_KIND: Record<DocumentRequirementKey, 'invoice' | 'eligibility_proof' | 'supplement' | 'other'> = {
  identity_front: 'eligibility_proof',
  identity_back: 'eligibility_proof',
  special_status_proof: 'eligibility_proof',
  purchase_proof: 'invoice',
  vendor_receipt: 'invoice',
  card_transaction: 'invoice',
  passbook_cover: 'supplement',
  affidavit: 'other',
  representative_affidavit: 'other',
  supplement_other: 'supplement',
};

const CATEGORY_CONTEXT: Record<ApprovedAiToolCategory, { useCase: string; material: string; purpose: string; sensitive: string; destination: string; dataCategory: 'document' | 'code' | 'photo' | 'video' | 'audio' | 'creative_asset'; audience: 'self' | 'team' | 'client' | 'public' }> = {
  chat_search: { useCase: '課程報告資料整理', material: '公開論文摘要與自己的課堂筆記', purpose: '用 AI 摘要文獻並整理報告大綱', sensitive: '不含個人資料', destination: '只給自己與授課老師看', dataCategory: 'document', audience: 'self' },
  coding: { useCase: '個人作品集網站開發', material: '自己撰寫的網站原始碼', purpose: '用 AI 協助除錯與產生測試', sensitive: '不含密碼或金鑰', destination: '部署到公開的作品集網站', dataCategory: 'code', audience: 'public' },
  image: { useCase: '社團活動海報設計', material: '社團 Logo 與活動文字', purpose: '用 AI 生成海報主視覺', sensitive: '不含人臉照片', destination: '張貼在校園與社團粉專', dataCategory: 'creative_asset', audience: 'public' },
  av: { useCase: '社團招生短影音', material: '社員同意拍攝的活動影片與旁白', purpose: '用 AI 剪輯並產生字幕配音', sensitive: '含社員人臉與聲音，已取得同意', destination: '發布到社群平台', dataCategory: 'video', audience: 'public' },
  design_present: { useCase: '期末專題簡報', material: '小組專題內容與圖表', purpose: '用 AI 產生簡報版面', sensitive: '不含個人資料', destination: '課堂上向同學與老師報告', dataCategory: 'document', audience: 'team' },
  writing_productivity: { useCase: '會議紀錄與文件校稿', material: '讀書會錄音逐字稿與草稿', purpose: '用 AI 產生摘要並修正文法', sensitive: '含成員姓名', destination: '分享給讀書會成員', dataCategory: 'audio', audience: 'team' },
  automation_schedule: { useCase: '工作室接案流程自動化', material: '客戶詢價表單內容', purpose: '用 AI 自動分類詢價並排程回覆', sensitive: '含客戶姓名與 Email', destination: '只在工作室內部使用', dataCategory: 'document', audience: 'client' },
  social_character: { useCase: '粉專貼文排程', material: '自己撰寫的貼文草稿與照片', purpose: '用 AI 潤飾文案並排程發布', sensitive: '不含他人個資', destination: '發布到個人粉專', dataCategory: 'photo', audience: 'public' },
};

interface ScenarioResult {
  scenario: DemoScenario;
  caseCode: string;
  state: string;
  actual: Partial<Record<RuleCode, { outcome: string; reasonCode: string; explanation: string }>>;
  problems: string[];
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function loadCrypto(useTestKey: boolean): Promise<FieldCrypto> {
  if (useTestKey) {
    return new FieldCrypto({ activeKeyId: 'demo-test-v1', getMasterKey: (id) => (id === 'demo-test-v1' ? Buffer.alloc(32, 0x5a) : undefined) });
  }
  // Same composition as server/admin/main.ts so the admin app can decrypt the seeded rows.
  const keyId = process.env.FLOWPASS_ACTIVE_KEY_ID ?? 'flowpass-v1';
  return initializeFieldCryptoAtStartup(new KeychainSecretProvider(), {
    activeKeyId: keyId,
    masterKeyRefs: { [keyId]: { service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: process.env.FLOWPASS_MASTER_KEY_ACCOUNT ?? 'flowpass-master-key' } },
  });
}

function seedProgram(database: FlowPassDatabase, now: Date): string {
  if (database.prepare('SELECT id FROM program_cycles WHERE code = ?').get(PROGRAM_CODE)) {
    throw new Error(`${PROGRAM_CODE} already exists in this data root; use a new --data-root`);
  }
  const cycleId = uuidv7();
  const ruleId = uuidv7();
  const at = now.toISOString();
  const day = 86_400_000;
  database.transaction(() => {
    database.prepare(`INSERT INTO program_cycles (id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version) VALUES (?, ?, '【測試】FlowPass 百件測試護照', 2000, 'active', '{}', ?, ?, 1)`).run(cycleId, PROGRAM_CODE, at, at);
    database.prepare(`INSERT INTO program_rule_versions (id, program_cycle_id, version_no, status, application_start_at, application_end_at, purchase_start_at, purchase_end_at, subsidy_rate_bps, per_case_cap_twd, rounding_mode, required_documents_json, rules_json, published_at, created_at) VALUES (?, ?, 1, 'published', ?, ?, '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z', 5000, 10000, 'floor', '[]', '{}', ?, ?)`)
      .run(ruleId, cycleId, new Date(now.getTime() - 60 * day).toISOString(), new Date(now.getTime() + 60 * day).toISOString(), at, at);
  })();
  return cycleId;
}

function buildPassport(scenario: DemoScenario): FlowPassPassport {
  const context = CATEGORY_CONTEXT[scenario.category];
  const toolIds = scenario.passportTools.map((_, index) => `node_tool_${pad2(index + 1)}`);
  const node = (id: string, kind: string, label: string, dataCategory: string, sensitivity: string, sourceField: string) => ({
    id, kind, label, data_category: dataCategory, sensitivity, source_field: sourceField, source_excerpt: label, confidence: 0.95, needs_confirmation: false,
  });
  const edge = (id: string, from: string, to: string, purpose: string, sourceField: string) => ({
    id, from_node_id: from, to_node_id: to, purpose, source_field: sourceField, source_excerpt: purpose, confidence: 0.9, needs_confirmation: false,
  });
  const nodes = [
    node('node_data_01', 'data', context.material, context.dataCategory, context.sensitive.startsWith('不含') ? 'low' : 'medium', 'materials'),
    ...scenario.passportTools.map((label, index) => node(toolIds[index], 'ai_tool', label, 'other', 'medium', 'intended_use')),
    ...(scenario.plugin ? [node('node_plugin_01', 'plugin', scenario.plugin, 'other', 'medium', 'intended_use')] : []),
    node('node_storage_01', 'storage', '個人雲端資料夾', 'other', 'low', 'destination_and_audience'),
    node('node_dest_01', 'destination', context.destination, 'other', 'low', 'destination_and_audience'),
  ];
  const producer = toolIds[0] ?? 'node_data_01';
  const edges = [
    ...toolIds.map((id, index) => edge(`edge_in_${pad2(index + 1)}`, 'node_data_01', id, context.purpose, 'intended_use')),
    ...(scenario.plugin && toolIds[0] ? [edge('edge_plugin_01', toolIds[0], 'node_plugin_01', '將產出交給外掛自動化處理', 'intended_use')] : []),
    edge('edge_store_01', producer, 'node_storage_01', '保存產出成果', 'destination_and_audience'),
    edge('edge_publish_01', 'node_storage_01', 'node_dest_01', context.destination, 'destination_and_audience'),
  ];
  const draft = {
    use_case: { title: context.useCase, purpose: context.purpose, intended_outcome: context.destination },
    nodes,
    edges,
    sharing_scope: { audience: context.audience, source_field: 'destination_and_audience', source_excerpt: context.destination, needs_confirmation: false },
    retention: { storage_location: 'node_storage_01', duration: '90 days', deletion_plan: '計畫結束後刪除原始素材', needs_confirmation: false },
    safety_actions: [{ id: 'action_01', action: '確認工具服務條款是否將上傳資料用於模型訓練', reason: '避免申請資料被第三方再利用', applies_to_node_ids: toolIds.length > 0 ? toolIds : ['node_data_01'], status: 'required_confirmation', evidence_type: 'applicant_confirmation' }],
    confirmation_questions: [],
    administrative_hints: { requested_tool: scenario.passportTools[0] ?? 'unknown', invoice_fields_required: ['tool_name', 'purchase_date', 'amount', 'invoice_number'], subsidy_calculation: 'not_performed_by_ai', requires_officer_review: true },
    audit: { draft_status: 'ai_generated_unconfirmed', rules_version: 'hackathon-mvp-2026-08-27', unknown_fields: [] },
  };
  const inspection = inspectPassportDocument({ passport_draft: draft });
  if (!inspection.canonical || inspection.validation.ok === false) {
    throw new Error(`${scenario.code} passport is not canonical`);
  }
  return inspection.canonical;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function requiredDocumentKeys(purchase: PurchaseDetailsWrite): DocumentRequirementKey[] {
  return [
    'identity_front',
    'identity_back',
    ...(purchase.specialStatus ? ['special_status_proof' as const] : []),
    'vendor_receipt',
    'card_transaction',
    'passbook_cover',
    'affidavit',
    ...(purchase.payerType === 'representative' ? ['representative_affidavit' as const] : []),
  ];
}

function placeholderPdf(code: string, requirementKey: string): Uint8Array {
  const stream = `BT /F1 14 Tf 24 60 Td (FLOWPASS DEMO ${code} ${requirementKey} - SYNTHETIC TEST FILE) Tj ET`;
  const text = [
    '%PDF-1.4',
    '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
    '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
    '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 595 140] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>> endobj',
    `4 0 obj <</Length ${stream.length}>> stream`,
    stream,
    'endstream endobj',
    '5 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj',
    'trailer <</Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
  return Buffer.from(text, 'latin1');
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main(): Promise<void> {
  const rawRoot = option('--data-root');
  if (!rawRoot) throw new Error('Provide --data-root explicitly, for example --data-root .flowpass-local/demo-100');
  const dataRoot = resolve(rawRoot);
  const isProduction = dataRoot === PRODUCTION_DATA_ROOT || dataRoot.startsWith(PRODUCTION_DATA_ROOT + sep);
  if (isProduction && !process.argv.includes('--allow-production')) {
    throw new Error('Refusing to seed demo passports into the production data root without --allow-production');
  }
  const useTestKey = process.argv.includes('--test-key');
  const databasePath = flowPassDatabasePath(dataRoot);
  if (useTestKey && existsSync(databasePath)) throw new Error('--test-key requires a new, empty data root');

  const scenarios = buildDemoScenarios();
  const crypto = await loadCrypto(useTestKey);
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = openMigratedDatabase(databasePath);
  try {
    ensureApprovedToolProducts(database);
    const programCycleId = seedProgram(database, new Date());
    const cases = createCaseService({ database, crypto });
    const lifecycle = createPassportLifecycle({ database, crypto });
    const documents = createDocumentService({ database, crypto, vault: new DocumentVault({ rootPath: join(dataRoot, 'vault'), crypto }) });
    const submissions = createSubmissionService({ database, crypto });
    const applicants = new Map<string, string>();
    const etag = (caseId: string) => `"${(database.prepare('SELECT row_version FROM cases WHERE id = ?').get(caseId) as { row_version: number }).row_version}"`;
    const results: ScenarioResult[] = [];

    for (const scenario of scenarios) {
      const write = PurchaseDetailsWriteSchema.parse(scenario.purchase);
      let applicantId = applicants.get(scenario.applicantKey);
      if (!applicantId) {
        applicantId = uuidv7();
        const at = new Date().toISOString();
        insertApplicantWithEncryptedDisplayLabel(database, crypto, { id: applicantId, displayLabel: `DEMO ${write.applicantName}`, status: 'active', createdAt: at, updatedAt: at, rowVersion: 1 });
        applicants.set(scenario.applicantKey, applicantId);
      }

      const created = cases.create({ applicantId, programCycleId, idempotencyKey: `${scenario.code}-case` });
      const caseId = created.case.id;
      const context = CATEGORY_CONTEXT[scenario.category];
      const answer = cases.saveAnswers({
        applicantId,
        caseId,
        answers: { material: context.material, aiPurpose: context.purpose, sensitiveData: context.sensitive, destinationAndAudience: context.destination, applicantName: write.applicantName ?? '' },
        ifMatch: etag(caseId),
        idempotencyKey: `${scenario.code}-answers`,
      });
      const draft = lifecycle.createVersion({ caseId, answerVersionId: answer.answerVersion.id, passport: buildPassport(scenario), origin: 'ai_draft', actorType: 'system', actorId: ACTOR });
      if (scenario.flow !== 'draft') {
        lifecycle.confirmVersion({ applicantId, caseId, passportVersionId: draft.version.id, ifMatch: `"${draft.version.versionNo}"`, declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: true }] });
      }

      // Mirrors the purchase-details route: blocked tools never reach persistence.
      const blocked = isBlockedAiToolLabel(write.softwareName) || isBlockedAiToolLabel(write.companyName);
      if (!blocked) {
        upsertPurchaseDetailsForApplicant(database, { applicantId }, crypto, { caseId, details: materializePurchaseDetails({ write, crypto }), now: new Date().toISOString() });
        for (const requirementKey of requiredDocumentKeys(write)) {
          await documents.upload({ applicantId, caseId, kind: REQUIREMENT_KIND[requirementKey], requirementKey, originalName: `${scenario.code}-${requirementKey}.pdf`, bytes: placeholderPdf(scenario.code, requirementKey), ifMatch: etag(caseId), idempotencyKey: `${scenario.code}-${requirementKey}` });
        }
        if (scenario.flow === 'submit') {
          const current = lifecycle.getForApplicant({ applicantId, caseId });
          if (!current) throw new Error(`${scenario.code} has no current passport`);
          submissions.submit({ applicantId, caseId, passportVersionId: current.version.id, ifMatch: etag(caseId) });
        }
      }

      const row = database.prepare('SELECT case_code, state FROM cases WHERE id = ?').get(caseId) as { case_code: string; state: string };
      const actual: ScenarioResult['actual'] = {};
      const evaluations = database.prepare('SELECT result_json FROM rule_evaluations WHERE case_id = ? ORDER BY created_at, id').all(caseId) as Array<{ result_json: string }>;
      for (const evaluation of evaluations) {
        const parsed = JSON.parse(evaluation.result_json) as { ruleCode: RuleCode; outcome: string; reasonCode: string; explanation: string };
        actual[parsed.ruleCode] = { outcome: parsed.outcome, reasonCode: parsed.reasonCode, explanation: parsed.explanation };
      }

      const problems: string[] = [];
      if (scenario.flow === 'blocked') {
        if (!blocked) problems.push('預期被封鎖，但工具名稱未命中封鎖清單');
        if (row.state !== 'draft') problems.push(`預期停在草稿，實際為 ${row.state}`);
      } else if (blocked) {
        problems.push('工具意外命中封鎖清單');
      } else if (scenario.flow === 'draft') {
        if (row.state !== 'draft') problems.push(`預期停在草稿，實際為 ${row.state}`);
        if (evaluations.length > 0) problems.push(`草稿不應有勾稽結果，實際 ${evaluations.length} 筆`);
      } else {
        if (row.state !== 'submitted') problems.push(`預期已送出，實際為 ${row.state}`);
        for (const ruleCode of RULE_CODES) {
          const got = actual[ruleCode];
          if (got?.outcome !== scenario.expect[ruleCode]) problems.push(`${RULE_LABELS[ruleCode]}：預期 ${OUTCOME_LABELS[scenario.expect[ruleCode]]}，實際 ${got ? OUTCOME_LABELS[got.outcome] ?? got.outcome : '無紀錄'}`);
          const reason = scenario.expectReason[ruleCode];
          if (reason && got?.reasonCode !== reason) problems.push(`${RULE_LABELS[ruleCode]}：預期原因 ${reason}，實際 ${got?.reasonCode ?? '無紀錄'}`);
        }
      }
      results.push({ scenario, caseCode: row.case_code, state: row.state, actual, problems });
    }

    database.prepare(`UPDATE program_cycles SET status = 'closed', updated_at = ?, row_version = row_version + 1 WHERE id = ?`).run(new Date().toISOString(), programCycleId);

    const reportDir = join(dataRoot, 'demo-reports');
    mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
    const header = ['編號', '分組', '情境', '案號', '狀態', '申請人', '持卡人', '末四碼', '付款方式', '發票號碼', '申報軟體', '護照工具', '購買日', '原幣', '台幣', '紅燈／不符／待補', '驗證', '審核重點'];
    const lines = results.map(({ scenario, caseCode, state, actual, problems }) => {
      const flagged = RULE_CODES.filter((code) => actual[code] && actual[code].outcome !== 'pass').map((code) => `${RULE_LABELS[code]}=${OUTCOME_LABELS[actual[code]!.outcome]}`);
      const p = scenario.purchase;
      return [
        scenario.code, SCENARIO_GROUPS[scenario.group], scenario.title, caseCode, scenario.flow === 'blocked' ? 'draft（工具被封鎖）' : state,
        p.applicantName, p.cardholderName, p.cardLastFour, p.payerType === 'representative' ? '代付' : '本人卡', p.invoiceNumber ?? '（未填）',
        p.softwareName, [...scenario.passportTools, ...(scenario.plugin ? [`外掛:${scenario.plugin}`] : [])].join(' + ') || '（無）', p.purchaseDate,
        `${p.originalCurrency === 'OTHER' ? p.otherCurrency : p.originalCurrency} ${p.originalExpense}`, p.convertedTwd,
        state === 'draft' ? '（未送出，無勾稽）' : flagged.join('；') || '全部通過', problems.length === 0 ? 'OK' : `不符：${problems.join('；')}`, scenario.reviewerNote,
      ].map(csvCell).join(',');
    });
    const csvPath = join(reportDir, `demo-passports-${stamp}.csv`);
    writeFileSync(csvPath, `﻿${[header.join(','), ...lines].join('\n')}\n`);
    const jsonPath = join(reportDir, `demo-passports-${stamp}.json`);
    writeFileSync(jsonPath, `${JSON.stringify(results.map(({ scenario, caseCode, state, actual, problems }) => ({ code: scenario.code, group: scenario.group, title: scenario.title, caseCode, state, flow: scenario.flow, expect: scenario.expect, actual, problems })), null, 2)}\n`);

    const failures = results.filter((result) => result.problems.length > 0);
    console.log(`\n百件測試護照：${results.length} 件，驗證不符 ${failures.length} 件${useTestKey ? '（--test-key 模式，管理後台無法解密）' : ''}\n`);
    for (const [key, label] of Object.entries(SCENARIO_GROUPS)) {
      const inGroup = results.filter((result) => result.scenario.group === key);
      const red = inGroup.filter((result) => RULE_CODES.some((code) => result.actual[code] && result.actual[code].outcome !== 'pass')).length;
      console.log(`  ${label.padEnd(12, '　')} ${String(inGroup.length).padStart(3)} 件　有燈號 ${String(red).padStart(3)} 件　驗證不符 ${inGroup.filter((result) => result.problems.length > 0).length} 件`);
    }
    for (const failure of failures) console.log(`\n  ✗ ${failure.scenario.code} ${failure.scenario.title}\n    ${failure.problems.join('\n    ')}`);
    console.log(`\n報表：${csvPath}\n      ${jsonPath}`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

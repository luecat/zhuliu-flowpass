import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../../crypto/field-crypto';
import { appendEncryptedAuditLog } from './audit';
import {
  insertEncryptedAnswerVersionForApplicant,
  insertEncryptedCaseStateTransitionForAdmin,
} from './cases';
import {
  insertEncryptedDocumentFieldForSystem,
  insertEncryptedDocumentForApplicant,
  insertInvoiceFingerprintForSystem,
} from './documents';
import {
  decryptLineSubjectForAdmin,
  findLineIdentityForSystemBySubject,
  insertApplicantWithEncryptedDisplayLabel,
  insertLineIdentityWithEncryptedSubject,
  listLineIdentitiesForApplicant,
} from './identities';
import {
  idempotencyRecordId,
  readEncryptedIdempotencyResponse,
  storeEncryptedIdempotencyResponse,
} from './idempotency';
import { insertPublicNotificationJobForSystem } from './notifications';
import { insertEncryptedPassportVersionForSystem } from './passports';
import { insertEncryptedCaseTaskForAdmin } from './tasks';
import { openDatabase } from '../connection';
import { migrateDatabase } from '../migrate';

const STAMP = '2026-08-30T00:00:00.000Z';
const IDS = {
  applicant: '0198f060-0000-7000-8000-000000000001',
  admin: '0198f060-0000-7000-8000-000000000002',
  identity: '0198f060-0000-7000-8000-000000000003',
  cycle: '0198f060-0000-7000-8000-000000000004',
  rule: '0198f060-0000-7000-8000-000000000005',
  case: '0198f060-0000-7000-8000-000000000006',
  answer: '0198f060-0000-7000-8000-000000000007',
  transition: '0198f060-0000-7000-8000-000000000008',
  passport: '0198f060-0000-7000-8000-000000000009',
  passportVersion: '0198f060-0000-7000-8000-000000000010',
  document: '0198f060-0000-7000-8000-000000000011',
  documentField: '0198f060-0000-7000-8000-000000000012',
  invoiceFingerprint: '0198f060-0000-7000-8000-000000000013',
  task: '0198f060-0000-7000-8000-000000000014',
  notification: '0198f060-0000-7000-8000-000000000015',
  audit: '0198f060-0000-7000-8000-000000000016',
};

const PRIVATE = {
  lineSubject: 'LINE-SUBJECT-PRIVATE-060',
  answer: 'ANSWER-PRIVATE-060',
  passport: 'PASSPORT-PAYLOAD-PRIVATE-060',
  invoice: 'INVOICE-PRIVATE-060',
  filename: 'DOCUMENT-FILENAME-PRIVATE-060.pdf',
  instruction: 'TASK-INSTRUCTION-PRIVATE-060',
  response: 'IDEMPOTENCY-RESPONSE-PRIVATE-060',
};

const applicantScope = { applicantId: IDS.applicant };
const adminScope = { adminId: IDS.admin };
const systemScope = { systemId: 'worker' };

function createFieldCrypto(): FieldCrypto {
  const keyring: Keyring = {
    activeKeyId: 'test-v1',
    getMasterKey(keyId) {
      return keyId === 'test-v1' ? Buffer.alloc(32, 0x60) : undefined;
    },
  };
  return new FieldCrypto(keyring);
}

describe('encrypted repository persistence boundaries', () => {
  let directory: string;
  let database: Database.Database;
  let crypto: FieldCrypto;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'flowpass-sensitive-persistence-'));
    database = openDatabase(join(directory, 'flowpass.sqlite'));
    migrateDatabase(database);
    crypto = createFieldCrypto();

    insertApplicantWithEncryptedDisplayLabel(database, crypto, {
      id: IDS.applicant,
      displayLabel: 'Applicant private label',
      status: 'active',
      createdAt: STAMP,
      updatedAt: STAMP,
      rowVersion: 1,
    });
    database
      .prepare(
        `INSERT INTO admin_users (id, display_name, password_hash, status, created_at, row_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(IDS.admin, 'operator-060', 'password-hash', 'active', STAMP, 1);
    database
      .prepare(
        `INSERT INTO program_cycles (
          id, code, name, year, status, retention_policy_json, created_at, updated_at, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(IDS.cycle, 'CYCLE-060', 'FlowPass', 2026, 'active', '{}', STAMP, STAMP, 1);
    database
      .prepare(
        `INSERT INTO program_rule_versions (
          id, program_cycle_id, version_no, status, subsidy_rate_bps, per_case_cap_twd,
          rounding_mode, required_documents_json, rules_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(IDS.rule, IDS.cycle, 1, 'draft', 5000, 10000, 'floor', '[]', '{}', STAMP);
    database
      .prepare(
        `INSERT INTO cases (
          id, case_code, applicant_id, program_cycle_id, program_rule_version_id, state,
          created_at, updated_at, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(IDS.case, 'CASE-060', IDS.applicant, IDS.cycle, IDS.rule, 'draft', STAMP, STAMP, 1);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('stores all task-owned sensitive values as envelopes/HMACs and keeps applicant projections free of raw LINE identity data', () => {
    insertLineIdentityWithEncryptedSubject(database, crypto, {
      id: IDS.identity,
      applicantId: IDS.applicant,
      lineSubject: PRIVATE.lineSubject,
      linkedAt: STAMP,
      pushState: 'enabled',
      rowVersion: 1,
    });
    insertEncryptedAnswerVersionForApplicant(database, applicantScope, crypto, {
      id: IDS.answer,
      caseId: IDS.case,
      versionNo: 1,
      answers: PRIVATE.answer,
      contentSha256: 'answer-content-hash-060',
      createdAt: STAMP,
    });
    insertEncryptedCaseStateTransitionForAdmin(database, adminScope, crypto, {
      id: IDS.transition,
      caseId: IDS.case,
      sequenceNo: 1,
      fromState: null,
      toState: 'draft',
      reasonCode: 'created',
      reason: PRIVATE.answer,
      actorType: 'admin',
      actorId: IDS.admin,
      createdAt: STAMP,
    });
    database.prepare('INSERT INTO passports (id, case_id, created_at) VALUES (?, ?, ?)').run(
      IDS.passport,
      IDS.case,
      STAMP,
    );
    insertEncryptedPassportVersionForSystem(database, systemScope, crypto, {
      id: IDS.passportVersion,
      passportId: IDS.passport,
      versionNo: 1,
      parentVersionId: null,
      origin: 'ai_draft',
      workflowState: 'confirmed',
      schemaVersion: '1',
      answerVersionId: IDS.answer,
      programRuleVersionId: IDS.rule,
      payload: PRIVATE.passport,
      contentSha256: 'passport-content-hash-060',
      createdByType: 'system',
      createdById: 'worker',
      createdAt: STAMP,
    });
    insertEncryptedDocumentForApplicant(database, applicantScope, crypto, {
      id: IDS.document,
      caseId: IDS.case,
      kind: 'invoice',
      storageId: 'vault-060',
      vaultKeyId: 'vault-v1',
      contentSha256: 'document-content-hash-060',
      mediaType: 'application/pdf',
      byteSize: 123,
      originalName: PRIVATE.filename,
      status: 'ready',
      uploadedByType: 'applicant',
      uploadedById: IDS.applicant,
      createdAt: STAMP,
      rowVersion: 1,
    });
    insertEncryptedDocumentFieldForSystem(database, systemScope, crypto, {
      id: IDS.documentField,
      documentId: IDS.document,
      fieldName: 'invoice_number',
      originalValue: PRIVATE.invoice,
      normalizedValue: PRIVATE.invoice,
      confidence: 0.9,
      sourceOcrRunId: null,
      sourcePage: 1,
      sourceBox: '{"x":1}',
      parserReasonCode: null,
      createdAt: STAMP,
    });
    insertInvoiceFingerprintForSystem(database, systemScope, crypto, {
      id: IDS.invoiceFingerprint,
      documentId: IDS.document,
      caseId: IDS.case,
      normalizedInvoiceValue: PRIVATE.invoice,
      createdAt: STAMP,
    });
    insertEncryptedCaseTaskForAdmin(database, adminScope, crypto, {
      id: IDS.task,
      caseId: IDS.case,
      alertId: null,
      taskType: 'provide_document',
      title: 'Provide invoice',
      instructions: PRIVATE.instruction,
      acceptedDocumentTypesJson: '["invoice"]',
      dueAt: null,
      status: 'open',
      createdByType: 'admin',
      createdById: IDS.admin,
      createdAt: STAMP,
      rowVersion: 1,
    });
    storeEncryptedIdempotencyResponse(database, crypto, {
      scope: `applicant:${IDS.applicant}:POST:/api/v1/cases`,
      key: 'idem-060',
      requestHash: 'request-hash-060',
      responseStatus: 201,
      response: PRIVATE.response,
      expiresAt: '2026-08-31T00:00:00.000Z',
      createdAt: STAMP,
    });
    appendEncryptedAuditLog(database, crypto, {
      id: IDS.audit,
      actorType: 'admin',
      actorId: IDS.admin,
      action: 'case.created',
      entityType: 'case',
      entityId: IDS.case,
      beforeHash: null,
      afterHash: 'after-hash-060',
      detail: { kind: 'operation', operation: 'create', outcome: 'ok' },
      requestId: 'request-060',
      createdAt: STAMP,
    });

    const rawRows = database
      .prepare(
        `SELECT
           (SELECT line_subject_enc FROM line_identities WHERE id = ?) AS line_subject_enc,
           (SELECT line_subject_hmac FROM line_identities WHERE id = ?) AS line_subject_hmac,
           (SELECT answers_enc FROM answer_versions WHERE id = ?) AS answers_enc,
           (SELECT reason_enc FROM case_state_transitions WHERE id = ?) AS reason_enc,
           (SELECT payload_enc FROM passport_versions WHERE id = ?) AS payload_enc,
           (SELECT original_name_enc FROM documents WHERE id = ?) AS original_name_enc,
           (SELECT original_value_enc FROM document_fields WHERE id = ?) AS original_value_enc,
           (SELECT normalized_value_hmac FROM document_fields WHERE id = ?) AS normalized_value_hmac,
           (SELECT fingerprint_hmac FROM invoice_fingerprints WHERE id = ?) AS fingerprint_hmac,
           (SELECT instructions_enc FROM case_tasks WHERE id = ?) AS instructions_enc,
           (SELECT response_enc FROM api_idempotency_keys WHERE scope = ? AND key = ?) AS response_enc,
           (SELECT detail_enc FROM audit_logs WHERE id = ?) AS detail_enc`,
      )
      .get(
        IDS.identity,
        IDS.identity,
        IDS.answer,
        IDS.transition,
        IDS.passportVersion,
        IDS.document,
        IDS.documentField,
        IDS.documentField,
        IDS.invoiceFingerprint,
        IDS.task,
        `applicant:${IDS.applicant}:POST:/api/v1/cases`,
        'idem-060',
        IDS.audit,
      ) as Record<string, string>;
    const serializedRows = JSON.stringify(rawRows);

    for (const sentinel of Object.values(PRIVATE)) {
      expect(serializedRows).not.toContain(sentinel);
    }
    expect(rawRows.line_subject_hmac).toBe(crypto.hmacLookup(PRIVATE.lineSubject, 'line-subject'));
    expect(rawRows.normalized_value_hmac).toBe(
      crypto.hmacLookup(PRIVATE.invoice, 'document-normalized-value'),
    );
    expect(rawRows.fingerprint_hmac).toBe(crypto.hmacLookup(PRIVATE.invoice, 'invoice-fingerprint'));

    const systemLookup = findLineIdentityForSystemBySubject(
      database,
      systemScope,
      crypto,
      PRIVATE.lineSubject,
    );
    expect(systemLookup).toMatchObject({ id: IDS.identity, applicantId: IDS.applicant });
    expect(JSON.stringify(systemLookup)).not.toContain(PRIVATE.lineSubject);
    expect(listLineIdentitiesForApplicant(database, applicantScope)).toEqual([
      expect.objectContaining({ id: IDS.identity, applicantId: IDS.applicant }),
    ]);
    expect(JSON.stringify(listLineIdentitiesForApplicant(database, applicantScope))).not.toContain(
      PRIVATE.lineSubject,
    );
    expect(decryptLineSubjectForAdmin(database, adminScope, crypto, IDS.identity)).toBe(
      PRIVATE.lineSubject,
    );
  });

  it('rejects a notification payload with sensitive content before it reaches public JSON storage', () => {
    expect(() =>
      insertPublicNotificationJobForSystem(database, systemScope, {
        id: IDS.notification,
        caseId: IDS.case,
        taskId: null,
        alertId: null,
        businessKey: 'notification-business-060',
        template: 'task_ready',
        payload: { lineSubject: PRIVATE.lineSubject },
        providerRetryKey: 'provider-retry-060',
        status: 'pending',
        attempts: 0,
        availableAt: STAMP,
        createdAt: STAMP,
      }),
    ).toThrow('Notification payload is not public-safe');
    expect(() =>
      insertPublicNotificationJobForSystem(database, systemScope, {
        id: IDS.notification,
        caseId: IDS.case,
        taskId: null,
        alertId: null,
        businessKey: 'notification-business-060',
        template: 'task_ready',
        payload: { message: PRIVATE.lineSubject },
        providerRetryKey: 'provider-retry-060',
        status: 'pending',
        attempts: 0,
        availableAt: STAMP,
        createdAt: STAMP,
      }),
    ).toThrow('Notification payload is not public-safe');
    expect(() =>
      insertPublicNotificationJobForSystem(database, systemScope, {
        id: IDS.notification,
        caseId: IDS.case,
        taskId: null,
        alertId: null,
        businessKey: 'notification-business-060',
        template: 'task_ready',
        payload: { messageCode: PRIVATE.lineSubject },
        providerRetryKey: 'provider-retry-060',
        status: 'pending',
        attempts: 0,
        availableAt: STAMP,
        createdAt: STAMP,
      }),
    ).toThrow('Notification payload is not public-safe');
  });

  it('rejects raw private values even under an allowed audit-detail key', () => {
    expect(() =>
      appendEncryptedAuditLog(database, crypto, {
        id: IDS.audit,
        actorType: 'admin',
        actorId: IDS.admin,
        action: 'case.created',
        entityType: 'case',
        entityId: IDS.case,
        beforeHash: null,
        afterHash: null,
        detail: { operation: PRIVATE.lineSubject } as never,
        requestId: 'request-060',
        createdAt: STAMP,
      }),
    ).toThrow('Audit detail is not public-safe');
  });

  it('accepts only a bounded discriminated audit detail before encrypting it', () => {
    appendEncryptedAuditLog(database, crypto, {
      id: IDS.audit,
      actorType: 'admin',
      actorId: IDS.admin,
      action: 'case.created',
      entityType: 'case',
      entityId: IDS.case,
      beforeHash: null,
      afterHash: null,
      detail: { kind: 'operation', operation: 'create', outcome: 'ok' },
      requestId: 'request-060',
      createdAt: STAMP,
    });

    const stored = database.prepare('SELECT detail_enc FROM audit_logs WHERE id = ?').get(IDS.audit) as {
      detail_enc: string;
    };
    expect(stored.detail_enc).not.toContain('operation');
  });

  it('rejects private sentinels from every audit-detail string field and invalid counts', () => {
    const unsafeDetails = [
      { kind: 'operation', operation: PRIVATE.lineSubject, outcome: 'ok' },
      { kind: 'operation', operation: 'create', outcome: PRIVATE.answer },
      { kind: 'transition', previousState: PRIVATE.lineSubject, nextState: 'submitted' },
      { kind: 'transition', previousState: 'draft', nextState: PRIVATE.lineSubject },
      {
        kind: 'transition',
        previousState: 'draft',
        nextState: 'submitted',
        reasonCode: PRIVATE.invoice,
      },
      { kind: 'field-change', field: PRIVATE.lineSubject, fieldCount: 1, outcome: 'ok' },
      { kind: 'field-change', field: 'document', fieldCount: 0, outcome: 'ok' },
    ];

    unsafeDetails.forEach((detail, index) => {
      expect(() =>
        appendEncryptedAuditLog(database, crypto, {
          id: `0198f060-0000-7000-8000-${String(30 + index).padStart(12, '0')}`,
          actorType: 'admin',
          actorId: IDS.admin,
          action: 'case.updated',
          entityType: 'case',
          entityId: IDS.case,
          beforeHash: null,
          afterHash: null,
          detail: detail as never,
          requestId: `request-unsafe-audit-${index}`,
          createdAt: STAMP,
        }),
      ).toThrow('Audit detail is not public-safe');
    });
  });

  it('rejects private sentinels from every public notification payload property', () => {
    const safePayload = {
      notificationType: 'task',
      messageCode: 'task_ready',
      locale: 'zh-TW',
      publicPath: '/app/tasks',
    };
    const unsafePayloads = [
      { ...safePayload, notificationType: PRIVATE.lineSubject },
      { ...safePayload, messageCode: PRIVATE.lineSubject },
      { ...safePayload, locale: PRIVATE.lineSubject },
      { ...safePayload, publicPath: PRIVATE.lineSubject },
    ];

    unsafePayloads.forEach((payload, index) => {
      expect(() =>
        insertPublicNotificationJobForSystem(database, systemScope, {
          id: `0198f060-0000-7000-8000-${String(17 + index).padStart(12, '0')}`,
          caseId: IDS.case,
          taskId: null,
          alertId: null,
          businessKey: `notification-business-060-${index}`,
          template: 'task_ready',
          payload,
          providerRetryKey: `provider-retry-060-${index}`,
          status: 'pending',
          attempts: 0,
          availableAt: STAMP,
          createdAt: STAMP,
        }),
      ).toThrow('Notification payload is not public-safe');
    });
  });

  it('stores only the fixed task-ready public notification shape', () => {
    const payload = {
      notificationType: 'task',
      messageCode: 'task_ready',
      locale: 'zh-TW',
      publicPath: '/app/tasks',
    };
    insertPublicNotificationJobForSystem(database, systemScope, {
      id: IDS.notification,
      caseId: IDS.case,
      taskId: null,
      alertId: null,
      businessKey: 'notification-business-public-060',
      template: 'task_ready',
      payload,
      providerRetryKey: 'provider-retry-public-060',
      status: 'pending',
      attempts: 0,
      availableAt: STAMP,
      createdAt: STAMP,
    });

    expect(
      database.prepare('SELECT payload_json FROM notification_jobs WHERE id = ?').get(IDS.notification),
    ).toEqual({ payload_json: JSON.stringify(payload) });
  });

  it('uses an AAD-compatible opaque idempotency record ID and never decrypts expired responses', () => {
    const findCompositeWithLeadingDigest = (prefix: '-' | '_') => {
      for (let index = 0; index < 10_000; index += 1) {
        const scope = `scope-${prefix}-${index}`;
        const key = `key-${index}`;
        const digest = createHash('sha256')
          .update(scope, 'utf8')
          .update('\0')
          .update(key, 'utf8')
          .digest('base64url');
        if (digest.startsWith(prefix)) {
          return { scope, key, digest };
        }
      }
      throw new Error(`no ${prefix} fixture found`);
    };

    for (const prefix of ['-', '_'] as const) {
      const { scope, key, digest } = findCompositeWithLeadingDigest(prefix);
      expect(digest.startsWith(prefix)).toBe(true);
      expect(idempotencyRecordId(scope, key)).toMatch(/^idem_[A-Za-z0-9_-]{43}$/);
      storeEncryptedIdempotencyResponse(database, crypto, {
        scope,
        key,
        requestHash: `request-hash-leading-${prefix}`,
        responseStatus: 201,
        response: `idempotency-response-leading-${prefix}`,
        expiresAt: '2026-08-31T00:00:00.000Z',
        createdAt: STAMP,
      });
      expect(readEncryptedIdempotencyResponse(database, crypto, scope, key, STAMP)).toMatchObject({
        requestHash: `request-hash-leading-${prefix}`,
        responseStatus: 201,
      });
    }

    const scope = 'expired-idempotency-scope';
    const key = 'expired-idempotency-key';
    storeEncryptedIdempotencyResponse(database, crypto, {
      scope,
      key,
      requestHash: 'expired-request-hash',
      responseStatus: 201,
      response: PRIVATE.response,
      expiresAt: STAMP,
      createdAt: STAMP,
    });

    database
      .prepare('UPDATE api_idempotency_keys SET response_enc = ? WHERE scope = ? AND key = ?')
      .run('not-an-envelope', scope, key);
    expect(readEncryptedIdempotencyResponse(database, crypto, scope, key, STAMP)).toBeNull();

    storeEncryptedIdempotencyResponse(database, crypto, {
      scope,
      key,
      requestHash: 'replacement-request-hash',
      responseStatus: 200,
      response: 'replacement-idempotency-response',
      expiresAt: '2026-08-31T00:00:00.000Z',
      createdAt: '2026-08-30T00:00:00.001Z',
    });

    expect(
      readEncryptedIdempotencyResponse(
        database,
        crypto,
        scope,
        key,
        '2026-08-30T00:00:00.001Z',
      ),
    ).toMatchObject({ requestHash: 'replacement-request-hash', responseStatus: 200 });
  });
});

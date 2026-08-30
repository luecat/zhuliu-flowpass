import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldCrypto, type Keyring } from '../crypto/field-crypto';
import { hashToken } from '../crypto/token-hash';
import { openDatabase } from '../db/connection';
import { migrateDatabase } from '../db/migrate';
import { createSessionRepository } from '../db/repositories/sessions';
import { SessionService, createSessionCookiePolicy } from './session-service';

const START = '2026-08-30T00:00:00.000Z';
const APPLICANT_ID = '0198f050-0000-7000-8000-000000000001';
const ADMIN_ID = '0198f050-0000-7000-8000-000000000002';

class FakeClock {
  private instant = new Date(START);

  now = (): Date => new Date(this.instant.getTime());

  advance(minutes: number): void {
    this.instant = new Date(this.instant.getTime() + minutes * 60_000);
  }
}

class SequenceClock {
  private index = 0;

  constructor(private readonly instants: readonly string[]) {}

  now = (): Date => {
    const instant = this.instants[Math.min(this.index, this.instants.length - 1)];
    this.index += 1;
    return new Date(instant);
  };
}

function createIdGenerator(): () => string {
  let sequence = 100;
  return () => `0198f050-0000-7000-8000-${String(sequence++).padStart(12, '0')}`;
}

function createTokenFactory(): () => string {
  let sequence = 1;
  return () => Buffer.alloc(32, sequence++).toString('base64url');
}

function createFieldCrypto(): FieldCrypto {
  const keyring: Keyring = {
    activeKeyId: 'test-v1',
    getMasterKey(keyId) {
      return keyId === 'test-v1' ? Buffer.alloc(32, 0x44) : undefined;
    },
  };
  return new FieldCrypto(keyring);
}

describe('SessionService', () => {
  let directory: string;
  let database: Database.Database;
  let clock: FakeClock;
  let service: SessionService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'flowpass-session-service-'));
    database = openDatabase(join(directory, 'flowpass.sqlite'));
    migrateDatabase(database);
    database
      .prepare(
        `INSERT INTO applicants (id, display_label_enc, status, created_at, updated_at, row_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(APPLICANT_ID, 'existing-envelope', 'active', START, START, 1);
    database
      .prepare(
        `INSERT INTO admin_users (id, display_name, password_hash, status, created_at, row_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ADMIN_ID, 'operator', 'stored-password-hash', 'active', START, 1);

    clock = new FakeClock();
    const fieldCrypto = createFieldCrypto();
    service = new SessionService({
      repository: createSessionRepository(database),
      clock: clock.now,
      idGenerator: createIdGenerator(),
      tokenFactory: createTokenFactory(),
      ipHasher: (value) => fieldCrypto.hmacLookup(value, 'applicant-session-ip'),
    });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('persists only hashes for separately issued applicant and admin session/CSRF secrets', () => {
    const applicant = service.issueApplicant({ applicantId: APPLICANT_ID, createdIp: '203.0.113.41' });
    const admin = service.issueAdmin({ adminUserId: ADMIN_ID });
    const applicantRow = database
      .prepare('SELECT token_hash, csrf_secret_hash, created_ip_hmac FROM applicant_sessions WHERE id = ?')
      .get(applicant.sessionId) as Record<string, string>;
    const adminRow = database
      .prepare('SELECT token_hash, csrf_secret_hash FROM admin_sessions WHERE id = ?')
      .get(admin.sessionId) as Record<string, string>;

    expect(applicant.sessionToken).not.toBe(applicant.csrfToken);
    expect(admin.sessionToken).not.toBe(admin.csrfToken);
    expect(applicantRow.token_hash).toBe(hashToken(applicant.sessionToken));
    expect(applicantRow.csrf_secret_hash).toBe(hashToken(applicant.csrfToken));
    expect(adminRow.token_hash).toBe(hashToken(admin.sessionToken));
    expect(JSON.stringify({ applicantRow, adminRow })).not.toContain(applicant.sessionToken);
    expect(JSON.stringify({ applicantRow, adminRow })).not.toContain(applicant.csrfToken);
    expect(JSON.stringify({ applicantRow, adminRow })).not.toContain('203.0.113.41');
    expect(JSON.stringify(applicant)).not.toContain(applicant.sessionToken);
    expect(JSON.stringify(applicant)).not.toContain(applicant.csrfToken);
  });

  it('applies 30-minute applicant and 15-minute admin idle expiry under a fixed eight-hour absolute cap', () => {
    const applicant = service.issueApplicant({ applicantId: APPLICANT_ID });
    const admin = service.issueAdmin({ adminUserId: ADMIN_ID });

    expect(applicant.expiresAt).toBe('2026-08-30T00:30:00.000Z');
    expect(admin.expiresAt).toBe('2026-08-30T00:15:00.000Z');
    expect(
      database
        .prepare('SELECT absolute_expires_at FROM applicant_sessions WHERE id = ?')
        .get(applicant.sessionId),
    ).toEqual({ absolute_expires_at: '2026-08-30T08:00:00.000Z' });
    expect(
      database.prepare('SELECT absolute_expires_at FROM admin_sessions WHERE id = ?').get(admin.sessionId),
    ).toEqual({ absolute_expires_at: '2026-08-30T08:00:00.000Z' });
  });

  it('slides valid applicant idle expiry without reviving a boundary-expired session or extending absolute expiry', () => {
    const applicant = service.issueApplicant({ applicantId: APPLICANT_ID });

    for (let count = 0; count < 16; count += 1) {
      clock.advance(29);
      expect(service.authenticateApplicant(applicant.sessionToken)).toMatchObject({
        sessionId: applicant.sessionId,
        applicantId: APPLICANT_ID,
      });
    }

    expect(
      database.prepare('SELECT idle_expires_at FROM applicant_sessions WHERE id = ?').get(applicant.sessionId),
    ).toEqual({ idle_expires_at: '2026-08-30T08:00:00.000Z' });
    clock.advance(16);
    expect(service.authenticateApplicant(applicant.sessionToken)).toBeNull();

    const boundary = service.issueApplicant({ applicantId: APPLICANT_ID });
    clock.advance(30);
    expect(service.authenticateApplicant(boundary.sessionToken)).toBeNull();
  });

  it('keeps applicant and admin authentication separate and rejects malformed, expired, or revoked cookies', () => {
    const applicant = service.issueApplicant({ applicantId: APPLICANT_ID });
    const admin = service.issueAdmin({ adminUserId: ADMIN_ID });

    expect(service.authenticateApplicant(admin.sessionToken)).toBeNull();
    expect(service.authenticateAdmin(applicant.sessionToken)).toBeNull();
    expect(service.authenticateApplicant('not-a-cookie-token')).toBeNull();

    service.revokeApplicant(applicant.sessionToken);
    service.revokeAdmin(admin.sessionToken);
    expect(service.authenticateApplicant(applicant.sessionToken)).toBeNull();
    expect(service.authenticateAdmin(admin.sessionToken)).toBeNull();
  });

  it('rotates an applicant session in one repository transaction so the old cookie stops working before the new cookie is returned', () => {
    const original = service.issueApplicant({ applicantId: APPLICANT_ID });
    const replacement = service.rotateApplicant(original.sessionToken);
    const originalAdmin = service.issueAdmin({ adminUserId: ADMIN_ID });
    const replacementAdmin = service.rotateAdmin(originalAdmin.sessionToken);

    expect(replacement).not.toBeNull();
    expect(service.authenticateApplicant(original.sessionToken)).toBeNull();
    expect(service.authenticateApplicant(replacement?.sessionToken ?? '')).toMatchObject({
      applicantId: APPLICANT_ID,
    });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM applicant_sessions WHERE revoked_at IS NULL').get(),
    ).toEqual({ count: 1 });
    expect(
      database.prepare('SELECT revoked_at FROM applicant_sessions WHERE id = ?').get(original.sessionId),
    ).toEqual({ revoked_at: START });
    expect(service.authenticateAdmin(originalAdmin.sessionToken)).toBeNull();
    expect(service.authenticateAdmin(replacementAdmin?.sessionToken ?? '')).toMatchObject({
      adminUserId: ADMIN_ID,
      reauthenticatedAt: null,
    });
  });

  it('does not revoke applicant or admin sessions when rotation reaches absolute expiry between validation and replacement', () => {
    const applicant = service.issueApplicant({ applicantId: APPLICANT_ID });
    const admin = service.issueAdmin({ adminUserId: ADMIN_ID });
    const absoluteBoundary = '2026-08-30T08:00:00.000Z';
    database
      .prepare('UPDATE applicant_sessions SET idle_expires_at = ?, last_seen_at = ? WHERE id = ?')
      .run(absoluteBoundary, '2026-08-30T07:59:00.000Z', applicant.sessionId);
    database
      .prepare('UPDATE admin_sessions SET idle_expires_at = ?, last_seen_at = ? WHERE id = ?')
      .run(absoluteBoundary, '2026-08-30T07:59:00.000Z', admin.sessionId);
    const boundaryClock = new SequenceClock([
      '2026-08-30T07:59:59.999Z',
      '2026-08-30T08:00:00.000Z',
      '2026-08-30T07:59:59.999Z',
      '2026-08-30T08:00:00.000Z',
    ]);
    let boundaryId = 900;
    let boundaryToken = 90;
    const boundaryService = new SessionService({
      repository: createSessionRepository(database),
      clock: boundaryClock.now,
      idGenerator: () => `0198f050-0000-7000-8000-${String(boundaryId++).padStart(12, '0')}`,
      tokenFactory: () => Buffer.alloc(32, boundaryToken++).toString('base64url'),
    });

    expect(boundaryService.rotateApplicant(applicant.sessionToken)).toBeNull();
    expect(boundaryService.rotateAdmin(admin.sessionToken)).toBeNull();
    expect(
      database.prepare('SELECT revoked_at FROM applicant_sessions WHERE id = ?').get(applicant.sessionId),
    ).toEqual({ revoked_at: null });
    expect(
      database.prepare('SELECT revoked_at FROM admin_sessions WHERE id = ?').get(admin.sessionId),
    ).toEqual({ revoked_at: null });
  });

  it('does not use a stale pre-replacement time if synchronous token or ID work reaches the absolute deadline', () => {
    const applicant = service.issueApplicant({ applicantId: APPLICANT_ID });
    const admin = service.issueAdmin({ adminUserId: ADMIN_ID });
    const absoluteBoundary = '2026-08-30T08:00:00.000Z';
    database
      .prepare('UPDATE applicant_sessions SET idle_expires_at = ? WHERE id = ?')
      .run(absoluteBoundary, applicant.sessionId);
    database
      .prepare('UPDATE admin_sessions SET idle_expires_at = ? WHERE id = ?')
      .run(absoluteBoundary, admin.sessionId);

    let instant = '2026-08-30T07:59:59.999Z';
    let nextId = 950;
    let nextToken = 120;
    const boundaryService = new SessionService({
      repository: createSessionRepository(database),
      clock: () => new Date(instant),
      idGenerator: () => {
        instant = absoluteBoundary;
        return `0198f050-0000-7000-8000-${String(nextId++).padStart(12, '0')}`;
      },
      tokenFactory: () => Buffer.alloc(32, nextToken++).toString('base64url'),
    });

    expect(boundaryService.rotateApplicant(applicant.sessionToken)).toBeNull();
    expect(
      database.prepare('SELECT revoked_at FROM applicant_sessions WHERE id = ?').get(applicant.sessionId),
    ).toEqual({ revoked_at: null });

    instant = '2026-08-30T07:59:59.999Z';
    expect(boundaryService.rotateAdmin(admin.sessionToken)).toBeNull();
    expect(
      database.prepare('SELECT revoked_at FROM admin_sessions WHERE id = ?').get(admin.sessionId),
    ).toEqual({ revoked_at: null });
  });

  it('requires a valid session, matching double-submit values, and the persisted CSRF hash', () => {
    const applicant = service.issueApplicant({ applicantId: APPLICANT_ID });
    const admin = service.issueAdmin({ adminUserId: ADMIN_ID });

    expect(
      service.verifyApplicantCsrf({
        sessionToken: applicant.sessionToken,
        csrfCookie: applicant.csrfToken,
        csrfHeader: applicant.csrfToken,
      }),
    ).toMatchObject({ applicantId: APPLICANT_ID });
    expect(
      service.verifyApplicantCsrf({
        sessionToken: applicant.sessionToken,
        csrfCookie: applicant.csrfToken,
        csrfHeader: admin.csrfToken,
      }),
    ).toBeNull();
    expect(
      service.verifyAdminCsrf({
        sessionToken: admin.sessionToken,
        csrfCookie: admin.csrfToken,
        csrfHeader: admin.csrfToken,
      }),
    ).toMatchObject({ adminUserId: ADMIN_ID, reauthenticatedAt: null });
  });

  it('consumes a login exchange nonce only once and only at its exact persisted origin', () => {
    const repository = createSessionRepository(database);
    const rawNonce = Buffer.alloc(32, 0x65).toString('base64url');
    const nonceHash = hashToken(rawNonce);
    repository.insertLoginExchangeNonce({
      id: '0198f050-0000-7000-8000-000000000099',
      nonceHash,
      origin: 'https://flowpass.luecat.com',
      issuedAt: START,
      expiresAt: '2026-08-30T00:05:00.000Z',
    });

    expect(
      repository.consumeLoginExchangeNonce(
        nonceHash,
        'https://other-origin.example',
        START,
      ),
    ).toBe(false);
    expect(repository.consumeLoginExchangeNonce(nonceHash, 'https://flowpass.luecat.com', START)).toBe(
      true,
    );
    expect(repository.consumeLoginExchangeNonce(nonceHash, 'https://flowpass.luecat.com', START)).toBe(
      false,
    );
  });

  it('uses explicit, origin-bound cookie policies instead of implicit development-mode insecure cookies', () => {
    const publicProduction = createSessionCookiePolicy({
      kind: 'applicant',
      origin: 'https://flowpass.luecat.com',
    });
    const publicTest = createSessionCookiePolicy({
      kind: 'applicant',
      origin: 'http://127.0.0.1:38100',
      allowInsecureLoopbackTest: true,
    });
    const adminLocal = createSessionCookiePolicy({
      kind: 'admin',
      origin: 'http://127.0.0.1:38101',
    });

    expect(publicProduction.session).toEqual({
      name: 'flowpass_session',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    });
    expect(publicProduction.csrf).toEqual({
      name: 'flowpass_csrf',
      httpOnly: false,
      sameSite: 'lax',
      secure: true,
      path: '/',
    });
    expect(publicTest.session.secure).toBe(false);
    expect(adminLocal.session).toEqual({
      name: 'flowpass_admin_session',
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      path: '/',
    });
    expect(() =>
      createSessionCookiePolicy({ kind: 'applicant', origin: 'http://127.0.0.1:38100' }),
    ).toThrow('Insecure applicant cookie origin is not allowed');
    expect(() =>
      createSessionCookiePolicy({
        kind: 'applicant',
        origin: 'https://flowpass.luecat.com/untrusted-path',
      }),
    ).toThrow('Session cookie origin is invalid');
    expect(() =>
      createSessionCookiePolicy({
        kind: 'applicant',
        origin: 'http://localhost:38100',
        allowInsecureLoopbackTest: true,
      }),
    ).toThrow('Insecure applicant cookie origin is not allowed');
    expect(() =>
      createSessionCookiePolicy({ kind: 'admin', origin: 'http://example.test:38101' }),
    ).toThrow('Insecure admin cookie origin is not allowed');
    expect(() =>
      createSessionCookiePolicy({ kind: 'admin', origin: 'http://127.0.0.1:38102' }),
    ).toThrow('Insecure admin cookie origin is not allowed');
  });
});

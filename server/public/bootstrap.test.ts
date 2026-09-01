import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecretProvider, SecretRef } from '../config/keychain';
import { openMigratedDatabase, type FlowPassDatabase } from '../db/connection';
import { createPublicRuntime } from './bootstrap';

class TestSecrets implements SecretProvider {
  readonly requests: SecretRef[] = [];

  constructor(private readonly values: Record<string, string>) {}

  async get(ref: SecretRef): Promise<string> {
    this.requests.push(ref);
    const value = this.values[`${ref.service}/${ref.account}`];
    if (!value) throw new Error('missing test secret');
    return value;
  }

  async has(ref: SecretRef): Promise<boolean> {
    return `${ref.service}/${ref.account}` in this.values;
  }
}

describe('public runtime bootstrap', () => {
  let database: FlowPassDatabase | undefined;
  let root: string | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('composes the public runtime from encrypted local persistence and Keychain refs', async () => {
    root = mkdtempSync(join(tmpdir(), 'flowpass-bootstrap-'));
    database = openMigratedDatabase(join(root, 'flowpass.sqlite3'));
    const masterKey = randomBytes(32).toString('base64url');
    const provider = new TestSecrets({
      'FlowPass/flowpass-master-key': masterKey,
      'FlowPass/line-channel-secret': 'line-secret-for-test',
    });

    const runtime = await createPublicRuntime({ database, provider });

    expect(runtime.publicOrigin).toBe('https://flowpass.luecat.com');
    expect(runtime.lineChannelSecret).toBe('line-secret-for-test');
    expect(runtime.lineSessions.getApplicantCookieNames()).toEqual({
      session: 'flowpass_session',
      csrf: 'flowpass_csrf',
      bootstrap: '__Host-flowpass_login_bootstrap',
    });
    expect(provider.requests.map((ref) => ref.account)).toEqual(
      expect.arrayContaining(['flowpass-master-key', 'line-channel-secret']),
    );
  });

  it('keeps the LIFF applicant flow available when webhook secret setup is pending', async () => {
    root = mkdtempSync(join(tmpdir(), 'flowpass-bootstrap-'));
    database = openMigratedDatabase(join(root, 'flowpass.sqlite3'));
    const provider = new TestSecrets({
      'FlowPass/flowpass-master-key': randomBytes(32).toString('base64url'),
    });

    const runtime = await createPublicRuntime({ database, provider });
    expect(runtime.lineChannelSecret).toBeUndefined();
  });
});

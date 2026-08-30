import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { redactForLogs } from './redact';

const SECRETS = {
  authorization: 'Bearer authorization-private-token',
  cookie: 'flowpass_session=cookie-private-token',
  lineSubject: 'U-line-subject-private',
  invoice: 'INV-PRIVATE-2026-9988',
  prompt: 'ORIGINAL-PROMPT-PRIVATE',
  session: 'session-private-token',
  csrf: 'csrf-private-token',
  key: 'master-key-private',
  nonce: 'nonce-private-value',
  envelope: 'envelope-plaintext-private',
  document: 'document-private-bytes',
};

describe('central log redactor', () => {
  it('recursively removes sensitive headers, identity data, prompt/invoice values, tokens, and binary document values', () => {
    const circular: Record<string, unknown> = { invoiceNumber: SECRETS.invoice };
    circular.self = circular;
    const error = new Error(`Authorization: ${SECRETS.authorization}`);
    Object.assign(error, {
      cause: {
        originalPrompt: SECRETS.prompt,
        headers: { Cookie: SECRETS.cookie },
      },
      login_exchange_nonce: SECRETS.nonce,
      envelope_plaintext: SECRETS.envelope,
    });

    const redacted = redactForLogs({
      headers: {
        Authorization: SECRETS.authorization,
        Cookie: SECRETS.cookie,
        'Set-Cookie': SECRETS.cookie,
      },
      request: {
        lineSubject: SECRETS.lineSubject,
        invoice_number: SECRETS.invoice,
        original_prompt: SECRETS.prompt,
        sessionToken: SECRETS.session,
        csrfToken: SECRETS.csrf,
        masterKey: SECRETS.key,
        envelopePlaintext: SECRETS.envelope,
        login_exchange_nonce: SECRETS.nonce,
        envelope_plaintext: SECRETS.envelope,
        documentBytes: Buffer.from(SECRETS.document),
      },
      nested: [new Uint8Array([1, 2, 3]), { idToken: SECRETS.authorization }],
      error,
      circular,
    });
    const serialized = JSON.stringify(redacted);

    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('[REDACTED_BINARY]');
    expect(serialized).toContain('[Circular]');
  });

  it('redacts sensitive values embedded in error messages without invoking unsafe object serialization', () => {
    const messageSecret = 'message-private-token';
    const redacted = redactForLogs(
      new Error(`Cookie: flowpass_session=${messageSecret}; Bearer ${messageSecret}`),
    );
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(messageSecret);
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts snake_case secrets and raw envelope-shaped errors', () => {
    const messageSecrets = {
      lineSubject: 'line-subject-in-snake-error',
      invoice: 'invoice-in-snake-error',
      prompt: 'prompt-in-snake-error',
      sourceExcerpt: 'source-excerpt-in-snake-error',
      password: 'password-in-snake-error',
      secret: 'secret-in-snake-error',
      privateKey: 'private-key-in-snake-error',
      encryptionKey: 'encryption-key-in-snake-error',
      secretKey: 'secret-key-in-snake-error',
      keyMaterial: 'key-material-in-snake-error',
      keychainValue: 'keychain-value-in-snake-error',
      apiToken: 'api-token-in-snake-error',
      session: 'session-token-in-snake-error',
      nonce: 'nonce-in-snake-error',
    };
    const envelope = {
      version: 1,
      keyId: 'key-id-for-error',
      nonce: messageSecrets.nonce,
      ciphertext: 'ciphertext-in-error',
      tag: 'tag-in-error',
    };
    const redacted = redactForLogs({
      error: new Error(
        `line_subject=${messageSecrets.lineSubject}; invoice_number=${messageSecrets.invoice}; original_prompt=${messageSecrets.prompt}; source_excerpt=${messageSecrets.sourceExcerpt}; password=${messageSecrets.password}; secret=${messageSecrets.secret}; private_key=${messageSecrets.privateKey}; encryption_key=${messageSecrets.encryptionKey}; secret_key=${messageSecrets.secretKey}; key_material=${messageSecrets.keyMaterial}; keychain_value=${messageSecrets.keychainValue}; api_token=${messageSecrets.apiToken}; session_token=${messageSecrets.session}; nonce=${messageSecrets.nonce}`,
      ),
      metadata: envelope,
    });
    const serialized = JSON.stringify(redacted);

    for (const secret of [...Object.values(messageSecrets), envelope.ciphertext, envelope.tag]) {
      expect(serialized).not.toContain(secret);
    }
    expect((redacted as { metadata: unknown }).metadata).toBe('[REDACTED]');
  });
});

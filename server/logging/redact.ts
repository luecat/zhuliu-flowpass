const REDACTED = '[REDACTED]';
const REDACTED_BINARY = '[REDACTED_BINARY]';
const CIRCULAR = '[Circular]';
const UNREADABLE = '[UNREADABLE]';

const SENSITIVE_KEY_PATTERN =
  /(authorization|set[-_]?cookie|cookie|(?:id|session|csrf|access|refresh|task)?[-_]?token|line[-_]?subject|invoice|prompt|master[-_]?key|(?:encryption|secret|private)?[-_]?key|envelope|nonce|ciphertext|tag|source[-_]?excerpt|document[-_]?(bytes|data|content)|raw[-_]?document|password|secret)/i;
const SENSITIVE_MESSAGE_PATTERN =
  /(?:authorization|set[-_\s]*cookie|cookie|line[-_\s]*subject|invoice(?:[-_\s]*number)?|original[-_\s]*prompt|source[-_\s]*excerpt|(?:id|session|csrf|access|refresh|task|api)[-_\s]*token|(?:master(?:[-_\s]*encryption)?|private|encryption|secret)[-_\s]*key|key[-_\s]*material|keychain[-_\s]*value|password|secret|envelope(?:[-_\s]*plaintext)?|nonce|ciphertext|tag|document[-_\s]*(?:bytes|data|content))\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ENCRYPTED_FIELD_KEYS = ['ciphertext', 'keyId', 'nonce', 'tag', 'version'];

function redactMessage(value: string): string {
  return value
    .replace(SENSITIVE_MESSAGE_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, REDACTED);
}

function redactError(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: error.name,
    message: redactMessage(error.message),
  };

  if ('cause' in error) {
    try {
      output.cause = redactValue((error as Error & { cause?: unknown }).cause, seen);
    } catch {
      output.cause = UNREADABLE;
    }
  }

  for (const [key, value] of Object.entries(error)) {
    if (key === 'cause') {
      continue;
    }
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(value, seen);
  }

  return output;
}

function isEncryptedFieldShape(value: object): boolean {
  try {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return (
      keys.length === ENCRYPTED_FIELD_KEYS.length &&
      keys.every((key, index) => key === ENCRYPTED_FIELD_KEYS[index]) &&
      record.version === 1 &&
      typeof record.keyId === 'string' &&
      typeof record.nonce === 'string' &&
      typeof record.ciphertext === 'string' &&
      typeof record.tag === 'string'
    );
  } catch {
    return false;
  }
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return redactMessage(value);
  }
  if (typeof value === 'undefined') {
    return '[undefined]';
  }
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return '[unsupported]';
  }
  if (value instanceof Uint8Array) {
    return REDACTED_BINARY;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  }
  if (typeof value !== 'object') {
    return REDACTED;
  }
  if (isEncryptedFieldShape(value)) {
    return REDACTED;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);

  if (value instanceof Error) {
    return redactError(value, seen);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen));
  }

  const output: Record<string, unknown> = {};
  try {
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(entry, seen);
    }
  } catch {
    return UNREADABLE;
  }
  return output;
}

/**
 * Converts arbitrary server-side diagnostic input into a serialization-safe structure.
 * It intentionally returns plain data so callers can hand it to any logger without
 * relying on that logger to understand cookies, tokens, buffers, or circular objects.
 */
export function redactForLogs(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

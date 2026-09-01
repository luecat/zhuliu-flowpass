import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const CURRENT_PREFIX = 'scrypt-v2';
const CURRENT_PARAMS = { N: 131_072, r: 8, p: 1 } as const;
const LEGACY_PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const MAX_MEMORY = 256 * 1024 * 1024;

export interface AdminPasswordIdentity {
  username?: string;
  recoveryEmail?: string;
}

export interface AdminPasswordValidation {
  valid: boolean;
  errors: string[];
}

function derive(password: string, salt: Buffer, length: number, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { ...params, maxmem: MAX_MEMORY }, (error, key) => error ? reject(error) : resolve(key));
  });
}

function identityFragments(identity: AdminPasswordIdentity): string[] {
  const username = identity.username?.trim().toLowerCase() ?? '';
  const email = identity.recoveryEmail?.trim().toLowerCase() ?? '';
  return [...new Set([username, email, ...email.split(/[@._+-]/u)].filter((value) => value.length >= 4))];
}

export function validateAdminPassword(password: string, identity: AdminPasswordIdentity = {}): AdminPasswordValidation {
  const errors: string[] = [];
  const length = typeof password === 'string' ? [...password].length : 0;
  if (length < 8 || length > 128) errors.push('length');
  if (!/[A-Z]/u.test(password)) errors.push('uppercase');
  if (!/[a-z]/u.test(password)) errors.push('lowercase');
  if (!/[0-9]/u.test(password)) errors.push('digit');
  if (!/[^A-Za-z0-9]/u.test(password)) errors.push('symbol');
  const lower = password.toLowerCase();
  if (identityFragments(identity).some((fragment) => lower.includes(fragment))) errors.push('identity');
  if (/^(?:password|changeme|qwerty|adminadmin)/iu.test(password.replaceAll(/\s/gu, ''))) errors.push('common');
  return { valid: errors.length === 0, errors };
}

async function encodePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await derive(password, salt, 32, CURRENT_PARAMS);
  return `${CURRENT_PREFIX}$${CURRENT_PARAMS.N}$${CURRENT_PARAMS.r}$${CURRENT_PARAMS.p}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

export async function hashAdminPassword(password: string, identity: AdminPasswordIdentity = {}): Promise<string> {
  const validation = validateAdminPassword(password, identity);
  if (!validation.valid) throw new Error(`admin password policy failed: ${validation.errors.join(',')}`);
  return encodePassword(password);
}

export function hashBootstrapAdminPassword(password: 'admin'): Promise<string> {
  return encodePassword(password);
}

export async function verifyAdminPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const fields = encoded.split('$');
    let params: { N: number; r: number; p: number };
    let saltValue: string;
    let hashValue: string;
    if (fields[0] === CURRENT_PREFIX && fields.length === 6) {
      params = { N: Number(fields[1]), r: Number(fields[2]), p: Number(fields[3]) };
      if (params.N !== CURRENT_PARAMS.N || params.r !== CURRENT_PARAMS.r || params.p !== CURRENT_PARAMS.p) return false;
      saltValue = fields[4]!;
      hashValue = fields[5]!;
    } else if (fields[0] === 'scrypt-v1' && fields.length === 3) {
      params = LEGACY_PARAMS;
      saltValue = fields[1]!;
      hashValue = fields[2]!;
    } else {
      return false;
    }
    const expected = Buffer.from(hashValue, 'base64url');
    if (expected.length < 16 || expected.length > 64) return false;
    const actual = await derive(password, Buffer.from(saltValue, 'base64url'), expected.length, params);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

import { describe, expect, it } from 'vitest';
import { hashAdminPassword, validateAdminPassword, verifyAdminPassword } from './password';
const identity = { username: 'admin', recoveryEmail: 'daniel0104.sung@gmail.com' };
describe('admin password', () => {
  it('enforces literal policy boundaries', () => {
    expect(validateAdminPassword('Aa1!aaaa', identity)).toEqual({ valid: true, errors: [] });
    for (const [password, error] of [['aa1!aaaa','uppercase'],['AA1!AAAA','lowercase'],['Aa!!aaaa','digit'],['Aa11aaaa','symbol'],['Aa1!aaa','length']]) expect(validateAdminPassword(password, identity).errors).toContain(error);
  });
  it('rejects username and recovery-email fragments', () => {
    for (const password of ['xxADMINxxA1!', 'Daniel0104A1!', 'SungA1!xxxx']) expect(validateAdminPassword(password, identity).errors).toContain('identity');
  });
  it('uses a versioned salted scrypt hash', async () => {
    const encoded = await hashAdminPassword('Aa1!aaaa');
    expect(encoded).toMatch(/^scrypt-v2\$131072\$8\$1\$/);
    await expect(verifyAdminPassword('Aa1!aaaa', encoded)).resolves.toBe(true);
    await expect(verifyAdminPassword('wrong', encoded)).resolves.toBe(false);
  });
});

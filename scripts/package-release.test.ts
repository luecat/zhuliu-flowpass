import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packageRelease } from './package-release';

describe('packageRelease', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('creates an immutable release, manifest and atomic current pointer', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'flowpass-package-project-')); const releaseRoot = mkdtempSync(join(tmpdir(), 'flowpass-package-release-')); roots.push(projectRoot, releaseRoot);
    mkdirSync(join(projectRoot, '.next', 'standalone'), { recursive: true }); mkdirSync(join(projectRoot, '.next', 'static'), { recursive: true }); mkdirSync(join(projectRoot, 'public'), { recursive: true }); mkdirSync(join(projectRoot, 'dist', 'admin', 'assets'), { recursive: true }); mkdirSync(join(projectRoot, 'dist', 'server', 'migrations'), { recursive: true }); mkdirSync(join(projectRoot, 'node_modules', 'better-sqlite3'), { recursive: true }); mkdirSync(join(projectRoot, 'runtime'), { recursive: true });
    writeFileSync(join(projectRoot, '.next', 'BUILD_ID'), 'build-123'); writeFileSync(join(projectRoot, '.next', 'standalone', 'server.js'), 'public'); writeFileSync(join(projectRoot, 'dist', 'admin', 'index.html'), '<script src="/assets/admin.js"></script>'); writeFileSync(join(projectRoot, 'dist', 'admin', 'assets', 'admin.js'), 'admin'); writeFileSync(join(projectRoot, 'dist', 'server', 'admin.mjs'), 'server'); writeFileSync(join(projectRoot, 'dist', 'server', 'migrations', '001_core.sql'), 'SELECT 1;'); writeFileSync(join(projectRoot, 'dist', 'server', 'migrations', '004_admin_security.sql'), 'ALTER TABLE admin_users ADD COLUMN must_change_password INTEGER;'); writeFileSync(join(projectRoot, 'dist', 'server', 'migrations', '005_attachment_details.sql'), 'ALTER TABLE documents ADD COLUMN requirement_key TEXT;'); writeFileSync(join(projectRoot, 'node_modules', 'better-sqlite3', 'package.json'), '{}'); writeFileSync(join(projectRoot, 'runtime', 'cloudflared-flowpass.yml'), 'tunnel: fixture'); writeFileSync(join(projectRoot, 'package-lock.json'), '{}');
    const result = packageRelease({ projectRoot, releaseRoot, releaseId: '20260831000100' });
    expect(readFileSync(join(result.releaseDir, 'public', 'server.js'), 'utf8')).toBe('public');
    expect(readFileSync(join(result.releaseDir, 'admin', 'index.html'), 'utf8')).toContain('admin.js');
    expect(readFileSync(join(result.releaseDir, 'admin', 'assets', 'admin.js'), 'utf8')).toBe('admin');
    expect(readFileSync(join(result.releaseDir, 'server', 'admin.mjs'), 'utf8')).toBe('server');
    expect(readFileSync(join(result.releaseDir, 'server', 'migrations', '001_core.sql'), 'utf8')).toBe('SELECT 1;');
    expect(readFileSync(join(result.releaseDir, 'server', 'migrations', '004_admin_security.sql'), 'utf8')).toContain('must_change_password');
    expect(readFileSync(join(result.releaseDir, 'runtime', 'cloudflared-flowpass.yml'), 'utf8')).toContain('fixture');
    expect(readFileSync(join(result.releaseDir, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8')).toBe('{}');
    expect(lstatSync(join(result.releaseDir, 'runtime')).isDirectory()).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8')) as { format: string; buildId: string; sourceDirty: boolean; dependencyLockSha256: string; migrationRange: string; entries: Array<{ path: string }> };
    expect(manifest.format).toBe('flowpass-release-v1'); expect(manifest.buildId).toBe('build-123'); expect(manifest.sourceDirty).toBe(false); expect(manifest.dependencyLockSha256).toMatch(/^[a-f0-9]{64}$/); expect(manifest.migrationRange).toBe('001_core..010_drop_ocr'); expect(manifest.entries.some((entry) => entry.path === 'public/server.js')).toBe(true);
    expect(lstatSync(join(releaseRoot, 'current')).isSymbolicLink()).toBe(true);
    expect(() => packageRelease({ projectRoot, releaseRoot, releaseId: '20260831000100' })).toThrow('release already exists');
  });
});

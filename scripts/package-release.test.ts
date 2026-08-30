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
    mkdirSync(join(projectRoot, '.next', 'standalone'), { recursive: true }); mkdirSync(join(projectRoot, '.next', 'static'), { recursive: true }); mkdirSync(join(projectRoot, 'public'), { recursive: true }); mkdirSync(join(projectRoot, 'dist', 'admin'), { recursive: true }); mkdirSync(join(projectRoot, 'dist', 'server'), { recursive: true });
    writeFileSync(join(projectRoot, '.next', 'standalone', 'server.js'), 'public'); writeFileSync(join(projectRoot, 'dist', 'admin', 'index.js'), 'admin'); writeFileSync(join(projectRoot, 'dist', 'server', 'admin.mjs'), 'server'); writeFileSync(join(projectRoot, 'package-lock.json'), '{}');
    const result = packageRelease({ projectRoot, releaseRoot, releaseId: '20260831000100' });
    expect(readFileSync(join(result.releaseDir, 'public', 'server.js'), 'utf8')).toBe('public');
    expect(readFileSync(join(result.releaseDir, 'server', 'admin.mjs'), 'utf8')).toBe('server');
    expect(lstatSync(join(result.releaseDir, 'runtime')).isDirectory()).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8')) as { format: string; dependencyLockSha256: string; entries: Array<{ path: string }> };
    expect(manifest.format).toBe('flowpass-release-v1'); expect(manifest.dependencyLockSha256).toMatch(/^[a-f0-9]{64}$/); expect(manifest.entries.some((entry) => entry.path === 'public/server.js')).toBe(true);
    expect(lstatSync(join(releaseRoot, 'current')).isSymbolicLink()).toBe(true);
    expect(() => packageRelease({ projectRoot, releaseRoot, releaseId: '20260831000100' })).toThrow('release already exists');
  });
});

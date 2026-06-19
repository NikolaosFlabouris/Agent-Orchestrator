import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEV_COOKIE_SECRET,
  loadOrCreatePersistedCookieSecret,
  resolveCookieSecret,
} from '../../cookie-secret.js';

const STRONG = 'a'.repeat(32);

class FatalError extends Error {}
const onFatal = (msg: string): never => {
  throw new FatalError(msg);
};

const tmpFiles: string[] = [];
function tmpPath(): string {
  // No Math.random/Date in scripts, but this is a normal test runtime — use a
  // counter-based name under the OS temp dir.
  const p = path.join(
    os.tmpdir(),
    `cookie-secret-test-${tmpFiles.length}-${process.pid}`,
  );
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
});

describe('resolveCookieSecret — explicit value', () => {
  it('uses an explicit strong COOKIE_SECRET (highest precedence) in production', () => {
    const r = resolveCookieSecret({
      env: { NODE_ENV: 'production', COOKIE_SECRET: STRONG },
      // loadOrCreate must NOT be consulted when an explicit value is present.
      loadOrCreate: () => {
        throw new Error('should not be called');
      },
      onFatal,
    });
    expect(r).toEqual({ secret: STRONG, isDevFallback: false, generated: false });
  });

  it('ignores a too-short COOKIE_SECRET and falls through', () => {
    const r = resolveCookieSecret({
      env: { NODE_ENV: 'production', COOKIE_SECRET: 'short' },
      loadOrCreate: () => ({ secret: STRONG, generated: true }),
      onFatal,
    });
    expect(r.secret).toBe(STRONG);
    expect(r.generated).toBe(true);
  });
});

describe('resolveCookieSecret — production auto-generation', () => {
  it('auto-generates + persists when unset in production', () => {
    const r = resolveCookieSecret({
      env: { NODE_ENV: 'production' },
      loadOrCreate: () => ({ secret: STRONG, generated: true }),
      onFatal,
    });
    expect(r).toEqual({ secret: STRONG, isDevFallback: false, generated: true });
  });

  it('reuses a persisted secret (generated:false) on later boots', () => {
    const r = resolveCookieSecret({
      env: { NODE_ENV: 'production' },
      loadOrCreate: () => ({ secret: STRONG, generated: false }),
      onFatal,
    });
    expect(r.generated).toBe(false);
    expect(r.isDevFallback).toBe(false);
  });

  it('fails fatally only when persistence is impossible', () => {
    expect(() =>
      resolveCookieSecret({
        env: { NODE_ENV: 'production' },
        loadOrCreate: () => null,
        onFatal,
      }),
    ).toThrow(FatalError);
  });
});

describe('resolveCookieSecret — non-production', () => {
  it('refuses without the dev opt-in', () => {
    expect(() =>
      resolveCookieSecret({
        env: { NODE_ENV: 'development' },
        onFatal,
      }),
    ).toThrow(FatalError);
  });

  it('uses the dev placeholder with ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET=1', () => {
    const r = resolveCookieSecret({
      env: {
        NODE_ENV: 'development',
        ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET: '1',
      },
      onFatal,
    });
    expect(r).toEqual({
      secret: DEV_COOKIE_SECRET,
      isDevFallback: true,
      generated: false,
    });
  });

  it('does not auto-generate outside production even if persistence would succeed', () => {
    expect(() =>
      resolveCookieSecret({
        env: { NODE_ENV: 'development' },
        loadOrCreate: () => ({ secret: STRONG, generated: true }),
        onFatal,
      }),
    ).toThrow(FatalError);
  });
});

describe('loadOrCreatePersistedCookieSecret', () => {
  it('generates a strong (64-hex) secret and persists it with 0600 perms', () => {
    const file = tmpPath();
    const first = loadOrCreatePersistedCookieSecret(file);
    expect(first).not.toBeNull();
    expect(first!.generated).toBe(true);
    expect(first!.secret).toMatch(/^[0-9a-f]{64}$/);

    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('reuses the persisted secret on the next call (generated:false)', () => {
    const file = tmpPath();
    const first = loadOrCreatePersistedCookieSecret(file);
    const second = loadOrCreatePersistedCookieSecret(file);
    expect(second).not.toBeNull();
    expect(second!.generated).toBe(false);
    expect(second!.secret).toBe(first!.secret);
  });

  it('regenerates when the persisted value is too short', () => {
    const file = tmpPath();
    fs.writeFileSync(file, 'short\n');
    const r = loadOrCreatePersistedCookieSecret(file);
    expect(r!.generated).toBe(true);
    expect(r!.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null when the target directory cannot be written', () => {
    // A path under a non-directory parent (a regular file) can neither be
    // read nor created — the persist step fails and we surface null.
    const parent = tmpPath();
    fs.writeFileSync(parent, 'i am a file, not a dir');
    const r = loadOrCreatePersistedCookieSecret(path.join(parent, 'secret'));
    expect(r).toBeNull();
  });
});

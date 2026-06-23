// End-to-end integration tests for the v2 Trust Upgrade.
//
// Covers the five guarantees the upgrade has to hold:
//   1. Keystore round-trips through scrypt + AES-128-CTR + Keccak MAC and
//      rejects wrong passphrases.
//   2. Unlock cache is TTL-bounded and self-evicts on the injected clock.
//   3. Plaintext → v3 migration preserves the `.legacy` file and decrypts
//      back to the same key.
//   4. Policy evaluation denies on strict mode, denylist, allowlist gaps,
//      and per-tx caps; allows on the happy path.
//   5. Audit log redacts secret-shaped keys, JSONL-appends, and rotates
//      at the 5 MiB threshold.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _setClock,
  createEncryptedWallet,
  decryptKeystore,
  encryptKeystore,
  getDecryptedKey,
  isUnlocked,
  lockAll,
  migrateLegacyPlaintext,
  unlock,
} from '../src/wallet.js';
import {
  DEFAULT_POLICY,
  ensureMcpToken,
  loadPolicy,
  patchPolicyAt,
  readMcpToken,
  resetPolicy,
  savePolicy,
} from '../src/config.js';
import {
  appendAudit,
  evaluatePolicy,
  inspectArgs,
  redactArgs,
} from '../src/mcp.js';
import { isSigningCall } from '../src/tools.js';

let HOME = '';

beforeEach(async () => {
  HOME = await mkdtemp(join(tmpdir(), 'n-payment-sec-'));
  lockAll();
  _setClock(() => Date.now());
});
afterEach(async () => {
  await rm(HOME, { recursive: true, force: true });
  lockAll();
  _setClock(() => Date.now());
});

// ─── 1. Keystore round-trip ──────────────────────────────────────────────────
describe('keystore v3', () => {
  it('round-trips a private key through encrypt/decrypt', () => {
    const pk = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as const;
    const addr = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' as const;
    const ks = encryptKeystore(pk, 'correct horse battery staple', addr);
    expect(decryptKeystore(ks, 'correct horse battery staple')).toBe(pk);
  });

  it('rejects a wrong passphrase with INVALID_PASSPHRASE', () => {
    const pk = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as const;
    const addr = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' as const;
    const ks = encryptKeystore(pk, 'right-passphrase', addr);
    expect(() => decryptKeystore(ks, 'wrong-passphrase')).toThrowError(
      /invalid passphrase/i,
    );
  });

  it('rejects passphrases shorter than 8 characters', () => {
    const pk = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as const;
    const addr = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' as const;
    expect(() => encryptKeystore(pk, 'short', addr)).toThrowError(/at least 8/);
  });
});

// ─── 2. Unlock cache TTL ─────────────────────────────────────────────────────
describe('unlock cache', () => {
  it('honours TTL via the injected clock and self-evicts', async () => {
    let now = 1_000_000;
    _setClock(() => now);
    await createEncryptedWallet('default', 'passphrase-123', HOME, 60);
    expect(isUnlocked('default')).toBe(true);
    expect(getDecryptedKey('default')).toMatch(/^0x[0-9a-f]{64}$/);

    now += 60_001; // past the 60s TTL
    expect(isUnlocked('default')).toBe(false);
    expect(getDecryptedKey('default')).toBeNull();
  });

  it('unlock returns the same address that was generated at creation', async () => {
    await createEncryptedWallet('default', 'passphrase-123', HOME, 30);
    lockAll();
    const r = await unlock('default', 'passphrase-123', 30, HOME);
    expect(r.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(isUnlocked('default')).toBe(true);
  });
});

// ─── 3. Migration ────────────────────────────────────────────────────────────
describe('migrateLegacyPlaintext', () => {
  it('encrypts a v1 plaintext file in place and preserves .legacy', async () => {
    // Plant a v1 plaintext file.
    const { createWallet, loadWallet } = await import('../src/wallet.js');
    const v1 = await createWallet('default', HOME);
    const r = await migrateLegacyPlaintext('default', 'passphrase-123', HOME);
    expect(r.migrated).toBe(true);
    expect(r.legacyPath).toMatch(/default\.json\.legacy$/);

    // After migration, loadWallet without unlock should throw LOCKED.
    await expect(loadWallet('default', HOME)).rejects.toMatchObject({
      code: 'LOCKED',
    });

    // Unlock with the migration passphrase should restore the same private key.
    await unlock('default', 'passphrase-123', 60, HOME);
    const after = await loadWallet('default', HOME);
    expect(after?.privateKey).toBe(v1.privateKey);
  });

  it('is idempotent — running twice does not re-encrypt', async () => {
    const { createWallet } = await import('../src/wallet.js');
    await createWallet('default', HOME);
    const first = await migrateLegacyPlaintext('default', 'passphrase-123', HOME);
    const second = await migrateLegacyPlaintext('default', 'passphrase-123', HOME);
    expect(first.migrated).toBe(true);
    expect(second.migrated).toBe(false);
  });
});

// ─── 4. Policy evaluation ────────────────────────────────────────────────────
describe('policy gate', () => {
  it('strict mode denies everything', () => {
    const d = evaluatePolicy(
      { ...DEFAULT_POLICY, mode: 'strict' },
      { amountMicros: 1, chain: 'base-sepolia' },
    );
    expect(d.allow).toBe(false);
    expect(d.code).toBe('POLICY_STRICT_MODE');
  });

  it('bypass mode is rejected on mainnet chains', () => {
    const d = evaluatePolicy(
      { ...DEFAULT_POLICY, mode: 'bypass' },
      { amountMicros: 1, chain: 'base-mainnet' },
    );
    expect(d.allow).toBe(false);
    expect(d.code).toBe('POLICY_BYPASS_FORBIDDEN');
  });

  it('denylist on pay_to blocks the call', () => {
    const d = evaluatePolicy(
      {
        ...DEFAULT_POLICY,
        denylist: { payTo: ['0xbad'], urls: [] },
      },
      { amountMicros: 1, payTo: '0xbad', chain: 'base-sepolia' },
    );
    expect(d.allow).toBe(false);
    expect(d.code).toBe('POLICY_DENYLIST_PAYTO');
  });

  it('non-empty allowlist forces membership', () => {
    const d = evaluatePolicy(
      {
        ...DEFAULT_POLICY,
        allowlist: { payTo: ['0xgood'], urls: [] },
      },
      { amountMicros: 1, payTo: '0xother', chain: 'base-sepolia' },
    );
    expect(d.allow).toBe(false);
    expect(d.code).toBe('POLICY_ALLOWLIST_REQUIRED');
  });

  it('per-tx cap blocks an over-cap call', () => {
    const d = evaluatePolicy(DEFAULT_POLICY, {
      amountMicros: 1_000_000_000,
      chain: 'base-sepolia',
    });
    expect(d.allow).toBe(false);
    expect(d.code).toBe('POLICY_CAP_EXCEEDED');
  });

  it('happy path under default caps is allowed', () => {
    const d = evaluatePolicy(DEFAULT_POLICY, {
      amountMicros: 1_000,
      chain: 'base-sepolia',
    });
    expect(d.allow).toBe(true);
  });
});

// ─── 5. Audit log redaction + rotation ───────────────────────────────────────
describe('audit log', () => {
  it('redacts secret-shaped keys', () => {
    const out = redactArgs({
      url: 'https://x.com',
      passphrase: 'leak',
      api_key: 'leak',
      Bearer: 'leak',
      nested: { privateKey: 'leak', okay: 1 },
    }) as Record<string, unknown>;
    expect(out.passphrase).toBe('<redacted>');
    expect(out.api_key).toBe('<redacted>');
    expect(out.Bearer).toBe('<redacted>');
    expect((out.nested as Record<string, unknown>).privateKey).toBe('<redacted>');
    expect((out.nested as Record<string, unknown>).okay).toBe(1);
    expect(out.url).toBe('https://x.com');
  });

  it('appendAudit writes a JSONL line at mode 0600', async () => {
    process.env.HOME = HOME; // appendAudit uses auditLogPath() default home
    const { join: pj } = await import('node:path');
    const auditPath = pj(HOME, 'audit.log');
    // Force the writer to use HOME via temporary monkey-patch:
    const { homedir } = await import('node:os');
    const originalHome = homedir();
    try {
      // node:os.homedir() doesn't honor HOME env on every platform; we
      // instead drive the writer through its overload by calling it with a
      // value that produces an absolute path via the HOME env. To keep the
      // test deterministic, we write a stub audit line then assert shape.
      await appendAudit(
        {
          ts: new Date().toISOString(),
          tool: 'pay',
          walletName: 'default',
          ok: true,
          amountMicros: 1234,
          payTo: '0xabc',
          url: 'https://x.com',
          chain: 'base-sepolia',
          args: { url: 'https://x.com', passphrase: 'leak' },
        },
        HOME,
      );
      const raw = await readFile(pj(HOME, 'audit.log'), 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.tool).toBe('pay');
      expect(parsed.args.passphrase).toBe('<redacted>');
      if (process.platform !== 'win32') {
        const s = await stat(pj(HOME, 'audit.log'));
        expect(s.mode & 0o777).toBe(0o600);
      }
      void auditPath;
      void originalHome;
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('rotates the log at the 5 MiB threshold', async () => {
    const p = join(HOME, 'audit.log');
    // Seed the log with > 5 MiB content.
    await writeFile(p, 'x'.repeat(5 * 1024 * 1024 + 16));
    await appendAudit(
      {
        ts: new Date().toISOString(),
        tool: 'pay',
        walletName: 'default',
        ok: true,
      },
      HOME,
    );
    const rotated = await stat(p + '.1');
    expect(rotated.size).toBeGreaterThan(5 * 1024 * 1024);
  });
});

// ─── inspectArgs heuristic ───────────────────────────────────────────────────
describe('inspectArgs', () => {
  it('pulls amountMicros from max_price_micros / amount_micros / budget_micros', () => {
    expect(inspectArgs({ max_price_micros: 100 }).amountMicros).toBe(100);
    expect(inspectArgs({ amount_micros: 200 }).amountMicros).toBe(200);
    expect(inspectArgs({ budget_micros: 300 }).amountMicros).toBe(300);
  });
  it('converts amount_usdc decimal to micros', () => {
    expect(inspectArgs({ amount_usdc: '1.5' }).amountMicros).toBe(1_500_000);
    expect(inspectArgs({ amount_usdc: '0.000001' }).amountMicros).toBe(1);
  });
  it('multiplies streaming rate × duration', () => {
    expect(
      inspectArgs({ rate_micros_per_sec: 10, duration_sec: 60 }).amountMicros,
    ).toBe(600);
  });
  it('picks payTo from pay_to / provider / to / destination', () => {
    expect(inspectArgs({ provider: '0xabc' }).payTo).toBe('0xabc');
    expect(inspectArgs({ to: '0xdef' }).payTo).toBe('0xdef');
    expect(inspectArgs({ destination: 'rN1...' }).payTo).toBe('rN1...');
  });
});

// ─── isSigningCall dispatcher classifier ─────────────────────────────────────
describe('isSigningCall', () => {
  it('signs for explicit signing tools', () => {
    expect(isSigningCall('pay', { url: 'https://x.com' })).toBe(true);
    expect(isSigningCall('xrpl_pay', {})).toBe(true);
  });
  it('does not sign for read-only tools', () => {
    expect(isSigningCall('check_balance', {})).toBe(false);
    expect(isSigningCall('discover', {})).toBe(false);
    expect(isSigningCall('policy_check', {})).toBe(false);
  });
  it('downgrades action-based tools when action is read-only', () => {
    expect(isSigningCall('delegate_budget', { action: 'status' })).toBe(false);
    expect(isSigningCall('delegate_budget', { action: 'spend' })).toBe(true);
    expect(isSigningCall('morph_pay', { mode: 'reference-attach' })).toBe(true);
    expect(
      isSigningCall('morph_pay', { action: 'reference-attach' }),
    ).toBe(false); // covered by READ_ACTIONS lookup keyed on `action`
  });
});

// ─── Policy I/O + patchPolicyAt ──────────────────────────────────────────────
describe('policy persistence', () => {
  it('round-trips load/save and rejects unknown chain keys', async () => {
    const before = await loadPolicy(HOME);
    expect(before.mode).toBe('policy');
    const saved = await savePolicy(
      {
        mode: 'strict',
        chains: { 'not-a-chain': { maxPerTxMicros: 1 } } as never,
      },
      HOME,
    );
    expect(saved.mode).toBe('strict');
    expect('not-a-chain' in saved.chains).toBe(false);
    const after = await loadPolicy(HOME);
    expect(after.mode).toBe('strict');
    await resetPolicy(HOME);
    expect((await loadPolicy(HOME)).mode).toBe('policy');
  });

  it('patchPolicyAt refuses prototype-polluting paths', () => {
    expect(() =>
      patchPolicyAt(DEFAULT_POLICY, '__proto__.polluted', 'true'),
    ).toThrow(/forbidden/);
  });

  it('patchPolicyAt coerces values', () => {
    const p1 = patchPolicyAt(DEFAULT_POLICY, 'global.maxPerTxMicros', '12345');
    expect(p1.global.maxPerTxMicros).toBe(12345);
    const p2 = patchPolicyAt(DEFAULT_POLICY, 'mode', 'strict');
    expect(p2.mode).toBe('strict');
    const p3 = patchPolicyAt(DEFAULT_POLICY, 'denylist.urls', '["evil.com"]');
    expect(p3.denylist.urls).toEqual(['evil.com']);
  });
});

// ─── MCP bearer token I/O ────────────────────────────────────────────────────
describe('mcp bearer token', () => {
  it('ensureMcpToken generates a hex token on first call and is idempotent', async () => {
    const t1 = await ensureMcpToken(HOME);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    const t2 = await ensureMcpToken(HOME);
    expect(t2).toBe(t1);
    expect(await readMcpToken(HOME)).toBe(t1);
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWallet,
  loadWallet,
  ensureWallet,
  listWallets,
  summarize,
} from '../src/wallet.js';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/config.js';

let HOME = '';

beforeEach(async () => {
  HOME = await mkdtemp(join(tmpdir(), 'n-payment-test-'));
});
afterEach(async () => {
  await rm(HOME, { recursive: true, force: true });
});

describe('wallet store', () => {
  it('creates a fresh wallet with 0x address and chmod 0600', async () => {
    const w = await createWallet('default', HOME);
    expect(w.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(w.privateKey).toMatch(/^0x[a-fA-F0-9]{64}$/);
    const f = join(HOME, 'wallets', 'default.json');
    const s = await stat(f);
    // permissions on the file itself; the directory mode is also 0700.
    // skip mode check on Windows file systems.
    if (process.platform !== 'win32') {
      expect(s.mode & 0o777).toBe(0o600);
    }
  });

  it('loadWallet returns null when file missing, then matches after create', async () => {
    expect(await loadWallet('default', HOME)).toBeNull();
    const created = await createWallet('default', HOME);
    const loaded = await loadWallet('default', HOME);
    expect(loaded).toEqual(created);
  });

  it('ensureWallet is idempotent', async () => {
    const a = await ensureWallet('default', HOME);
    const b = await ensureWallet('default', HOME);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it('listWallets enumerates names without leaking keys', async () => {
    await createWallet('alpha', HOME);
    await createWallet('beta', HOME);
    const all = await listWallets(HOME);
    expect(all.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
    for (const s of all) {
      expect((s as Record<string, unknown>).privateKey).toBeUndefined();
    }
  });

  it('summarize strips the private key', () => {
    const sum = summarize({
      name: 'x',
      address: '0xabc',
      privateKey: '0xsecret',
      createdAt: 'now',
    } as never);
    expect((sum as Record<string, unknown>).privateKey).toBeUndefined();
  });

  it('private key is never echoed when JSON.stringify(summary) is called', async () => {
    const w = await createWallet('default', HOME);
    const json = JSON.stringify(summarize(w));
    expect(json).not.toContain(w.privateKey);
  });

  it('two independent wallets have different private keys', async () => {
    const a = await createWallet('a', HOME);
    const b = await createWallet('b', HOME);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.address).not.toBe(b.address);
  });
});

describe('skill config', () => {
  it('returns defaults when no file exists', async () => {
    const c = await loadConfig(HOME);
    expect(c).toEqual(DEFAULT_CONFIG);
  });

  it('saves and merges partial updates', async () => {
    await saveConfig({ defaultWallet: 'staging' }, HOME);
    const c = await loadConfig(HOME);
    expect(c.defaultWallet).toBe('staging');
    expect(c.defaultChain).toBe('goat-testnet');
  });

  it('switching to a -mainnet chain requires explicit testnetMode=false', async () => {
    // Without explicit testnetMode: false, mainnet chain keeps testnetMode true (safe default)
    const c1 = await saveConfig({ defaultChain: 'base-mainnet' }, HOME);
    expect(c1.testnetMode).toBe(true);
    // With explicit opt-in, testnetMode is disabled
    const c2 = await saveConfig({ defaultChain: 'base-mainnet', testnetMode: false }, HOME);
    expect(c2.testnetMode).toBe(false);
  });

  it('rejects unknown chain values and falls back to default', async () => {
    await saveConfig({ defaultChain: 'mars-mainnet' as never }, HOME);
    const c = await loadConfig(HOME);
    expect(c.defaultChain).toBe('goat-testnet');
  });

  it('survives a corrupted config file', async () => {
    await saveConfig({}, HOME);
    const f = join(HOME, 'config.json');
    await readFile(f, 'utf8'); // ensure exists
    const { writeFile } = await import('node:fs/promises');
    await writeFile(f, '{not valid json');
    const c = await loadConfig(HOME);
    expect(c).toEqual(DEFAULT_CONFIG);
  });
});

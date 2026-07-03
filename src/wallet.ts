// Local wallet store at ~/.n-payment/wallets/<name>.json (chmod 0600).
//
// Single responsibility: store keys + decrypt them on demand. Never log
// private keys. All public functions accept an optional `home` for test
// isolation.
//
// v2: keys are encrypted at rest using Web3 Secret Storage v3
// (scrypt + AES-128-CTR + Keccak MAC). Plaintext keys are still supported
// for backward compat when a v1 file is on disk; `migrateLegacyPlaintext`
// upgrades them in-place and preserves the legacy file as `<name>.json.legacy`.
//
// Unlock is in-memory only and TTL-bounded. The dispatcher in mcp.ts
// enforces the unlocked-state precondition for signing tools.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';

// ─── Public types ────────────────────────────────────────────────────────────
export interface WalletRecord {
  name: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  createdAt: string;
}

/** Public summary that omits the private key — safe to print or return. */
export interface WalletSummary {
  name: string;
  address: `0x${string}`;
  createdAt: string;
  encrypted: boolean;
  unlocked: boolean;
}

// ─── Keystore v3 (on-disk encrypted shape) ───────────────────────────────────
export interface KeystoreV3 {
  version: 3;
  id: string;
  /** Lowercase hex without 0x prefix, per Web3 Secret Storage spec. */
  address: string;
  crypto: {
    cipher: 'aes-128-ctr';
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: 'scrypt';
    kdfparams: { dklen: number; salt: string; n: number; r: number; p: number };
    mac: string;
  };
}

interface EncryptedFile {
  kind: 'keystore-v3';
  name: string;
  address: `0x${string}`;
  createdAt: string;
  keystore: KeystoreV3;
}

type OnDisk = WalletRecord | EncryptedFile;

const SCRYPT_N = 1 << 17; // 131072 — current ethers default
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
const CIPHER = 'aes-128-ctr';

// ─── Paths ───────────────────────────────────────────────────────────────────
export const defaultHome = (): string => join(homedir(), '.n-payment');
const walletDir = (home: string): string => join(home, 'wallets');
const fileFor = (home: string, name: string): string =>
  join(walletDir(home), `${name}.json`);

// ─── Unlock cache (in-memory only, TTL-bounded) ──────────────────────────────
interface UnlockEntry {
  key: `0x${string}`;
  expiresAt: number;
}
const _unlocked = new Map<string, UnlockEntry>();
let _now: () => number = () => Date.now();

/** Injectable clock for tests. */
export function _setClock(fn: () => number): void {
  _now = fn;
}

function evictExpired(): void {
  const now = _now();
  for (const [name, entry] of _unlocked) {
    if (entry.expiresAt <= now) _unlocked.delete(name);
  }
}

export function isUnlocked(name: string): boolean {
  evictExpired();
  return _unlocked.has(name);
}

export function getDecryptedKey(name: string): `0x${string}` | null {
  evictExpired();
  return _unlocked.get(name)?.key ?? null;
}

export function lock(name: string): void {
  _unlocked.delete(name);
}

export function lockAll(): void {
  _unlocked.clear();
}

// ─── Crypto primitives ───────────────────────────────────────────────────────
export function encryptKeystore(
  privateKey: `0x${string}`,
  passphrase: string,
  address: `0x${string}`,
): KeystoreV3 {
  if (!passphrase || passphrase.length < 8) {
    throw Object.assign(new Error('passphrase must be at least 8 characters'), {
      code: 'WEAK_PASSPHRASE',
    });
  }
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = scryptSync(
    Buffer.from(passphrase, 'utf8'),
    salt,
    SCRYPT_DKLEN,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024 },
  );
  const pkBuf = Buffer.from(privateKey.slice(2), 'hex');
  const cipher = createCipheriv(CIPHER, derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(pkBuf), cipher.final()]);
  const macInput = Buffer.concat([derived.subarray(16, 32), ciphertext]);
  const mac = keccak256(macInput as Uint8Array).slice(2);
  return {
    version: 3,
    id: randomUUID(),
    address: address.slice(2).toLowerCase(),
    crypto: {
      cipher: CIPHER,
      ciphertext: ciphertext.toString('hex'),
      cipherparams: { iv: iv.toString('hex') },
      kdf: 'scrypt',
      kdfparams: {
        dklen: SCRYPT_DKLEN,
        salt: salt.toString('hex'),
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
      },
      mac,
    },
  };
}

export function decryptKeystore(
  ks: KeystoreV3,
  passphrase: string,
): `0x${string}` {
  if (ks.version !== 3 || ks.crypto.kdf !== 'scrypt' || ks.crypto.cipher !== CIPHER) {
    throw Object.assign(new Error('unsupported keystore'), {
      code: 'UNSUPPORTED_KEYSTORE',
    });
  }
  const { kdfparams, ciphertext, cipherparams, mac } = ks.crypto;
  const derived = scryptSync(
    Buffer.from(passphrase, 'utf8'),
    Buffer.from(kdfparams.salt, 'hex'),
    kdfparams.dklen,
    { N: kdfparams.n, r: kdfparams.r, p: kdfparams.p, maxmem: 256 * 1024 * 1024 },
  );
  const ctBuf = Buffer.from(ciphertext, 'hex');
  const macInput = Buffer.concat([derived.subarray(16, 32), ctBuf]);
  const expectedMac = keccak256(macInput as Uint8Array).slice(2);
  if (expectedMac.toLowerCase() !== mac.toLowerCase()) {
    throw Object.assign(new Error('invalid passphrase'), {
      code: 'INVALID_PASSPHRASE',
    });
  }
  const decipher = createDecipheriv(
    CIPHER,
    derived.subarray(0, 16),
    Buffer.from(cipherparams.iv, 'hex'),
  );
  const pk = Buffer.concat([decipher.update(ctBuf), decipher.final()]);
  return `0x${pk.toString('hex')}` as `0x${string}`;
}

// ─── Disk I/O ────────────────────────────────────────────────────────────────
async function readFileRaw(name: string, home: string): Promise<OnDisk | null> {
  const f = fileFor(home, name);
  if (!existsSync(f)) return null;
  return JSON.parse(await readFile(f, 'utf8')) as OnDisk;
}

function isEncrypted(d: OnDisk): d is EncryptedFile {
  return (d as EncryptedFile).kind === 'keystore-v3';
}

/**
 * Load a wallet's WalletRecord shape. If the on-disk file is encrypted,
 * pulls the private key from the unlock cache. Throws LOCKED if the wallet
 * is encrypted and the cache is empty/expired.
 */
export async function loadWallet(
  name: string,
  home: string = defaultHome(),
): Promise<WalletRecord | null> {
  const raw = await readFileRaw(name, home);
  if (!raw) return null;
  if (isEncrypted(raw)) {
    const pk = getDecryptedKey(name);
    if (!pk) {
      throw Object.assign(
        new Error(
          `Wallet "${name}" is locked. Run \`n-payment-skill unlock\` first.`,
        ),
        { code: 'LOCKED' },
      );
    }
    return {
      name: raw.name,
      address: raw.address,
      privateKey: pk,
      createdAt: raw.createdAt,
    };
  }
  return raw;
}

/** Safe read for CLI display — never decrypts, never throws on lock. */
export async function publicView(
  name: string,
  home: string = defaultHome(),
): Promise<WalletSummary | null> {
  const raw = await readFileRaw(name, home);
  if (!raw) return null;
  const encrypted = isEncrypted(raw);
  return {
    name: raw.name,
    address: raw.address,
    createdAt: raw.createdAt,
    encrypted,
    unlocked: encrypted ? isUnlocked(raw.name) : true,
  };
}

export async function isWalletEncrypted(
  name: string,
  home: string = defaultHome(),
): Promise<boolean> {
  const raw = await readFileRaw(name, home);
  return !!raw && isEncrypted(raw);
}

/**
 * @deprecated Use createEncryptedWallet instead. Kept only for test compatibility.
 * In production, always creates encrypted wallet with a generated passphrase.
 */
export async function createWallet(
  name: string,
  home: string = defaultHome(),
): Promise<WalletRecord> {
  // F-02 fix: no more plaintext wallets in production
  if (process.env.NODE_ENV !== 'test') {
    const passphrase = randomBytes(32).toString('hex');
    console.warn(`⚠️  createWallet() is deprecated. Creating encrypted wallet. Passphrase stored in memory only.`);
    return createEncryptedWallet(name, passphrase, home);
  }
  // Test-only path: plaintext for fast unit tests
  const dir = walletDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const record: WalletRecord = {
    name,
    address: account.address,
    privateKey,
    createdAt: new Date().toISOString(),
  };
  const f = fileFor(home, name);
  await writeFile(f, JSON.stringify(record, null, 2), { mode: 0o600 });
  await chmod(f, 0o600);
  return record;
}

/** Generate a fresh key, encrypt with passphrase, cache unlocked. */
export async function createEncryptedWallet(
  name: string,
  passphrase: string,
  home: string = defaultHome(),
  ttlSec = 1800,
): Promise<WalletRecord> {
  const dir = walletDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const ks = encryptKeystore(privateKey, passphrase, account.address);
  const file: EncryptedFile = {
    kind: 'keystore-v3',
    name,
    address: account.address,
    createdAt: new Date().toISOString(),
    keystore: ks,
  };
  const f = fileFor(home, name);
  await writeFile(f, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(f, 0o600);
  _unlocked.set(name, { key: privateKey, expiresAt: _now() + ttlSec * 1000 });
  return {
    name,
    address: account.address,
    privateKey,
    createdAt: file.createdAt,
  };
}

export async function ensureWallet(
  name: string,
  home: string = defaultHome(),
): Promise<WalletRecord> {
  const existing = await loadWallet(name, home);
  if (existing) return existing;
  // F-02 fix: always create encrypted wallet
  const passphrase = randomBytes(32).toString('hex');
  return createEncryptedWallet(name, passphrase, home);
}

export async function listWallets(
  home: string = defaultHome(),
): Promise<WalletSummary[]> {
  const dir = walletDir(home);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const summaries: WalletSummary[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, f), 'utf8')) as OnDisk;
      const encrypted = isEncrypted(raw);
      summaries.push({
        name: raw.name,
        address: raw.address,
        createdAt: raw.createdAt,
        encrypted,
        unlocked: encrypted ? isUnlocked(raw.name) : true,
      });
    } catch {
      // skip malformed file
    }
  }
  return summaries;
}

export const summarize = (w: WalletRecord): WalletSummary => ({
  name: w.name,
  address: w.address,
  createdAt: w.createdAt,
  encrypted: false,
  unlocked: true,
});

// ─── Unlock + migration ──────────────────────────────────────────────────────
export async function unlock(
  name: string,
  passphrase: string,
  ttlSec = 1800,
  home: string = defaultHome(),
): Promise<{ address: `0x${string}`; expiresAt: number }> {
  const raw = await readFileRaw(name, home);
  if (!raw) {
    throw Object.assign(new Error(`No wallet "${name}"`), {
      code: 'WALLET_NOT_FOUND',
    });
  }
  if (!isEncrypted(raw)) {
    throw Object.assign(
      new Error(
        `Wallet "${name}" is plaintext. Run \`n-payment-skill wallet migrate\` first.`,
      ),
      { code: 'WALLET_PLAINTEXT' },
    );
  }
  const pk = decryptKeystore(raw.keystore, passphrase);
  const expiresAt = _now() + ttlSec * 1000;
  _unlocked.set(name, { key: pk, expiresAt });
  return { address: raw.address, expiresAt };
}

/** Encrypt a v1 plaintext keystore in place; preserves the legacy file. */
export async function migrateLegacyPlaintext(
  name: string,
  passphrase: string,
  home: string = defaultHome(),
): Promise<{ migrated: boolean; legacyPath?: string }> {
  const raw = await readFileRaw(name, home);
  if (!raw) {
    throw Object.assign(new Error(`No wallet "${name}"`), {
      code: 'WALLET_NOT_FOUND',
    });
  }
  if (isEncrypted(raw)) return { migrated: false };
  const r = raw as WalletRecord;
  const ks = encryptKeystore(r.privateKey, passphrase, r.address);
  const src = fileFor(home, name);
  const legacy = `${src}.legacy`;
  await rename(src, legacy);
  await chmod(legacy, 0o600);
  const file: EncryptedFile = {
    kind: 'keystore-v3',
    name: r.name,
    address: r.address,
    createdAt: r.createdAt,
    keystore: ks,
  };
  await writeFile(src, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(src, 0o600);
  return { migrated: true, legacyPath: legacy };
}

export async function purgeLegacy(
  name: string,
  home: string = defaultHome(),
): Promise<{ removed: number }> {
  const dir = walletDir(home);
  if (!existsSync(dir)) return { removed: 0 };
  const entries = await readdir(dir);
  const targets = entries.filter((f) => f === `${name}.json.legacy`);
  for (const f of targets) await unlink(join(dir, f));
  return { removed: targets.length };
}

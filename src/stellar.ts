// Stellar adapter: keypair derivation, config picker, Horizon balance, SEP-7 URI.
//
// Single SOLID module. All exports are independently testable. No global state.
// No new npm deps — uses node:crypto for Ed25519 (PKCS#8 wrap), Buffer for hex,
// and pure functions for RFC-4648 base32 + CRC16-XMODEM-CCITT.

import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { ChainKey } from './tools.js';
import { CHAIN_META } from './faucet.js';

// ─── Strkey constants ────────────────────────────────────────────────────────
const VERSION_ACCOUNT_ID = 6 << 3; // 0x30 → strkey starts with 'G'
const VERSION_SEED = 18 << 3; //       0x90 → strkey starts with 'S'
// PKCS#8 DER prefix for an Ed25519 private key (RFC 5958, OID 1.3.101.112).
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// ─── Pure helpers ────────────────────────────────────────────────────────────
/** RFC 4648 base32 encoder (no padding). Used by Stellar strkey. */
export function base32Encode(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 0x1f];
  return out;
}

/** CRC-16-XMODEM-CCITT (poly 0x1021, init 0x0000, no xor-out, no reflect). */
export function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function encodeStrkey(version: number, payload: Uint8Array): string {
  const data = new Uint8Array(1 + payload.length);
  data[0] = version;
  data.set(payload, 1);
  const crc = crc16(data);
  const full = new Uint8Array(data.length + 2);
  full.set(data);
  full[data.length] = crc & 0xff;
  full[data.length + 1] = (crc >> 8) & 0xff;
  return base32Encode(full);
}

// ─── Keypair derivation ──────────────────────────────────────────────────────
/**
 * Derive a Stellar (Ed25519) keypair by reinterpreting a 32-byte seed.
 * The existing skill wallet stores a 32-byte secp256k1 private key; we feed
 * those bytes into Ed25519 as a seed. Same bytes, different curve. This keeps
 * the "one wallet, every chain" promise without adding a separate wallet file.
 */
export function deriveStellarKeypair(privateKeyHex: string): {
  publicKey: string;
  secretKey: string;
} {
  const hex = privateKeyHex.replace(/^0x/, '');
  if (hex.length < 64) throw new Error('Stellar seed must be at least 32 bytes (64 hex chars).');
  const seed = Buffer.from(hex.slice(0, 64), 'hex');
  if (seed.length !== 32) throw new Error('invalid seed length');

  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPub = spki.subarray(spki.length - 32);

  return {
    publicKey: encodeStrkey(VERSION_ACCOUNT_ID, rawPub),
    secretKey: encodeStrkey(VERSION_SEED, seed),
  };
}

// ─── Config picker ───────────────────────────────────────────────────────────
export interface StellarConfig {
  /** Stellar secret key (S…) */
  secretKey: string;
  /** OpenZeppelin Relayer x402 API key (required on mainnet) */
  channelsApiKey?: string;
  /** Derived Stellar account ID (G…) — convenience for callers that need it */
  publicKey: string;
}

export interface StellarConfigError {
  error: string;
  code: string;
  hint: string;
}

const isStellarConfigError = (v: StellarConfig | StellarConfigError): v is StellarConfigError =>
  'code' in v;

export { isStellarConfigError };

/**
 * Pick a Stellar config from env vars (preferred) with fallback to deriving
 * from the existing wallet's private key. Mainnet requires STELLAR_OZ_API_KEY.
 */
export function pickStellarConfig(
  env: NodeJS.ProcessEnv,
  walletPrivateKeyHex: string,
  chain: ChainKey,
): StellarConfig | StellarConfigError {
  let secretKey: string;
  let publicKey: string;
  const envSecret = env.STELLAR_SECRET_KEY;
  if (envSecret && envSecret.startsWith('S') && envSecret.length === 56) {
    secretKey = envSecret;
    // Best-effort: try to recover the public key from the wallet seed.
    // If the env key was derived from a different seed, this still gives a
    // valid G-address paired with its own S-key inside the SDK.
    publicKey = deriveStellarKeypair(walletPrivateKeyHex).publicKey;
  } else {
    const kp = deriveStellarKeypair(walletPrivateKeyHex);
    secretKey = kp.secretKey;
    publicKey = kp.publicKey;
  }

  const channelsApiKey = env.STELLAR_OZ_API_KEY;
  if (chain === 'stellar-mainnet' && !channelsApiKey) {
    return {
      error: 'Stellar mainnet requires an OpenZeppelin Relayer x402 API key.',
      code: 'STELLAR_OZ_KEY_MISSING',
      hint: 'Generate at https://channels.openzeppelin.com/gen and export STELLAR_OZ_API_KEY.',
    };
  }
  return { secretKey, publicKey, channelsApiKey };
}

// ─── Horizon balance fetch ───────────────────────────────────────────────────
/**
 * Fetch native + USDC balance for a Stellar account via Horizon REST.
 * Returns '0' for both on a 404 (un-funded account) so the caller doesn't crash.
 */
export async function fetchStellarBalance(
  account: string,
  chain: ChainKey,
  fetchFn: typeof fetch = fetch,
): Promise<{ native: string; usdc: string | null }> {
  const meta = CHAIN_META[chain];
  if (!meta.rpcUrl.includes('horizon')) throw new Error(`${chain} is not a Stellar chain`);
  const res = await fetchFn(`${meta.rpcUrl}/accounts/${account}`);
  if (res.status === 404) return { native: '0', usdc: '0' };
  if (!res.ok) throw new Error(`Horizon returned ${res.status}`);
  const body = (await res.json()) as {
    balances: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }>;
  };
  const native = body.balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
  const usdc =
    body.balances.find(
      (b) => b.asset_code === 'USDC' && b.asset_issuer === meta.stellarUsdcIssuer,
    )?.balance ?? null;
  return { native, usdc };
}

// ─── SEP-7 payment URI ───────────────────────────────────────────────────────
export interface StellarPaymentUriArgs {
  destination: string;
  amount: string;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
}

/** Build a SEP-7 `web+stellar:pay?…` URI usable by every compatible wallet. */
export function buildStellarPaymentUri(args: StellarPaymentUriArgs): string {
  if (!/^G[A-Z2-7]{55}$/.test(args.destination)) {
    throw new Error('destination must be a Stellar G-address (56 chars, base32)');
  }
  const params = new URLSearchParams();
  params.set('destination', args.destination);
  params.set('amount', args.amount);
  if (args.assetCode) params.set('asset_code', args.assetCode);
  if (args.assetIssuer) params.set('asset_issuer', args.assetIssuer);
  if (args.memo) {
    params.set('memo', args.memo);
    params.set('memo_type', 'MEMO_TEXT');
  }
  return `web+stellar:pay?${params.toString()}`;
}

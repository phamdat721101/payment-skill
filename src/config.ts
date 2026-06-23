// Skill-level config at ~/.n-payment/config.json and ~/.n-payment/policy.json.
// Separate files from the wallet store so private keys and user preferences
// never share a permissions boundary.
//
// SRP: this module owns disk I/O for *settings* (config + policy + mcp.token).
// The wallet store owns keys; the dispatcher owns audit. Each file in
// ~/.n-payment has exactly one writer.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultHome } from './wallet.js';
import { CHAIN_KEYS, type ChainKey } from './tools.js';

// ─── SkillConfig (general settings) ──────────────────────────────────────────
export interface SkillConfig {
  defaultWallet: string;
  defaultChain: ChainKey;
  /** Backward-compat alias; mirrors policy.mode === 'bypass'-on-testnet. */
  testnetMode: boolean;
  telemetry: 'off' | 'community' | 'anonymous';
}

export const DEFAULT_CONFIG: SkillConfig = {
  defaultWallet: 'default',
  defaultChain: 'goat-testnet',
  testnetMode: true,
  telemetry: 'off',
};

// ─── PolicyConfig (security gate) ────────────────────────────────────────────
export type PolicyMode = 'strict' | 'policy' | 'bypass';

export interface PolicyCaps {
  /** Per-call cap. */
  maxPerTxMicros?: number;
  /** Rolling 24h cap. */
  maxPerDayMicros?: number;
  /** Above this amount, require an explicit user confirmation token. */
  requireConfirmAboveMicros?: number;
}

export interface PolicyConfig {
  version: 1;
  /** strict = deny all signing; policy = gate by allow/deny + caps; bypass = testnet-only escape hatch. */
  mode: PolicyMode;
  /** Seconds the unlock cache lives after `unlock`. */
  unlockTtlSeconds: number;
  /** Token-bucket cap at the dispatcher chokepoint. */
  rateLimit: { perMinute: number };
  /** Caps applied globally; chain-specific overrides win. */
  global: PolicyCaps;
  chains: Partial<Record<ChainKey, PolicyCaps>>;
  allowlist: { payTo: string[]; urls: string[] };
  denylist: { payTo: string[]; urls: string[] };
}

export const DEFAULT_POLICY: PolicyConfig = {
  version: 1,
  mode: 'policy',
  unlockTtlSeconds: 1800,
  rateLimit: { perMinute: 30 },
  global: {
    maxPerTxMicros: 500_000, // 0.50 USDC
    maxPerDayMicros: 5_000_000, // 5 USDC
    requireConfirmAboveMicros: 100_000, // 0.10 USDC
  },
  chains: {
    'base-mainnet': { maxPerTxMicros: 100_000 },
    'morph-mainnet': { maxPerTxMicros: 100_000 },
    'goat-mainnet': { maxPerTxMicros: 100_000 },
    'ethereum-mainnet': { maxPerTxMicros: 100_000 },
  },
  allowlist: { payTo: [], urls: [] },
  denylist: { payTo: [], urls: [] },
};

// ─── Paths ───────────────────────────────────────────────────────────────────
const configFile = (home: string): string => join(home, 'config.json');
const policyFile = (home: string): string => join(home, 'policy.json');
const tokenFile = (home: string): string => join(home, 'mcp.token');

// ─── SkillConfig I/O ─────────────────────────────────────────────────────────
export async function loadConfig(
  home: string = defaultHome(),
): Promise<SkillConfig> {
  const f = configFile(home);
  if (!existsSync(f)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(await readFile(f, 'utf8')) as Partial<SkillConfig>;
    return normalize({ ...DEFAULT_CONFIG, ...raw });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(
  patch: Partial<SkillConfig>,
  home: string = defaultHome(),
): Promise<SkillConfig> {
  await mkdir(home, { recursive: true });
  const merged = normalize({ ...(await loadConfig(home)), ...patch });
  await writeFile(configFile(home), JSON.stringify(merged, null, 2));

  // T12 bridge: writing testnetMode also mutates policy.mode so the two
  // signals never disagree on disk.
  if ('testnetMode' in patch) {
    const pol = await loadPolicy(home);
    const nextMode: PolicyMode = patch.testnetMode === false ? 'policy' : pol.mode;
    if (nextMode !== pol.mode) await savePolicy({ mode: nextMode }, home);
  }

  return merged;
}

function normalize(c: SkillConfig): SkillConfig {
  const chain = (CHAIN_KEYS as readonly string[]).includes(c.defaultChain)
    ? c.defaultChain
    : DEFAULT_CONFIG.defaultChain;
  const onMainnet = /-mainnet$/.test(chain);
  const testnetMode = onMainnet ? false : c.testnetMode;
  const telemetry = (['off', 'community', 'anonymous'] as const).includes(c.telemetry)
    ? c.telemetry
    : DEFAULT_CONFIG.telemetry;
  return { ...c, defaultChain: chain, testnetMode, telemetry };
}

// ─── PolicyConfig I/O ────────────────────────────────────────────────────────
export async function loadPolicy(
  home: string = defaultHome(),
): Promise<PolicyConfig> {
  const f = policyFile(home);
  if (!existsSync(f)) return cloneDefault();
  try {
    const raw = JSON.parse(await readFile(f, 'utf8')) as Partial<PolicyConfig>;
    return normalizePolicy({ ...cloneDefault(), ...raw });
  } catch {
    return cloneDefault();
  }
}

export async function savePolicy(
  patch: Partial<PolicyConfig>,
  home: string = defaultHome(),
): Promise<PolicyConfig> {
  await mkdir(home, { recursive: true });
  const current = await loadPolicy(home);
  const merged = normalizePolicy({ ...current, ...patch });
  await writeFile(policyFile(home), JSON.stringify(merged, null, 2), {
    mode: 0o600,
  });
  await chmod(policyFile(home), 0o600);
  return merged;
}

export async function resetPolicy(
  home: string = defaultHome(),
): Promise<PolicyConfig> {
  await mkdir(home, { recursive: true });
  const fresh = cloneDefault();
  await writeFile(policyFile(home), JSON.stringify(fresh, null, 2), {
    mode: 0o600,
  });
  await chmod(policyFile(home), 0o600);
  return fresh;
}

function cloneDefault(): PolicyConfig {
  // Deep clone so callers can't mutate the constant.
  return JSON.parse(JSON.stringify(DEFAULT_POLICY)) as PolicyConfig;
}

function normalizePolicy(p: PolicyConfig): PolicyConfig {
  const mode: PolicyMode = (['strict', 'policy', 'bypass'] as const).includes(p.mode)
    ? p.mode
    : 'policy';
  // Drop chain-specific entries whose key isn't a known ChainKey.
  const known = new Set<string>(CHAIN_KEYS);
  const chains: Partial<Record<ChainKey, PolicyCaps>> = {};
  for (const [k, v] of Object.entries(p.chains ?? {})) {
    if (known.has(k)) chains[k as ChainKey] = sanitizeCaps(v);
  }
  return {
    version: 1,
    mode,
    unlockTtlSeconds:
      Number.isFinite(p.unlockTtlSeconds) && p.unlockTtlSeconds > 0
        ? Math.floor(p.unlockTtlSeconds)
        : DEFAULT_POLICY.unlockTtlSeconds,
    rateLimit: {
      perMinute:
        Number.isFinite(p.rateLimit?.perMinute) && p.rateLimit.perMinute > 0
          ? Math.floor(p.rateLimit.perMinute)
          : DEFAULT_POLICY.rateLimit.perMinute,
    },
    global: sanitizeCaps(p.global),
    chains,
    allowlist: {
      payTo: Array.from(new Set(p.allowlist?.payTo ?? [])),
      urls: Array.from(new Set(p.allowlist?.urls ?? [])),
    },
    denylist: {
      payTo: Array.from(new Set(p.denylist?.payTo ?? [])),
      urls: Array.from(new Set(p.denylist?.urls ?? [])),
    },
  };
}

function sanitizeCaps(c: PolicyCaps | undefined): PolicyCaps {
  const pick = (n: unknown): number | undefined =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  return {
    maxPerTxMicros: pick(c?.maxPerTxMicros),
    maxPerDayMicros: pick(c?.maxPerDayMicros),
    requireConfirmAboveMicros: pick(c?.requireConfirmAboveMicros),
  };
}

/** Walk a `dot.path` and patch a single field. Safe — no eval, no proto walk. */
export function patchPolicyAt<P extends PolicyConfig>(
  policy: P,
  path: string,
  rawValue: string,
): P {
  const segments = path.split('.').filter(Boolean);
  if (segments.length === 0) throw new Error('empty policy path');
  // Forbid prototype / function pollution paths.
  for (const s of segments) {
    if (s === '__proto__' || s === 'prototype' || s === 'constructor') {
      throw new Error(`forbidden path segment: ${s}`);
    }
  }
  const value = coerce(rawValue);
  const clone = JSON.parse(JSON.stringify(policy)) as P;
  let cur: Record<string, unknown> = clone as unknown as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const k = segments[i]!;
    const next = cur[k];
    if (typeof next !== 'object' || next === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]!] = value;
  return clone;
}

function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  // Try JSON (arrays, objects); fall back to string.
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// ─── MCP bearer token ────────────────────────────────────────────────────────
/** Read the bearer token, or null if the install pre-dates the upgrade. */
export async function readMcpToken(
  home: string = defaultHome(),
): Promise<string | null> {
  const f = tokenFile(home);
  if (!existsSync(f)) return null;
  try {
    return (await readFile(f, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/** Generate (if missing) and return a 32-byte hex bearer token. Idempotent. */
export async function ensureMcpToken(
  home: string = defaultHome(),
): Promise<string> {
  const existing = await readMcpToken(home);
  if (existing) return existing;
  await mkdir(home, { recursive: true });
  const token = randomBytes(32).toString('hex');
  await writeFile(tokenFile(home), token + '\n', { mode: 0o600 });
  await chmod(tokenFile(home), 0o600);
  return token;
}

// ─── Audit log path (writer lives in mcp.ts) ─────────────────────────────────
export const auditLogPath = (home: string = defaultHome()): string =>
  join(home, 'audit.log');

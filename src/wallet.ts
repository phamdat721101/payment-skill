// Local wallet store at ~/.n-payment/wallets/<name>.json (chmod 0600).
//
// Single responsibility: generate, load, list wallets. Never log private keys.
// All public functions accept an optional `home` for test isolation.

import { mkdir, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export interface WalletRecord {
  name: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  createdAt: string;
}

/** Public summary that omits the private key — safe to print. */
export interface WalletSummary {
  name: string;
  address: `0x${string}`;
  createdAt: string;
}

export const defaultHome = (): string => join(homedir(), '.n-payment');

const walletDir = (home: string): string => join(home, 'wallets');
const fileFor = (home: string, name: string): string =>
  join(walletDir(home), `${name}.json`);

export async function loadWallet(
  name: string,
  home: string = defaultHome(),
): Promise<WalletRecord | null> {
  const f = fileFor(home, name);
  if (!existsSync(f)) return null;
  return JSON.parse(await readFile(f, 'utf8')) as WalletRecord;
}

export async function createWallet(
  name: string,
  home: string = defaultHome(),
): Promise<WalletRecord> {
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

export async function ensureWallet(
  name: string,
  home: string = defaultHome(),
): Promise<WalletRecord> {
  return (await loadWallet(name, home)) ?? createWallet(name, home);
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
      const r = JSON.parse(await readFile(join(dir, f), 'utf8')) as WalletRecord;
      summaries.push({ name: r.name, address: r.address, createdAt: r.createdAt });
    } catch {
      // skip malformed file
    }
  }
  return summaries;
}

/** Strip the private key for safe display. */
export const summarize = (w: WalletRecord): WalletSummary => ({
  name: w.name,
  address: w.address,
  createdAt: w.createdAt,
});

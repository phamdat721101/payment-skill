import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const service = 'n-payment-xrpl-wallet';

export interface XrplWalletProfile {
  name: string;
  address: string;
  createdAt: string;
  keychainService: string;
}

const root = (home = join(homedir(), '.n-payment')) => join(home, 'xrpl-wallets');
const pathFor = (name: string, home?: string) => join(root(home), `${name}.json`);

function validName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
}

async function keychain(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('security', args, { encoding: 'utf8' });
  return stdout.trim();
}

/** Creates a testnet-ready XRPL identity. The seed is written only to Keychain. */
export async function createXrplWallet(name: string, home?: string): Promise<XrplWalletProfile> {
  if (!validName(name)) throw Object.assign(new Error('wallet name must be alphanumeric, underscore, or hyphen'), { code: 'INVALID_WALLET_NAME' });
  if (existsSync(pathFor(name, home))) throw Object.assign(new Error(`XRPL wallet "${name}" already exists`), { code: 'WALLET_EXISTS' });
  const { Wallet } = await import('xrpl');
  const wallet = Wallet.generate();
  if (!wallet.seed) throw new Error('XRPL wallet generation returned no seed');
  await keychain(['add-generic-password', '-U', '-s', service, '-a', name, '-w', wallet.seed]);
  const profile: XrplWalletProfile = { name, address: wallet.classicAddress, createdAt: new Date().toISOString(), keychainService: service };
  const dir = root(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(pathFor(name, home), JSON.stringify(profile, null, 2), { mode: 0o600 });
  await chmod(pathFor(name, home), 0o600);
  return profile;
}

export async function getXrplWalletProfile(name: string, home?: string): Promise<XrplWalletProfile | null> {
  const file = pathFor(name, home);
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) as XrplWalletProfile : null;
}

/** Internal signer path. Never expose this value through a tool result. */
export async function getXrplWalletSeed(name: string): Promise<string> {
  return keychain(['find-generic-password', '-s', service, '-a', name, '-w']);
}

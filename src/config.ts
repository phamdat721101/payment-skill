// Skill-level config at ~/.n-payment/config.json. Separate file from wallet
// store so private keys and user preferences never share a permissions
// boundary.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultHome } from './wallet.js';
import { CHAIN_KEYS, type ChainKey } from './tools.js';

export interface SkillConfig {
  defaultWallet: string;
  defaultChain: ChainKey;
  testnetMode: boolean;
  telemetry: 'off' | 'community' | 'anonymous';
}

export const DEFAULT_CONFIG: SkillConfig = {
  defaultWallet: 'default',
  defaultChain: 'goat-testnet',
  testnetMode: true,
  telemetry: 'off',
};

const configFile = (home: string): string => join(home, 'config.json');

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
  return merged;
}

function normalize(c: SkillConfig): SkillConfig {
  // Guard against bad on-disk values.
  const chain = (CHAIN_KEYS as readonly string[]).includes(c.defaultChain)
    ? c.defaultChain
    : DEFAULT_CONFIG.defaultChain;
  // Mainnet chains imply !testnetMode; preserve user override otherwise.
  const onMainnet = /-mainnet$/.test(chain);
  const testnetMode = onMainnet ? false : c.testnetMode;
  const telemetry = (['off', 'community', 'anonymous'] as const).includes(
    c.telemetry,
  )
    ? c.telemetry
    : DEFAULT_CONFIG.telemetry;
  return { ...c, defaultChain: chain, testnetMode, telemetry };
}

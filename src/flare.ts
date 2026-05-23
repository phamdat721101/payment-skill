// Flare FAssets / Smart Accounts module — read-only state lookup + reference
// encoding. Pure; depends only on viem and chain metadata. Memoizes clients
// and contract-registry resolutions per process for performance.
//
// SOLID:
//   • Single responsibility: read Flare state and encode the FXRP
//     collateralReservation reference. The handler owns the XRPL submit and
//     polling loop.
//   • Open for extension: new instructions get a new encoder, not a new
//     module.
//   • No side effects beyond a process-local read-through cache.

import {
  createPublicClient,
  defineChain,
  erc20Abi,
  http,
  concat,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { CHAIN_META } from './faucet.js';

// Subset of ChainKey accepted here (avoids importing the wide union and
// keeps this module decoupled from the tool registry).
export type FlareChain = 'flare-coston2' | 'flare-mainnet';

/** FlareContractRegistry — same canonical address on all Flare networks. */
export const FLARE_CONTRACT_REGISTRY: Address =
  '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';

// ── Minimal ABIs (only the functions actually called) ──────────────────────
const flareContractRegistryAbi = [
  {
    type: 'function',
    name: 'getContractAddressByName',
    stateMutability: 'view',
    inputs: [{ name: '_name', type: 'string' }],
    outputs: [{ type: 'address' }],
  },
] as const;

const masterAccountControllerAbi = [
  {
    type: 'function',
    name: 'getXrplProviderWallets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string[]' }],
  },
  {
    type: 'function',
    name: 'getAgentVaults',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256[]' }, { type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getPersonalAccount',
    stateMutability: 'view',
    inputs: [{ name: 'xrplAddress', type: 'string' }],
    outputs: [{ type: 'address' }],
  },
] as const;

const assetManagerAbi = [
  {
    type: 'function',
    name: 'fAsset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

// ── Memoized public client per chain ───────────────────────────────────────
const clientCache = new Map<FlareChain, PublicClient>();

function getClient(chain: FlareChain): PublicClient {
  const cached = clientCache.get(chain);
  if (cached) return cached;
  const meta = CHAIN_META[chain];
  const c = createPublicClient({
    chain: defineChain({
      id: meta.chainId,
      name: meta.name,
      nativeCurrency: { name: 'FLR', symbol: 'FLR', decimals: 18 },
      rpcUrls: { default: { http: [meta.rpcUrl] } },
    }),
    transport: http(meta.rpcUrl),
  }) as PublicClient;
  clientCache.set(chain, c);
  return c;
}

// ── Memoized FlareContractRegistry resolver ────────────────────────────────
const addressCache = new Map<string, Address>(); // key: `${chain}:${name}`

const ZERO: Address = '0x0000000000000000000000000000000000000000';

export async function getContractAddressByName(
  name: string,
  chain: FlareChain,
): Promise<Address> {
  const key = `${chain}:${name}`;
  const cached = addressCache.get(key);
  if (cached) return cached;
  const addr = (await getClient(chain).readContract({
    address: FLARE_CONTRACT_REGISTRY,
    abi: flareContractRegistryAbi,
    functionName: 'getContractAddressByName',
    args: [name],
  })) as Address;
  if (!addr || addr === ZERO) {
    throw Object.assign(
      new Error(`Flare contract "${name}" is not registered on ${chain}.`),
      { code: 'FLARE_NOT_CONFIGURED' },
    );
  }
  addressCache.set(key, addr);
  return addr;
}

export const getMasterAccountControllerAddress = (chain: FlareChain) =>
  getContractAddressByName('MasterAccountController', chain);

export const getAssetManagerFXRPAddress = (chain: FlareChain) =>
  getContractAddressByName('AssetManagerFXRP', chain);

export async function getFxrpAddress(chain: FlareChain): Promise<Address> {
  const am = await getAssetManagerFXRPAddress(chain);
  return (await getClient(chain).readContract({
    address: am,
    abi: assetManagerAbi,
    functionName: 'fAsset',
  })) as Address;
}

// ── State lookups ──────────────────────────────────────────────────────────
export async function getOperatorXrplAddresses(
  chain: FlareChain,
): Promise<string[]> {
  const mac = await getMasterAccountControllerAddress(chain);
  return (await getClient(chain).readContract({
    address: mac,
    abi: masterAccountControllerAbi,
    functionName: 'getXrplProviderWallets',
  })) as string[];
}

export type AgentVault = { id: bigint; address: Address };

export async function getAgentVaults(chain: FlareChain): Promise<AgentVault[]> {
  const mac = await getMasterAccountControllerAddress(chain);
  const [ids, addresses] = (await getClient(chain).readContract({
    address: mac,
    abi: masterAccountControllerAbi,
    functionName: 'getAgentVaults',
  })) as readonly [readonly bigint[], readonly Address[]];
  return ids.map((id, i) => ({ id, address: addresses[i]! }));
}

export async function getPersonalAccountAddress(
  xrplAddress: string,
  chain: FlareChain,
): Promise<Address> {
  const mac = await getMasterAccountControllerAddress(chain);
  return (await getClient(chain).readContract({
    address: mac,
    abi: masterAccountControllerAbi,
    functionName: 'getPersonalAccount',
    args: [xrplAddress],
  })) as Address;
}

export async function getFxrpBalance(
  addr: Address,
  chain: FlareChain,
): Promise<bigint> {
  const fxrp = await getFxrpAddress(chain);
  return (await getClient(chain).readContract({
    address: fxrp,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [addr],
  })) as bigint;
}

// ── Reference encoder (FXRP collateralReservation) ─────────────────────────
// Layout (32 bytes):
//   byte 0  : instruction code = 0x00 (high nibble: FXRP type 0; low nibble: collateralReservation command 0)
//   byte 1  : wallet identifier (default 0)
//   bytes 2..17  (16 bytes) : agentVaultId, uint128 big-endian
//   bytes 18..31 (14 bytes) : lots,         uint112 big-endian
export function encodeCollateralReservationReference(opts: {
  agentVaultId: bigint;
  lots: bigint;
  walletId?: number;
}): Hex {
  if (opts.agentVaultId < 0n || opts.agentVaultId >= 1n << 128n) {
    throw new Error('agentVaultId out of range (uint128).');
  }
  if (opts.lots <= 0n || opts.lots >= 1n << 112n) {
    throw new Error('lots must be a positive uint112.');
  }
  const walletId = opts.walletId ?? 0;
  if (walletId < 0 || walletId > 0xff) {
    throw new Error('walletId must fit in one byte.');
  }
  return concat([
    toHex(0x00, { size: 1 }),
    toHex(walletId, { size: 1 }),
    toHex(opts.agentVaultId, { size: 16 }),
    toHex(opts.lots, { size: 14 }),
  ]);
}

// ── Hybrid n-payment v0.15 SDK probe (best-effort) ─────────────────────────
// Returns the SDK's Flare namespace if v0.15 ships one; otherwise null and
// the handler uses the viem-direct path above. Probed once per process.
let _sdkProbed = false;
let _sdk: unknown = null;

export async function loadFlareSdk(): Promise<unknown | null> {
  if (_sdkProbed) return _sdk;
  _sdkProbed = true;
  try {
    // @ts-expect-error optional peer dep
    const mod = (await import('n-payment')) as Record<string, unknown>;
    _sdk =
      (mod as { flare?: unknown }).flare ??
      (mod as { Flare?: unknown }).Flare ??
      ((mod as { createFlareClient?: unknown }).createFlareClient ? mod : null);
  } catch {
    _sdk = null;
  }
  return _sdk;
}

// ── Test seam ──────────────────────────────────────────────────────────────
// Allows test/flare.test.ts to inject a fake publicClient without going to
// the network. Only used in tests; production code never calls this.
export function __setClientForTest(chain: FlareChain, client: PublicClient): void {
  clientCache.set(chain, client);
  // Reset memoized addresses for the chain so the next read consults the fake.
  for (const key of Array.from(addressCache.keys())) {
    if (key.startsWith(`${chain}:`)) addressCache.delete(key);
  }
}

export function __resetForTest(): void {
  clientCache.clear();
  addressCache.clear();
  _sdkProbed = false;
  _sdk = null;
}

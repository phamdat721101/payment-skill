// Morpho read-only research module — position snapshots + market comparison
// via @morpho-org/morpho-sdk (optional peer dependency). Pure reads only:
// no transaction building, no signing, no dispatcher involvement.
//
// SOLID:
//   • Single responsibility: fetch + shape Morpho Blue market/position state.
//   • Depends on the SDK's documented /fetch subpath (fetchMarket,
//     fetchAccrualPosition) — never reaches into internal SDK modules.
//   • No side effects beyond a process-local read-through client cache
//     (mirrors src/flare.ts's memoization pattern).

import { createPublicClient, defineChain, http, type Address, type PublicClient } from 'viem';
import { CHAIN_META } from './faucet.js';

export type MorphoChain =
  | 'ethereum-mainnet'
  | 'base-mainnet'
  | 'base-sepolia'
  | 'arbitrum-one';

const MORPHO_CHAIN_META: Record<MorphoChain, { chainId: number; name: string; rpcUrl: string }> = {
  'ethereum-mainnet': CHAIN_META['ethereum-mainnet'],
  'base-mainnet': CHAIN_META['base-mainnet'],
  'base-sepolia': CHAIN_META['base-sepolia'],
  'arbitrum-one': {
    chainId: 42161,
    name: 'Arbitrum One',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
  },
};

// ── Memoized public client per chain (mirrors src/flare.ts) ────────────────
const clientCache = new Map<MorphoChain, PublicClient>();

function getClient(chain: MorphoChain): PublicClient {
  const cached = clientCache.get(chain);
  if (cached) return cached;
  const meta = MORPHO_CHAIN_META[chain];
  const c = createPublicClient({
    chain: defineChain({
      id: meta.chainId,
      name: meta.name,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [meta.rpcUrl] } },
    }),
    transport: http(meta.rpcUrl),
  }) as PublicClient;
  clientCache.set(chain, c);
  return c;
}

/** Test-only hook: inject a fake publicClient, skipping the network. */
export function __setMorphoClientForTest(chain: MorphoChain, client: PublicClient): void {
  clientCache.set(chain, client);
}

/** Test-only hook: clear the memoized client cache between test cases. */
export function __resetMorphoClientsForTest(): void {
  clientCache.clear();
}

// ── SDK loader (optional peer dependency) ───────────────────────────────────
let _fetchMod: typeof import('@morpho-org/morpho-sdk/fetch') | null = null;

async function loadMorphoFetch(): Promise<typeof import('@morpho-org/morpho-sdk/fetch')> {
  if (_fetchMod) return _fetchMod;
  try {
    _fetchMod = await import('@morpho-org/morpho-sdk/fetch');
    return _fetchMod;
  } catch {
    throw Object.assign(
      new Error(
        '@morpho-org/morpho-sdk not found. Install: `npm i @morpho-org/morpho-sdk`.',
      ),
      { code: 'MORPHO_SDK_MISSING' },
    );
  }
}

/** Test-only hook: inject a fake fetch module, skipping the real import. */
export function __setMorphoFetchForTest(
  mod: typeof import('@morpho-org/morpho-sdk/fetch') | null,
): void {
  _fetchMod = mod;
}

const MARKET_ID_RE = /^0x[a-fA-F0-9]{64}$/;

export function isValidMorphoMarketId(value: string): boolean {
  return MARKET_ID_RE.test(value);
}

export interface MorphoPositionSnapshot {
  chain: MorphoChain;
  market_id: string;
  user: Address;
  supplied_assets: string;
  borrowed_assets: string;
  collateral: string;
  ltv_pct: number | null;
  health_factor: number | null;
  is_healthy: boolean | null;
  liquidation_price: string | null;
}

const WAD = 10n ** 18n;

function wadToNumber(v: bigint): number {
  return Number(v) / Number(WAD);
}

/**
 * Read-only Morpho Blue position snapshot for a single user on a single
 * market: supplied/borrowed assets, collateral, LTV, health factor, and
 * liquidation price. Pure on-chain reads via fetchAccrualPosition — no
 * transaction building.
 */
export async function fetchMorphoPositionSnapshot(opts: {
  chain: MorphoChain;
  marketId: string;
  user: Address;
}): Promise<MorphoPositionSnapshot> {
  if (!isValidMorphoMarketId(opts.marketId)) {
    throw Object.assign(
      new Error('market_address must be a 32-byte hex Morpho market id (0x + 64 hex chars).'),
      { code: 'INVALID_MARKET_ID' },
    );
  }
  const { fetchAccrualPosition } = await loadMorphoFetch();
  const client = getClient(opts.chain);
  const position = await fetchAccrualPosition(
    opts.user,
    opts.marketId as never,
    client as never,
  );
  const ltv = position.ltv;
  const healthFactor = position.healthFactor;
  const liquidationPrice = position.liquidationPrice;
  return {
    chain: opts.chain,
    market_id: opts.marketId,
    user: opts.user,
    supplied_assets: position.supplyAssets.toString(),
    borrowed_assets: position.borrowAssets.toString(),
    collateral: position.collateral.toString(),
    ltv_pct: ltv == null ? null : Number((wadToNumber(ltv) * 100).toFixed(4)),
    health_factor: healthFactor == null ? null : Number(wadToNumber(healthFactor).toFixed(4)),
    is_healthy: position.isHealthy ?? null,
    liquidation_price: liquidationPrice == null ? null : liquidationPrice.toString(),
  };
}

export interface MorphoMarketSummary {
  market_id: string;
  total_supply_assets: string;
  total_borrow_assets: string;
  utilization_pct: number;
  supply_apy_pct: number;
}

/**
 * Read-only comparison across N candidate Morpho Blue markets: TVL,
 * utilization, and supply APY per market, sorted descending by supply APY.
 * The SDK has no market-discovery endpoint — callers must supply the
 * candidate market_ids to compare. A market that fails to fetch (bad id,
 * RPC error) is dropped from the result rather than failing the whole scan.
 */
export async function fetchMorphoMarketComparisons(opts: {
  chain: MorphoChain;
  marketIds: readonly string[];
  limit?: number;
}): Promise<MorphoMarketSummary[]> {
  for (const id of opts.marketIds) {
    if (!isValidMorphoMarketId(id)) {
      throw Object.assign(
        new Error(`Invalid Morpho market id in market_ids: ${id}`),
        { code: 'INVALID_MARKET_ID' },
      );
    }
  }
  const { fetchMarket } = await loadMorphoFetch();
  const client = getClient(opts.chain);
  const results = await Promise.allSettled(
    opts.marketIds.map((id) => fetchMarket(id as never, client as never)),
  );
  const summaries: MorphoMarketSummary[] = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const market = r.value;
    summaries.push({
      market_id: opts.marketIds[i]!,
      total_supply_assets: market.totalSupplyAssets.toString(),
      total_borrow_assets: market.totalBorrowAssets.toString(),
      utilization_pct: Number((wadToNumber(market.utilization) * 100).toFixed(4)),
      supply_apy_pct: Number((market.supplyApy * 100).toFixed(4)),
    });
  });
  summaries.sort((a, b) => b.supply_apy_pct - a.supply_apy_pct);
  return opts.limit ? summaries.slice(0, opts.limit) : summaries;
}

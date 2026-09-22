// Pendle read-only research module — market comparison + APY-breakdown
// analysis via Pendle's public Backend REST API. Independent of n-payment
// (which has no Pendle integration) and of any Pendle SDK: Pendle's own
// docs steer analytics/APY use cases to the REST API, not the on-chain
// Hosted SDK ("Use the API unless you have a specific need for on-chain
// reads" — docs.pendle.finance/pendle-v2-dev/Backend/ApiOverview).
//
// SOLID:
//   • Single responsibility: fetch + shape Pendle market data over HTTP.
//   • No SDK dependency — plain fetch(), rate-limit-aware.
//   • Test seam: __setPendleFetchForTest injects a fake fetch, so unit
//     tests never make a real network call.

const PENDLE_API_BASE = 'https://api-v2.pendle.finance/core';

// ── Test seam ────────────────────────────────────────────────────────────────
type FetchLike = typeof fetch;
let _fetchImpl: FetchLike = fetch;

/** Test-only hook: inject a fake fetch, skipping the real network call. */
export function __setPendleFetchForTest(impl: FetchLike | null): void {
  _fetchImpl = impl ?? fetch;
}

// ── Rate-limit-aware GET wrapper ────────────────────────────────────────────
// Pendle's documented best practice: never hardcode limits, handle 429 with
// exponential backoff. Free tier: 200 CU/min, 200k CU/week (no API key
// required for baseline reads). PENDLE_API_KEY (Bearer) is honored when set,
// for callers who need higher limits — never required for baseline reads.
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

async function pendleGet(
  path: string,
  opts: { apiKey?: string; sleepMs?: (ms: number) => Promise<void> } = {},
): Promise<unknown> {
  const sleep = opts.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await _fetchImpl(`${PENDLE_API_BASE}${path}`, { headers });
    if (res.status === 429) {
      lastErr = Object.assign(new Error(`Pendle API rate-limited (429) on ${path}.`), {
        code: 'PENDLE_RATE_LIMITED',
      });
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    if (!res.ok) {
      throw Object.assign(
        new Error(`Pendle API returned ${res.status} for ${path}.`),
        { code: 'PENDLE_API_ERROR' },
      );
    }
    return res.json();
  }
  throw lastErr ?? new Error('Pendle API request failed.');
}

export interface PendleMarketSummary {
  address: string;
  chain_id: number;
  symbol?: string;
  tvl_usd?: number;
  volume_usd_24h?: number;
  underlying_apy_pct?: number;
  implied_apy_pct?: number;
  swap_fee_pct?: number;
}

// Raw shape is intentionally loose — Pendle's /v2/markets/all response has
// many fields we don't use; we only pick the ones we report.
interface RawPendleMarket {
  address?: string;
  chainId?: number;
  symbol?: string;
  name?: string;
  tvl?: number;
  volume24h?: { usd?: number } | number;
  underlyingApy?: number;
  impliedApy?: number;
  swapFee?: number;
}

function shapeMarket(raw: RawPendleMarket): PendleMarketSummary | null {
  if (!raw.address || typeof raw.chainId !== 'number') return null;
  const volumeUsd =
    typeof raw.volume24h === 'number' ? raw.volume24h : raw.volume24h?.usd;
  return {
    address: raw.address,
    chain_id: raw.chainId,
    symbol: raw.symbol ?? raw.name,
    tvl_usd: raw.tvl,
    volume_usd_24h: volumeUsd,
    underlying_apy_pct:
      typeof raw.underlyingApy === 'number' ? raw.underlyingApy * 100 : undefined,
    implied_apy_pct: typeof raw.impliedApy === 'number' ? raw.impliedApy * 100 : undefined,
    swap_fee_pct: typeof raw.swapFee === 'number' ? raw.swapFee * 100 : undefined,
  };
}

/**
 * Read-only cross-chain Pendle market comparison via GET /v2/markets/all.
 * Ranks markets by implied APY descending. Pure HTTP reads — no signing.
 */
export async function fetchPendleMarketComparisons(opts: {
  chainId?: number;
  limit?: number;
  apiKey?: string;
}): Promise<PendleMarketSummary[]> {
  const limit = Math.min(opts.limit ?? 10, 100);
  const chainParam = opts.chainId != null ? `&chainId=${opts.chainId}` : '';
  const raw = (await pendleGet(`/v2/markets/all?limit=${limit}${chainParam}`, {
    apiKey: opts.apiKey,
  })) as { results?: RawPendleMarket[] };
  const markets = (raw.results ?? [])
    .map(shapeMarket)
    .filter((m): m is PendleMarketSummary => m !== null)
    .filter((m) => (opts.chainId == null ? true : m.chain_id === opts.chainId));
  markets.sort((a, b) => (b.implied_apy_pct ?? 0) - (a.implied_apy_pct ?? 0));
  return opts.limit ? markets.slice(0, opts.limit) : markets;
}

export interface PendleApyBreakdownCategory {
  category: string;
  apy_pct: number;
}

export interface PendleMarketAnalysis {
  chain_id: number;
  market_address: string;
  yt_apy_breakdown: PendleApyBreakdownCategory[];
  lp_apy_breakdown: PendleApyBreakdownCategory[];
}

// Raw shape per docs.pendle.finance's v3 historical-data response: each
// breakdown entry is either a dictionary or contains a categories array.
interface RawApyBreakdown {
  ytApyBreakdown?: Record<string, number> | { categories?: Array<{ label?: string; apy?: number }> };
  lpApyBreakdown?: Record<string, number> | { categories?: Array<{ label?: string; apy?: number }> };
}

function shapeBreakdown(
  raw: Record<string, number> | { categories?: Array<{ label?: string; apy?: number }> } | undefined,
): PendleApyBreakdownCategory[] {
  if (!raw || typeof raw !== 'object') return [];
  if ('categories' in raw && Array.isArray(raw.categories)) {
    return raw.categories.map((c) => ({
      category: c.label ?? 'Unknown',
      apy_pct: Number(((c.apy ?? 0) * 100).toFixed(4)),
    }));
  }
  return Object.entries(raw as Record<string, number>).map(([category, decimalFraction]) => ({
    category,
    apy_pct: Number(((decimalFraction ?? 0) * 100).toFixed(4)),
  }));
}

/**
 * Read-only APY composition breakdown for one Pendle market via
 * GET /v3/{chainId}/markets/{address}/historical-data?includeApyBreakdown=true.
 * Returns the most recent breakdown entry's YT/LP category splits (Protocol
 * Yield, Rewards, Fixed Yield, Incentives, etc. — category names come
 * directly from Pendle's API, not hardcoded here). Pure HTTP reads.
 */
export async function fetchPendleMarketAnalysis(opts: {
  chainId: number;
  marketAddress: string;
  apiKey?: string;
}): Promise<PendleMarketAnalysis> {
  const raw = (await pendleGet(
    `/v3/${opts.chainId}/markets/${opts.marketAddress}/historical-data?includeApyBreakdown=true&time_frame=day`,
    { apiKey: opts.apiKey },
  )) as { results?: RawApyBreakdown[] } | RawApyBreakdown;
  // The endpoint returns a time-series; take the most recent entry.
  const series = 'results' in raw && Array.isArray(raw.results) ? raw.results : [raw as RawApyBreakdown];
  const latest = series[series.length - 1] ?? {};
  return {
    chain_id: opts.chainId,
    market_address: opts.marketAddress,
    yt_apy_breakdown: shapeBreakdown(latest.ytApyBreakdown),
    lp_apy_breakdown: shapeBreakdown(latest.lpApyBreakdown),
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_BY_NAME, TOOL_NAMES } from '../src/tools.js';
import type { ToolContext } from '../src/tools.js';
import { __setPendleFetchForTest } from '../src/pendle.js';

const ctx = (env: NodeJS.ProcessEnv = {}): ToolContext => ({
  walletName: 'default',
  defaultChain: 'base-mainnet',
  testnetMode: true,
  env,
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  __setPendleFetchForTest(null);
});

describe('pendle_market_scan — registry & schema', () => {
  const t = TOOL_BY_NAME.pendle_market_scan!;

  it('is registered exactly once', () => {
    expect(t).toBeDefined();
    expect(TOOL_NAMES.filter((n) => n === 'pendle_market_scan')).toHaveLength(1);
  });

  it('requires a valid action', () => {
    expect(t.schema.safeParse({}).success).toBe(false);
    expect(t.schema.safeParse({ action: 'compare' }).success).toBe(true);
    expect(t.schema.safeParse({ action: 'analyze' }).success).toBe(true);
    expect(t.schema.safeParse({ action: 'invalid' }).success).toBe(false);
  });

  it('defaults limit to 10', () => {
    const r = t.schema.parse({ action: 'compare' }) as { limit: number };
    expect(r.limit).toBe(10);
  });

  it('rejects a malformed market_address', () => {
    expect(
      t.schema.safeParse({ action: 'analyze', market_address: '0xbad' }).success,
    ).toBe(false);
  });
});

describe('pendle_market_scan — handler (action=compare)', () => {
  it('fetches /v2/markets/all and ranks by implied APY descending', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse(200, {
        results: [
          {
            address: '0x1111111111111111111111111111111111111111',
            chainId: 8453,
            symbol: 'PT-USDe',
            tvl: 1_000_000,
            volume24h: { usd: 50_000 },
            underlyingApy: 0.04,
            impliedApy: 0.06,
            swapFee: 0.001,
          },
          {
            address: '0x2222222222222222222222222222222222222222',
            chainId: 8453,
            symbol: 'PT-sUSDe',
            tvl: 2_000_000,
            volume24h: 80_000,
            underlyingApy: 0.09,
            impliedApy: 0.12,
            swapFee: 0.001,
          },
        ],
      }),
    );
    __setPendleFetchForTest(fakeFetch as never);

    const t = TOOL_BY_NAME.pendle_market_scan!;
    const r = await t.handler({ action: 'compare', limit: 10 }, ctx());

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { markets: Array<Record<string, unknown>> };
      expect(data.markets).toHaveLength(2);
      // Sorted descending by implied_apy_pct: PT-sUSDe (12%) > PT-USDe (6%)
      expect(data.markets[0]!.symbol).toBe('PT-sUSDe');
      expect(data.markets[0]!.implied_apy_pct).toBeCloseTo(12, 2);
      expect(data.markets[0]!.tvl_usd).toBe(2_000_000);
      expect(data.markets[0]!.volume_usd_24h).toBe(80_000);
      expect(data.markets[1]!.symbol).toBe('PT-USDe');
    }
    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url] = fakeFetch.mock.calls[0]!;
    expect(String(url)).toContain('/v2/markets/all');
  });

  it('filters results by chain_id', async () => {
    __setPendleFetchForTest(
      vi.fn(async () =>
        jsonResponse(200, {
          results: [
            {
              address: '0x1111111111111111111111111111111111111111',
              chainId: 8453,
              impliedApy: 0.05,
            },
            {
              address: '0x2222222222222222222222222222222222222222',
              chainId: 1,
              impliedApy: 0.2,
            },
          ],
        }),
      ) as never,
    );

    const t = TOOL_BY_NAME.pendle_market_scan!;
    const r = await t.handler({ action: 'compare', chain_id: 8453, limit: 10 }, ctx());

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { markets: Array<Record<string, unknown>> };
      expect(data.markets).toHaveLength(1);
      expect(data.markets[0]!.chain_id).toBe(8453);
    }
  });

  it('retries with backoff on 429 and eventually succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse(429, {});
      return jsonResponse(200, { results: [] });
    });
    __setPendleFetchForTest(fakeFetch as never);

    const t = TOOL_BY_NAME.pendle_market_scan!;
    const pending = t.handler({ action: 'compare', limit: 10 }, ctx());
    await vi.runAllTimersAsync();
    const r = await pending;
    vi.useRealTimers();

    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('fails with PENDLE_RATE_LIMITED after exhausting retries', async () => {
    vi.useFakeTimers();
    __setPendleFetchForTest(vi.fn(async () => jsonResponse(429, {})) as never);

    const t = TOOL_BY_NAME.pendle_market_scan!;
    const pending = t.handler({ action: 'compare', limit: 10 }, ctx());
    await vi.runAllTimersAsync();
    const r = await pending;
    vi.useRealTimers();

    expect(r).toMatchObject({ ok: false, code: 'PENDLE_RATE_LIMITED' });
  });

  it('fails with PENDLE_API_ERROR for a non-429 non-2xx response (e.g. 503)', async () => {
    __setPendleFetchForTest(vi.fn(async () => jsonResponse(503, {})) as never);

    const t = TOOL_BY_NAME.pendle_market_scan!;
    const r = await t.handler({ action: 'compare', limit: 10 }, ctx());

    expect(r).toMatchObject({ ok: false, code: 'PENDLE_API_ERROR' });
  });

  it('forwards PENDLE_API_KEY as a Bearer header when set', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse(200, { results: [] }));
    __setPendleFetchForTest(fakeFetch as never);

    const t = TOOL_BY_NAME.pendle_market_scan!;
    await t.handler({ action: 'compare', limit: 10 }, ctx({ PENDLE_API_KEY: 'secret-key' }));

    const [, init] = fakeFetch.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Bearer secret-key',
    );
  });
});

describe('pendle_market_scan — handler (action=analyze)', () => {
  const MARKET = '0x1111111111111111111111111111111111111111';

  it('fails with MISSING_ARG when market_address is omitted', async () => {
    const t = TOOL_BY_NAME.pendle_market_scan!;
    const r = await t.handler({ action: 'analyze', chain_id: 8453, limit: 10 }, ctx());
    expect(r).toMatchObject({ ok: false, code: 'MISSING_ARG' });
  });

  it('fails with MISSING_ARG when chain_id is omitted', async () => {
    const t = TOOL_BY_NAME.pendle_market_scan!;
    const r = await t.handler(
      { action: 'analyze', market_address: MARKET, limit: 10 },
      ctx(),
    );
    expect(r).toMatchObject({ ok: false, code: 'MISSING_ARG' });
  });

  it('fetches the v3 historical-data endpoint and shapes the APY breakdown', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse(200, {
        results: [
          {
            timestamp: 1_700_000_000,
            ytApyBreakdown: {
              'Protocol Yield': 0.03,
              'YT Bonus Rewards': 0.01,
            },
            lpApyBreakdown: {
              'Underlying Yield': 0.02,
              'PT Fixed Yield': 0.015,
              'LP Rewards': 0.005,
            },
          },
        ],
      }),
    );
    __setPendleFetchForTest(fakeFetch as never);

    const t = TOOL_BY_NAME.pendle_market_scan!;
    const r = await t.handler(
      { action: 'analyze', chain_id: 8453, market_address: MARKET, limit: 10 },
      ctx(),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        chain_id: number;
        market_address: string;
        yt_apy_breakdown: Array<{ category: string; apy_pct: number }>;
        lp_apy_breakdown: Array<{ category: string; apy_pct: number }>;
      };
      expect(data.chain_id).toBe(8453);
      expect(data.market_address).toBe(MARKET);
      expect(data.yt_apy_breakdown).toEqual(
        expect.arrayContaining([
          { category: 'Protocol Yield', apy_pct: 3 },
          { category: 'YT Bonus Rewards', apy_pct: 1 },
        ]),
      );
      expect(data.lp_apy_breakdown).toEqual(
        expect.arrayContaining([
          { category: 'Underlying Yield', apy_pct: 2 },
          { category: 'PT Fixed Yield', apy_pct: 1.5 },
          { category: 'LP Rewards', apy_pct: 0.5 },
        ]),
      );
    }
    const [url] = fakeFetch.mock.calls[0]!;
    expect(String(url)).toContain(`/v3/8453/markets/${MARKET}/historical-data`);
    expect(String(url)).toContain('includeApyBreakdown=true');
  });

  it('handles a bare (non-array-wrapped) historical-data response shape', async () => {
    // Some Pendle endpoint variants return the breakdown object directly
    // rather than wrapped in {results:[...]}; fetchPendleMarketAnalysis
    // must handle both shapes defensively.
    __setPendleFetchForTest(
      vi.fn(async () =>
        jsonResponse(200, {
          timestamp: 1_700_000_000,
          ytApyBreakdown: { 'Protocol Yield': 0.02 },
          lpApyBreakdown: { 'Underlying Yield': 0.01 },
        }),
      ) as never,
    );

    const t = TOOL_BY_NAME.pendle_market_scan!;
    const r = await t.handler(
      { action: 'analyze', chain_id: 8453, market_address: MARKET, limit: 10 },
      ctx(),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        yt_apy_breakdown: Array<{ category: string; apy_pct: number }>;
        lp_apy_breakdown: Array<{ category: string; apy_pct: number }>;
      };
      expect(data.yt_apy_breakdown).toEqual([{ category: 'Protocol Yield', apy_pct: 2 }]);
      expect(data.lp_apy_breakdown).toEqual([{ category: 'Underlying Yield', apy_pct: 1 }]);
    }
  });
});

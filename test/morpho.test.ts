import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_BY_NAME, TOOL_NAMES } from '../src/tools.js';
import type { ToolContext } from '../src/tools.js';
import {
  __resetMorphoClientsForTest,
  __setMorphoFetchForTest,
  isValidMorphoMarketId,
} from '../src/morpho.js';

const ctx = (): ToolContext => ({
  walletName: 'default',
  defaultChain: 'base-mainnet',
  testnetMode: true,
  env: {},
});

const VALID_MARKET_ID =
  '0xdba352c33d64fc9bff091d505dbfcbc6c41b89986c2193b22a90031e9dac7f76';
const USER = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';

afterEach(() => {
  __resetMorphoClientsForTest();
  __setMorphoFetchForTest(null);
});

describe('isValidMorphoMarketId (pure)', () => {
  it('accepts a 32-byte hex market id', () => {
    expect(isValidMorphoMarketId(VALID_MARKET_ID)).toBe(true);
  });

  it('rejects a too-short hex string', () => {
    expect(isValidMorphoMarketId('0x1234')).toBe(false);
  });

  it('rejects a non-hex string', () => {
    expect(isValidMorphoMarketId('not-a-market-id')).toBe(false);
  });
});

describe('morpho_market_scan — registry & schema', () => {
  const t = TOOL_BY_NAME.morpho_market_scan!;

  it('is registered exactly once', () => {
    expect(t).toBeDefined();
    expect(TOOL_NAMES.filter((n) => n === 'morpho_market_scan')).toHaveLength(1);
  });

  it('requires a valid action', () => {
    expect(t.schema.safeParse({}).success).toBe(false);
    expect(t.schema.safeParse({ action: 'position' }).success).toBe(true);
    expect(t.schema.safeParse({ action: 'compare' }).success).toBe(true);
    expect(t.schema.safeParse({ action: 'invalid' }).success).toBe(false);
  });

  it('defaults chain to base-mainnet', () => {
    const r = t.schema.parse({ action: 'position' }) as { chain: string };
    expect(r.chain).toBe('base-mainnet');
  });

  it('rejects a malformed market_address', () => {
    expect(
      t.schema.safeParse({ action: 'position', market_address: '0xbad' }).success,
    ).toBe(false);
  });

  it('accepts a well-formed market_address + user_address', () => {
    expect(
      t.schema.safeParse({
        action: 'position',
        market_address: VALID_MARKET_ID,
        user_address: USER,
      }).success,
    ).toBe(true);
  });
});

describe('morpho_market_scan — handler (action=position)', () => {
  it('fails with MISSING_ARG when market_address is omitted', async () => {
    const t = TOOL_BY_NAME.morpho_market_scan!;
    const r = await t.handler({ action: 'position', chain: 'base-mainnet' }, ctx());
    expect(r).toMatchObject({ ok: false, code: 'MISSING_ARG' });
  });

  it('fails with MISSING_ARG when user_address is omitted', async () => {
    const t = TOOL_BY_NAME.morpho_market_scan!;
    const r = await t.handler(
      { action: 'position', chain: 'base-mainnet', market_address: VALID_MARKET_ID },
      ctx(),
    );
    expect(r).toMatchObject({ ok: false, code: 'MISSING_ARG' });
  });

  it('returns a shaped position snapshot from a mocked fetchAccrualPosition', async () => {
    __setMorphoFetchForTest({
      fetchAccrualPosition: vi.fn(async () => ({
        supplyAssets: 1_000_000n,
        borrowAssets: 400_000n,
        collateral: 2_000_000n,
        ltv: 200_000_000_000_000_000n, // 0.2 * WAD = 20%
        healthFactor: 5_000_000_000_000_000_000n, // 5.0 * WAD
        isHealthy: true,
        liquidationPrice: 123n,
      })),
    } as never);

    const t = TOOL_BY_NAME.morpho_market_scan!;
    const r = await t.handler(
      {
        action: 'position',
        chain: 'base-mainnet',
        market_address: VALID_MARKET_ID,
        user_address: USER,
      },
      ctx(),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as Record<string, unknown>;
      expect(d.supplied_assets).toBe('1000000');
      expect(d.borrowed_assets).toBe('400000');
      expect(d.collateral).toBe('2000000');
      expect(d.ltv_pct).toBeCloseTo(20, 2);
      expect(d.health_factor).toBeCloseTo(5, 2);
      expect(d.is_healthy).toBe(true);
      expect(d.liquidation_price).toBe('123');
    }
  });

  it('surfaces INVALID_MARKET_ID for a malformed market id at the handler boundary', async () => {
    __setMorphoFetchForTest({ fetchAccrualPosition: vi.fn() } as never);
    const t = TOOL_BY_NAME.morpho_market_scan!;
    // Schema already blocks this at the tool boundary; call the exported
    // handler function directly to exercise the module-level defensive
    // check too (defense in depth).
    const { morpho_market_scan } = await import('../src/handlers.js');
    const r = await morpho_market_scan(
      {
        action: 'position',
        chain: 'base-mainnet',
        market_address: '0xnotavalidmarketid',
        user_address: USER,
      } as never,
      ctx(),
    );
    expect(r).toMatchObject({ ok: false, code: 'INVALID_MARKET_ID' });
  });

  it('propagates a real RPC failure from fetchAccrualPosition as a failed ToolResult', async () => {
    __setMorphoFetchForTest({
      fetchAccrualPosition: vi.fn(async () => {
        throw new Error('RPC timeout');
      }),
    } as never);
    const t = TOOL_BY_NAME.morpho_market_scan!;
    const r = await t.handler(
      {
        action: 'position',
        chain: 'base-mainnet',
        market_address: VALID_MARKET_ID,
        user_address: USER,
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('RPC timeout');
  });

  it('fails cleanly (not a silent crash) when the injected fetch module lacks fetchAccrualPosition', async () => {
    // Exercises defensive handling when the loaded module's shape doesn't
    // match what this code expects (e.g. a future SDK version renaming or
    // removing the export) — the handler must still return a ToolResult,
    // not throw an unhandled exception past `wrap()`.
    __setMorphoFetchForTest({} as never);
    const t = TOOL_BY_NAME.morpho_market_scan!;
    const r = await t.handler(
      {
        action: 'position',
        chain: 'base-mainnet',
        market_address: VALID_MARKET_ID,
        user_address: USER,
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
  });
});

describe('morpho_market_scan — handler (action=compare)', () => {
  const MARKET_A =
    ('0x' + 'a'.repeat(64)) as string;
  const MARKET_B =
    ('0x' + 'b'.repeat(64)) as string;
  const MARKET_C =
    ('0x' + 'c'.repeat(64)) as string;

  it('fails with MISSING_ARG when market_ids is omitted', async () => {
    const t = TOOL_BY_NAME.morpho_market_scan!;
    const r = await t.handler({ action: 'compare', chain: 'base-mainnet' }, ctx());
    expect(r).toMatchObject({ ok: false, code: 'MISSING_ARG' });
  });

  it('ranks N candidate markets by supply APY descending', async () => {
    const marketsById: Record<string, { apy: number; supply: bigint; borrow: bigint }> = {
      [MARKET_A]: { apy: 0.03, supply: 1_000_000n, borrow: 500_000n },
      [MARKET_B]: { apy: 0.08, supply: 2_000_000n, borrow: 1_800_000n },
      [MARKET_C]: { apy: 0.05, supply: 500_000n, borrow: 100_000n },
    };
    __setMorphoFetchForTest({
      fetchMarket: vi.fn(async (id: string) => {
        const m = marketsById[id]!;
        return {
          totalSupplyAssets: m.supply,
          totalBorrowAssets: m.borrow,
          utilization: BigInt(Math.round((Number(m.borrow) / Number(m.supply)) * 1e18)),
          supplyApy: m.apy,
        };
      }),
    } as never);

    const t = TOOL_BY_NAME.morpho_market_scan!;
    const r = await t.handler(
      {
        action: 'compare',
        chain: 'base-mainnet',
        market_ids: [MARKET_A, MARKET_B, MARKET_C],
      },
      ctx(),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { markets: Array<Record<string, unknown>> };
      expect(data.markets).toHaveLength(3);
      // Sorted descending by supply_apy_pct: B (8%) > C (5%) > A (3%)
      expect(data.markets[0]!.market_id).toBe(MARKET_B);
      expect(data.markets[0]!.supply_apy_pct).toBeCloseTo(8, 2);
      expect(data.markets[1]!.market_id).toBe(MARKET_C);
      expect(data.markets[2]!.market_id).toBe(MARKET_A);
      expect(data.markets[0]!.total_supply_assets).toBe('2000000');
    }
  });

  it('respects limit and drops markets that fail to fetch', async () => {
    __setMorphoFetchForTest({
      fetchMarket: vi.fn(async (id: string) => {
        if (id === MARKET_B) throw new Error('RPC error for B');
        return {
          totalSupplyAssets: 1_000_000n,
          totalBorrowAssets: 200_000n,
          utilization: 200_000_000_000_000_000n,
          supplyApy: 0.04,
        };
      }),
    } as never);

    const t = TOOL_BY_NAME.morpho_market_scan!;
    const r = await t.handler(
      {
        action: 'compare',
        chain: 'base-mainnet',
        market_ids: [MARKET_A, MARKET_B, MARKET_C],
        limit: 1,
      },
      ctx(),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { markets: Array<Record<string, unknown>> };
      // MARKET_B dropped (fetch failed), limit=1 keeps only one of the rest.
      expect(data.markets).toHaveLength(1);
      expect(data.markets[0]!.market_id).not.toBe(MARKET_B);
    }
  });
});

describe('morpho_market_scan — action=position still works after compare was added', () => {
  it('smoke test: registry entry unchanged for position', () => {
    const t = TOOL_BY_NAME.morpho_market_scan!;
    expect(t.schema.safeParse({ action: 'position' }).success).toBe(true);
  });
});

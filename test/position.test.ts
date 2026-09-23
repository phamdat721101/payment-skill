import { describe, expect, it, vi } from 'vitest';
import { TOOL_BY_NAME } from '../src/tools.js';
import type { ToolContext } from '../src/tools.js';
import { analyzeBorrowPosition, backtestRolloverStrategy } from '../src/position.js';

const USER = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const ADDR = '0x1111111111111111111111111111111111111111';
const MARKET = `0x${'a'.repeat(64)}`;
const ctx: ToolContext = { walletName: 'default', defaultChain: 'base-mainnet', testnetMode: true, env: {} };

function client(readResults: unknown[]) {
  return {
    getBlock: vi.fn(async () => ({ number: 123n, hash: `0x${'b'.repeat(64)}`, timestamp: 1_700_000_000n })),
    getCode: vi.fn(async () => '0x6000'),
    readContract: vi.fn(async () => readResults.shift()),
  };
}

describe('analyze_borrow_position', () => {
  it('EDGE-01 registers strict schemas and rejects a mismatched protocol locator', () => {
    const tool = TOOL_BY_NAME.analyze_borrow_position!;
    expect(tool).toBeDefined();
    expect(tool.schema.safeParse({}).success).toBe(false);
    expect(tool.schema.safeParse({ chain: 'base-mainnet', user_address: USER, locator: { protocol: 'morpho_blue', market_id: MARKET } }).success).toBe(true);
    expect(tool.schema.safeParse({ chain: 'arbitrum-one', user_address: USER, locator: { protocol: 'morpho_blue', market_id: MARKET } }).success).toBe(false);
  });

  it('EDGE-02 pins Morpho state and explicitly marks unavailable valuations partial', async () => {
    const snapshot = await analyzeBorrowPosition({ chain: 'base-mainnet', user_address: USER, locator: { protocol: 'morpho_blue', market_id: MARKET }, block_number: 123 }, { client: client([[10n, 20n, 30n]]) as never });
    expect(snapshot.as_of.block_number).toBe('123');
    expect(snapshot.debt).toMatchObject({ amount_raw: '20', unit: 'borrow shares' });
    expect(snapshot.data_quality).toMatchObject({ status: 'PARTIAL' });
    expect(snapshot.provenance[0]).toMatchObject({ source: 'rpc', block_number: '123' });
  });

  it('EDGE-03 normalizes Dolomite, Aave, and Silo raw reads without inventing prices', async () => {
    const dolomite = await analyzeBorrowPosition({ chain: 'arbitrum-one', user_address: USER, locator: { protocol: 'dolomite_margin', margin_address: ADDR, account_number: '0', collateral_market_id: '1', debt_market_id: '2' }, block_number: 123 }, { client: client([{ sign: true, value: 10n }, { sign: false, value: 4n }]) as never });
    expect(dolomite.collateral.amount_raw).toBe('10');
    expect(dolomite.debt.amount_raw).toBe('4');

    const aave = await analyzeBorrowPosition({ chain: 'base-mainnet', user_address: USER, locator: { protocol: 'aave_v3', pool_address: ADDR }, block_number: 123 }, { client: client([[100n, 40n, 60n, 8_000n, 7_000n, 1_250_000_000_000_000_000n]]) as never });
    expect(aave.risk_metrics).toEqual({ health_factor: '1250000000000000000', current_ltv_bps: 7000, liquidation_ltv_bps: 8000 });

    const silo = await analyzeBorrowPosition({ chain: 'ethereum-mainnet', user_address: USER, locator: { protocol: 'silo_v2', silo_address: ADDR, collateral_asset: ADDR, debt_asset: '0x2222222222222222222222222222222222222222' }, block_number: 123 }, { client: client([100n, 50n]) as never });
    expect(silo.collateral.amount_raw).toBe('100');
    expect(silo.debt.amount_raw).toBe('50');
    expect(silo.risk_metrics.health_factor).toBeNull();
  });
});

describe('backtest_rollover_strategy', () => {
  it('EDGE-04 requires an archive RPC and cannot expose executable artifacts', async () => {
    const config = { target_position: { chain: 'base-mainnet' as const, user_address: USER, locator: { protocol: 'aave_v3' as const, pool_address: ADDR } }, archive_rpc_env: 'ARCHIVE_RPC', pinned_block_number: 123, scenarios: [{ type: 'price_shock' as const, price_shock_bps: [-500] }] };
    await expect(backtestRolloverStrategy(config, {}, { client: client([]) as never })).rejects.toMatchObject({ code: 'ARCHIVE_RPC_REQUIRED' });
    const result = await backtestRolloverStrategy(config, { ARCHIVE_RPC: 'https://archive.example' }, { client: client([[100n, 40n, 60n, 8_000n, 7_000n, 1_250_000_000_000_000_000n]]) as never });
    expect(result).toMatchObject({ simulation_mode: 'modelled_transition', executable: false });
    expect(result).not.toHaveProperty('calldata');
    expect(result).not.toHaveProperty('transaction');
  });

  it('EDGE-05 exposes both tool contracts through the common registry', () => {
    const tool = TOOL_BY_NAME.backtest_rollover_strategy!;
    expect(tool.schema.safeParse({}).success).toBe(false);
    const readOnly = TOOL_BY_NAME.analyze_borrow_position!;
    expect(readOnly.schema.safeParse({ chain: 'base-mainnet', user_address: USER, locator: { protocol: 'aave_v3', pool_address: ADDR } }).success).toBe(true);
  });
});

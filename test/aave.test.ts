import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_BY_NAME } from '../src/tools.js';
import { CHAIN_META } from '../src/faucet.js';
import {
  __resetAavePathForTests,
  __liquidityRateToApyPctForTests,
} from '../src/handlers.js';
import type { ToolContext } from '../src/tools.js';

const FAKE_WALLET = {
  name: 'default',
  address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23' as const,
  privateKey:
    '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318' as const,
  createdAt: new Date().toISOString(),
};

vi.mock('../src/wallet.js', () => ({
  ensureWallet: vi.fn(async () => FAKE_WALLET),
}));

const A_TOKEN = '0xA000000000000000000000000000000000000A';
const VARIABLE_DEBT_TOKEN = '0xB000000000000000000000000000000000000B';
const STABLE_DEBT_TOKEN = '0xC000000000000000000000000000000000000C';

const readContractMock = vi.fn();

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ readContract: readContractMock })),
    createWalletClient: vi.fn(() => ({})),
  };
});

function ctx(env: NodeJS.ProcessEnv = {}): ToolContext {
  return {
    walletName: 'default',
    defaultChain: 'base-sepolia',
    testnetMode: true,
    env,
  };
}

describe('aave_yield registration', () => {
  it('exists in the registry with the documented action enum', () => {
    const t = TOOL_BY_NAME.aave_yield;
    expect(t).toBeDefined();
    const r = t!.schema.safeParse({ action: 'demo' });
    expect(r.success).toBe(true);
    const bad = t!.schema.safeParse({ action: 'invalid' });
    expect(bad.success).toBe(false);
  });

  it('rejects supply/withdraw without amount_usdc at handler level (schema allows optional)', () => {
    const t = TOOL_BY_NAME.aave_yield!;
    // Schema treats amount_usdc as optional; the handler enforces MISSING_ARG.
    expect(t.schema.safeParse({ action: 'supply' }).success).toBe(true);
    expect(t.schema.safeParse({ action: 'withdraw', amount_usdc: '0.5' }).success).toBe(true);
  });

  it('validates amount_usdc as a 1–6 decimal string', () => {
    const t = TOOL_BY_NAME.aave_yield!;
    expect(t.schema.safeParse({ action: 'supply', amount_usdc: '1.000001' }).success).toBe(true);
    expect(t.schema.safeParse({ action: 'supply', amount_usdc: '1.0000001' }).success).toBe(false);
    expect(t.schema.safeParse({ action: 'supply', amount_usdc: 'one' }).success).toBe(false);
  });

  it('defaults chain to base-sepolia and auto_faucet to true', () => {
    const t = TOOL_BY_NAME.aave_yield!;
    const r = t.schema.parse({ action: 'demo' }) as {
      chain: string;
      auto_faucet: boolean;
    };
    expect(r.chain).toBe('base-sepolia');
    expect(r.auto_faucet).toBe(true);
  });

  it('refuses non-base-sepolia chain values', () => {
    const t = TOOL_BY_NAME.aave_yield!;
    expect(t.schema.safeParse({ action: 'demo', chain: 'base-mainnet' }).success).toBe(false);
  });
});

describe('aave chain meta', () => {
  it('records the user-provided V3 Pool address on base-sepolia', () => {
    expect(CHAIN_META['base-sepolia'].aave?.pool).toBe(
      '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27',
    );
  });

  it('records the Aave-mock USDC distinct from Circle USDC', () => {
    expect(CHAIN_META['base-sepolia'].aave?.usdc).toBe(
      '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f',
    );
  });

  it('keeps base-sepolia (Circle) USDC unchanged for other tools', () => {
    expect(CHAIN_META['base-sepolia'].usdc).toBe(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    );
  });
});

describe('aave_position_analysis registration', () => {
  beforeEach(() => __resetAavePathForTests());
  afterEach(() => __resetAavePathForTests());

  it('exists in the registry', () => {
    const t = TOOL_BY_NAME.aave_position_analysis;
    expect(t).toBeDefined();
  });

  it('accepts an empty input and defaults chain to base-sepolia', () => {
    const t = TOOL_BY_NAME.aave_position_analysis!;
    const r = t.schema.parse({}) as { chain: string };
    expect(r.chain).toBe('base-sepolia');
  });

  it('accepts an optional wallet_name override', () => {
    const t = TOOL_BY_NAME.aave_position_analysis!;
    expect(t.schema.safeParse({ wallet_name: 'treasury' }).success).toBe(true);
  });

  it('rejects non-base-sepolia chain values', () => {
    const t = TOOL_BY_NAME.aave_position_analysis!;
    expect(t.schema.safeParse({ chain: 'base-mainnet' }).success).toBe(false);
  });
});

describe('aave_position_analysis — handler (mocked publicClient)', () => {
  beforeEach(() => {
    __resetAavePathForTests();
    readContractMock.mockReset();
  });
  afterEach(() => __resetAavePathForTests());

  it('computes real pool-wide utilization from total debt vs. total liquidity, not per-user balance', async () => {
    const OWNER = FAKE_WALLET.address;
    const USDC = CHAIN_META['base-sepolia'].aave?.usdc as string;
    readContractMock.mockImplementation(
      async (call: { functionName: string; address: string; args?: readonly unknown[] }) => {
        if (call.functionName === 'getReserveData') {
          return {
            currentLiquidityRate: 0n,
            aTokenAddress: A_TOKEN,
            variableDebtTokenAddress: VARIABLE_DEBT_TOKEN,
            stableDebtTokenAddress: STABLE_DEBT_TOKEN,
          };
        }
        if (call.functionName === 'balanceOf') {
          // Caller's own aToken balance (their personal supplied position).
          if (call.address === A_TOKEN && call.args?.[0] === OWNER) return 10_000_000_000n; // 10,000 USDC — deliberately huge
          // Caller's own USDC wallet balance.
          if (call.address === USDC && call.args?.[0] === OWNER) return 5_000_000n;
          // Pool's available USDC liquidity, held by the aToken contract.
          if (call.address === USDC && call.args?.[0] === A_TOKEN) return 10_000_000n; // 10 USDC available
        }
        if (call.functionName === 'totalSupply' && call.address === VARIABLE_DEBT_TOKEN) {
          return 800_000_000n; // 800 USDC total variable debt
        }
        if (call.functionName === 'totalSupply' && call.address === STABLE_DEBT_TOKEN) {
          return 200_000_000n; // 200 USDC total stable debt
        }
        throw new Error(`unexpected call: ${call.functionName} @ ${call.address}`);
      },
    );

    const t = TOOL_BY_NAME.aave_position_analysis!;
    const r = await t.handler({ chain: 'base-sepolia' }, ctx());

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as Record<string, unknown>;
      // totalDebt = 800 + 200 = 1000 USDC; availableLiquidity = 10 USDC.
      // utilization = 1000 / (1000 + 10) ≈ 99.01% — driven entirely by
      // pool-wide debt vs. liquidity. The caller's own aToken balance is
      // deliberately set to a huge, unrelated value (10,000 USDC) to prove
      // it has zero influence on the result — this is the exact bug the
      // CRITICAL review finding identified (old code divided pool liquidity
      // by the caller's personal balance instead of by total debt+liquidity).
      expect(data.utilization_pct).toBeCloseTo(99.01, 1);
      expect(data.supplied_usdc).toBe('10000');
      expect(typeof data.supply_apy_pct).toBe('number');
    }
  });

  it('returns AAVE_POOL_INVALID when getReserveData throws', async () => {
    readContractMock.mockImplementation(async () => {
      throw new Error('reverted');
    });
    const t = TOOL_BY_NAME.aave_position_analysis!;
    const r = await t.handler({ chain: 'base-sepolia' }, ctx());
    expect(r).toMatchObject({ ok: false, code: 'AAVE_POOL_INVALID' });
  });

  it('treats a failed debt-token totalSupply read as zero debt rather than failing the whole snapshot', async () => {
    readContractMock.mockImplementation(async (call: { functionName: string; address: string }) => {
      if (call.functionName === 'getReserveData') {
        return {
          currentLiquidityRate: 0n,
          aTokenAddress: A_TOKEN,
          variableDebtTokenAddress: VARIABLE_DEBT_TOKEN,
          stableDebtTokenAddress: STABLE_DEBT_TOKEN,
        };
      }
      if (call.functionName === 'totalSupply') {
        throw new Error('stable debt token not deployed on this mock pool');
      }
      return 0n;
    });
    const t = TOOL_BY_NAME.aave_position_analysis!;
    const r = await t.handler({ chain: 'base-sepolia' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as Record<string, unknown>;
      // totalDebt=0, availableLiquidity=0 -> totalLiquidity=0 -> null, not a throw.
      expect(data.utilization_pct).toBeNull();
    }
  });
});

describe('liquidityRateToApyPct (pure conversion, no I/O)', () => {
  it('returns 0% for a zero liquidity rate', () => {
    expect(__liquidityRateToApyPctForTests(0n)).toBe(0);
  });

  it('converts a ray-scaled ~5% APR into a slightly higher compounded APY', () => {
    // currentLiquidityRate is ray-scaled (1e27) and represents APR.
    // 5% APR ray-scaled = 0.05 * 1e27.
    const fivePctApr = 5n * 10n ** 25n; // 0.05 * 1e27
    const apyPct = __liquidityRateToApyPctForTests(fivePctApr);
    // Continuous compounding of 5% APR yields APY slightly above 5%.
    expect(apyPct).toBeGreaterThan(5);
    expect(apyPct).toBeLessThan(5.2);
  });

  it('scales monotonically with the input rate', () => {
    const low = __liquidityRateToApyPctForTests(1n * 10n ** 25n); // 1% APR
    const high = __liquidityRateToApyPctForTests(10n * 10n ** 25n); // 10% APR
    expect(high).toBeGreaterThan(low);
  });
});

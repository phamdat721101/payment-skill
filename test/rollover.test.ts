import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_BY_NAME } from '../src/tools.js';
import type { ToolContext } from '../src/tools.js';
import { __resetMorphoClientsForTest, __setMorphoFetchForTest } from '../src/morpho.js';

const CURRENT = `0x${'a'.repeat(64)}`;
const CANDIDATE = `0x${'b'.repeat(64)}`;
const USER = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ctx: ToolContext = { walletName: 'default', defaultChain: 'base-mainnet', testnetMode: true, env: {} };

afterEach(() => {
  __resetMorphoClientsForTest();
  __setMorphoFetchForTest(null);
});

function installMorphoFixture(opts: {
  candidateFails?: boolean;
  currentDebt?: bigint;
  candidateSupply?: bigint;
  candidateBorrow?: bigint;
} = {}): void {
  __setMorphoFetchForTest({
    fetchAccrualPosition: vi.fn(async () => ({
      supplyAssets: 0n,
      borrowAssets: opts.currentDebt ?? 500n,
      collateral: 1_000n,
      ltv: 8_500_000_000_000_000_000n,
      healthFactor: 1_050_000_000_000_000_000n,
      isHealthy: true,
      liquidationPrice: null,
    })),
    fetchMarket: vi.fn(async () => {
      if (opts.candidateFails) throw new Error('RPC timeout');
      return {
        totalSupplyAssets: opts.candidateSupply ?? 2_000n,
        totalBorrowAssets: opts.candidateBorrow ?? 1_000n,
        utilization: 500_000_000_000_000_000n,
        supplyApy: 0.04,
      };
    }),
  } as never);
}

describe('defi_rollover_decision_engine', () => {
  const tool = TOOL_BY_NAME.defi_rollover_decision_engine!;

  it('EDGE-01 validates the strict read-only input schema', () => {
    expect(tool.schema.safeParse({}).success).toBe(false);
    const parsed = tool.schema.parse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CANDIDATE],
    }) as { risk_policy: { max_ltv_bps: number } };
    expect(parsed.risk_policy.max_ltv_bps).toBe(8_000);
    expect(tool.schema.safeParse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CURRENT],
    }).success).toBe(false);
    expect(tool.schema.safeParse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CANDIDATE, CANDIDATE],
    }).success).toBe(false);
    expect(tool.schema.safeParse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CANDIDATE],
      candidate_market_evidence: [{ market_id: `0x${'c'.repeat(64)}` }],
    }).success).toBe(false);
    expect(tool.schema.safeParse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CANDIDATE],
      candidate_market_evidence: [{ market_id: CANDIDATE }, { market_id: CANDIDATE }],
    }).success).toBe(false);
  });

  it('EDGE-02 returns evidence, ranked capacity, and a non-executable rollover intent', async () => {
    installMorphoFixture();
    const result = await tool.handler(tool.schema.parse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CANDIDATE],
      current_market_evidence: { loan_asset: USDC, maturity_timestamp: Math.floor(Date.now() / 1_000) + 60 },
      candidate_market_evidence: [{ market_id: CANDIDATE, loan_asset: USDC }],
    }), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data as { recommendation: string; candidates: Array<{ capacity_status: string; available_liquidity_status: string }>; rollover_intent: { executable: boolean; blockers: string[] }; findings: Array<{ code: string }> };
    expect(report.recommendation).toBe('RESEARCH_ROLLOVER');
    expect(report.candidates[0]!.available_liquidity_status).toBe('SUFFICIENT');
    expect(report.candidates[0]!.capacity_status).toBe('UNVERIFIED');
    expect(report.rollover_intent.executable).toBe(false);
    expect(report.rollover_intent.blockers).toContain('EXECUTION_DISABLED_IN_READ_ONLY_V1');
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['ELEVATED_LTV', 'LOW_HEALTH_FACTOR', 'MATURITY_WINDOW']));
  });

  it('EDGE-03 reports unavailable candidates without hiding the position analysis', async () => {
    installMorphoFixture({ candidateFails: true });
    const result = await tool.handler(tool.schema.parse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CANDIDATE],
    }), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data as { unavailable_candidates: Array<{ code: string }>; recommendation: string };
    expect(report.unavailable_candidates).toEqual([{ market_id: CANDIDATE, code: 'CANDIDATE_UNAVAILABLE' }]);
    expect(report.recommendation).toBe('PRIORITIZE_DELEVERAGE');
  });

  it('EDGE-04 keeps market compatibility unverified despite available liquidity', async () => {
    installMorphoFixture();
    const result = await tool.handler(tool.schema.parse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CANDIDATE],
    }), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data as { candidates: Array<{ capacity_status: string; available_liquidity_status: string }>; rollover_intent: { blockers: string[] } };
    expect(report.candidates[0]!.available_liquidity_status).toBe('SUFFICIENT');
    expect(report.candidates[0]!.capacity_status).toBe('UNVERIFIED');
    expect(report.rollover_intent.blockers).toContain('MARKET_COMPATIBILITY_UNVERIFIED');
  });

  it('honors a configured liquidity threshold below 100%', async () => {
    installMorphoFixture({ currentDebt: 1_000n, candidateSupply: 1_750n, candidateBorrow: 1_000n });
    const result = await tool.handler(tool.schema.parse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CANDIDATE],
      risk_policy: { min_candidate_liquidity_bps: 5_000 },
      current_market_evidence: { loan_asset: USDC },
      candidate_market_evidence: [{ market_id: CANDIDATE, loan_asset: USDC }],
    }), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data as { candidates: Array<{ available_liquidity_status: string }> };
    expect(report.candidates[0]!.available_liquidity_status).toBe('SUFFICIENT');
  });

  it('EDGE-05 exposes unpinned state and no execution artifacts', async () => {
    installMorphoFixture();
    const result = await tool.handler(tool.schema.parse({
      chain: 'base-mainnet', user_address: USER, current_market_id: CURRENT, candidate_market_ids: [CANDIDATE],
    }), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data as { as_of: { state_consistency: string }; rollover_intent: Record<string, unknown> };
    expect(report.as_of.state_consistency).toBe('UNPINNED');
    expect(report.rollover_intent).not.toHaveProperty('calldata');
    expect(report.rollover_intent).not.toHaveProperty('transaction');
  });
});

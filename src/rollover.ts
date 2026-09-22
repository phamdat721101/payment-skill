// Read-only DeFi rollover research for Morpho Blue positions. This module
// deliberately produces a research intent, never calldata, signing requests,
// flash-loan selection, or transaction dispatch.

import type { Address } from 'viem';
import {
  fetchMorphoMarketComparisons,
  fetchMorphoPositionSnapshot,
  type MorphoChain,
  type MorphoMarketSummary,
  type MorphoPositionSnapshot,
} from './morpho.js';

export type RolloverChain = Extract<MorphoChain, 'ethereum-mainnet' | 'base-mainnet' | 'arbitrum-one'>;
export type RolloverRecommendation =
  | 'HOLD'
  | 'SCHEDULE_REVIEW'
  | 'PRIORITIZE_DELEVERAGE'
  | 'RESEARCH_ROLLOVER';

export interface MarketEvidence {
  market_id: string;
  loan_asset?: Address;
  collateral_asset?: Address;
  maturity_timestamp?: number;
  borrow_apy_bps?: number;
  collateral_yield_apy_bps?: number;
}

export interface RolloverAnalysisRequest {
  chain: RolloverChain;
  user_address: Address;
  current_market_id: string;
  candidate_market_ids: string[];
  risk_policy: {
    max_ltv_bps: number;
    min_health_factor: number;
    maturity_warning_seconds: number;
    min_candidate_liquidity_bps: number;
  };
  current_market_evidence?: Omit<MarketEvidence, 'market_id'>;
  candidate_market_evidence?: MarketEvidence[];
}

export interface RolloverDependencies {
  now?: () => Date;
  fetchPosition?: typeof fetchMorphoPositionSnapshot;
  fetchMarkets?: typeof fetchMorphoMarketComparisons;
}

const BPS_PER_PERCENT = 100;

function toBps(percent: number | null): number | null {
  return percent == null ? null : Math.round(percent * BPS_PER_PERCENT);
}

function parseAmount(amount: string): bigint {
  return BigInt(amount);
}

function candidateEvidence(
  marketId: string,
  evidence: readonly MarketEvidence[] | undefined,
): MarketEvidence | undefined {
  return evidence?.find((entry) => entry.market_id.toLowerCase() === marketId.toLowerCase());
}

function liquidityStatus(
  currentDebt: bigint,
  market: MorphoMarketSummary,
  minLiquidityBps: number,
): 'SUFFICIENT' | 'INSUFFICIENT' {
  const available = parseAmount(market.total_supply_assets) - parseAmount(market.total_borrow_assets);
  if (currentDebt === 0n) return 'SUFFICIENT';
  return (available * 10_000n) / currentDebt >= BigInt(minLiquidityBps)
    ? 'SUFFICIENT'
    : 'INSUFFICIENT';
}

function findingsForPosition(
  snapshot: MorphoPositionSnapshot,
  evidence: RolloverAnalysisRequest['current_market_evidence'],
  policy: RolloverAnalysisRequest['risk_policy'],
  nowSeconds: number,
): Array<{ code: string; severity: 'INFO' | 'WARNING' | 'HIGH'; source: string }> {
  const findings: Array<{ code: string; severity: 'INFO' | 'WARNING' | 'HIGH'; source: string }> = [];
  const ltvBps = toBps(snapshot.ltv_pct);
  if (ltvBps != null && ltvBps >= policy.max_ltv_bps) {
    findings.push({ code: 'ELEVATED_LTV', severity: 'HIGH', source: 'morpho-sdk' });
  }
  if (snapshot.health_factor != null && snapshot.health_factor < policy.min_health_factor) {
    findings.push({ code: 'LOW_HEALTH_FACTOR', severity: 'HIGH', source: 'morpho-sdk' });
  }
  if (snapshot.is_healthy === false) {
    findings.push({ code: 'UNHEALTHY_POSITION', severity: 'HIGH', source: 'morpho-sdk' });
  }
  if (evidence?.maturity_timestamp != null) {
    const secondsToMaturity = evidence.maturity_timestamp - nowSeconds;
    if (secondsToMaturity <= policy.maturity_warning_seconds) {
      findings.push({ code: 'MATURITY_WINDOW', severity: 'WARNING', source: 'caller-supplied' });
    }
  } else {
    findings.push({ code: 'MATURITY_EVIDENCE_MISSING', severity: 'INFO', source: 'not-provided' });
  }
  if (evidence?.borrow_apy_bps != null && evidence?.collateral_yield_apy_bps != null &&
      evidence.borrow_apy_bps > evidence.collateral_yield_apy_bps) {
    findings.push({ code: 'NEGATIVE_CARRY', severity: 'WARNING', source: 'caller-supplied' });
  }
  return findings;
}

export async function analyzeRolloverOpportunity(
  request: RolloverAnalysisRequest,
  dependencies: RolloverDependencies = {},
): Promise<Record<string, unknown>> {
  const now = dependencies.now?.() ?? new Date();
  const fetchPosition = dependencies.fetchPosition ?? fetchMorphoPositionSnapshot;
  const fetchMarkets = dependencies.fetchMarkets ?? fetchMorphoMarketComparisons;
  const [position, candidateMarkets] = await Promise.all([
    fetchPosition({
      chain: request.chain,
      marketId: request.current_market_id,
      user: request.user_address,
    }),
    fetchMarkets({ chain: request.chain, marketIds: request.candidate_market_ids }),
  ]);

  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const currentEvidence = request.current_market_evidence;
  const findings = findingsForPosition(position, currentEvidence, request.risk_policy, nowSeconds);
  findings.push({ code: 'STATE_UNPINNED', severity: 'INFO', source: 'morpho-sdk' });
  const currentDebt = parseAmount(position.borrowed_assets);
  const resolvedIds = new Set(candidateMarkets.map((market) => market.market_id.toLowerCase()));
  const candidates = candidateMarkets.map((market) => {
    const evidence = candidateEvidence(market.market_id, request.candidate_market_evidence);
    const availableLiquidity = parseAmount(market.total_supply_assets) - parseAmount(market.total_borrow_assets);
    const liquidity = liquidityStatus(
      currentDebt,
      market,
      request.risk_policy.min_candidate_liquidity_bps,
    );
    return {
      market_id: market.market_id,
      total_supply_assets: market.total_supply_assets,
      total_borrow_assets: market.total_borrow_assets,
      available_liquidity_assets: availableLiquidity.toString(),
      utilization_bps: Math.round(market.utilization_pct * BPS_PER_PERCENT),
      supply_apy_bps: Math.round(market.supply_apy_pct * BPS_PER_PERCENT),
      available_liquidity_status: liquidity,
      compatibility_status: 'UNVERIFIED',
      capacity_status: 'UNVERIFIED',
      evidence_source: evidence ? 'caller-supplied' : 'not-provided',
    };
  }).sort((a, b) => {
    const liquidityRank = { SUFFICIENT: 0, INSUFFICIENT: 1 } as const;
    return liquidityRank[a.available_liquidity_status] - liquidityRank[b.available_liquidity_status] ||
      a.utilization_bps - b.utilization_bps || a.market_id.localeCompare(b.market_id);
  }).map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  const unresolvedCandidates = request.candidate_market_ids
    .filter((id) => !resolvedIds.has(id.toLowerCase()))
    .map((market_id) => ({ market_id, code: 'CANDIDATE_UNAVAILABLE' }));
  const hasHighRisk = findings.some((finding) => finding.severity === 'HIGH');
  const hasMaturityWindow = findings.some((finding) => finding.code === 'MATURITY_WINDOW');
  const hasSufficientCandidate = candidates.some((candidate) => candidate.available_liquidity_status === 'SUFFICIENT');
  const recommendation: RolloverRecommendation = hasHighRisk
    ? (hasSufficientCandidate ? 'RESEARCH_ROLLOVER' : 'PRIORITIZE_DELEVERAGE')
    : hasMaturityWindow ? 'SCHEDULE_REVIEW'
    : 'HOLD';

  return {
    schema_version: '1.0.0',
    as_of: {
      observed_at: now.toISOString(),
      block_number: null,
      block_hash: null,
      state_consistency: 'UNPINNED',
      source: 'morpho-sdk',
    },
    current_position: {
      chain: request.chain,
      market_id: position.market_id,
      user_address: position.user,
      borrowed_assets: position.borrowed_assets,
      collateral_assets: position.collateral,
      ltv_bps: toBps(position.ltv_pct),
      health_factor: position.health_factor,
      is_healthy: position.is_healthy,
      maturity_timestamp: currentEvidence?.maturity_timestamp ?? null,
      evidence_source: currentEvidence ? 'caller-supplied' : 'not-provided',
    },
    findings,
    candidates,
    unavailable_candidates: unresolvedCandidates,
    recommendation,
    rollover_intent: {
      executable: false,
      required_steps: ['REPAY_OLD_DEBT', 'WITHDRAW_OLD_COLLATERAL', 'SUPPLY_NEW_COLLATERAL'],
      blockers: [
        'EXECUTION_DISABLED_IN_READ_ONLY_V1',
        'PINNED_BLOCK_UNAVAILABLE',
        'REESTIMATE_BEFORE_ACTION',
        'MARKET_COMPATIBILITY_UNVERIFIED',
      ],
    },
  };
}

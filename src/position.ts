// Read-only, block-pinned lending position analysis and modelled backtesting.
//
// The module deliberately separates observation from strategy simulation:
// it never obtains a wallet, creates calldata, estimates gas, signs, or sends.

import { createPublicClient, defineChain, http, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { fetchPendleMarketAnalysis } from './pendle.js';

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'invalid 0x address');
const Bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'invalid 32-byte hex value');

export const AnalysisChainSchema = z.enum(['arbitrum-one', 'ethereum-mainnet', 'base-mainnet']);
export const AnalysisProtocolSchema = z.enum(['dolomite_margin', 'morpho_blue', 'aave_v3', 'silo_v2', 'pendle']);
export type AnalysisChain = z.infer<typeof AnalysisChainSchema>;
export type AnalysisProtocol = z.infer<typeof AnalysisProtocolSchema>;

const LocatorSchema = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('morpho_blue'), market_id: Bytes32Schema }),
  z.object({ protocol: z.literal('dolomite_margin'), margin_address: AddressSchema, account_number: z.string().regex(/^\d+$/), collateral_market_id: z.string().regex(/^\d+$/), debt_market_id: z.string().regex(/^\d+$/) }),
  z.object({ protocol: z.literal('aave_v3'), pool_address: AddressSchema }),
  z.object({ protocol: z.literal('silo_v2'), silo_address: AddressSchema, collateral_asset: AddressSchema, debt_asset: AddressSchema }),
  z.object({ protocol: z.literal('pendle'), market_address: AddressSchema, pt_token_address: AddressSchema.optional() }),
]);

export const PositionAnalysisConfigSchema = z.object({
  chain: AnalysisChainSchema,
  user_address: AddressSchema,
  locator: LocatorSchema,
  block_number: z.union([z.number().int().positive(), z.literal('latest')]).default('latest'),
}).superRefine((value, ctx) => {
  if (value.chain === 'arbitrum-one' && value.locator.protocol === 'morpho_blue') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['locator'], message: 'Morpho Blue is not configured on Arbitrum One.' });
  }
});
export type PositionAnalysisConfig = z.infer<typeof PositionAnalysisConfigSchema>;

export const BacktestSimulationConfigSchema = z.object({
  target_position: PositionAnalysisConfigSchema,
  archive_rpc_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('DEFI_ARCHIVE_RPC_URL'),
  pinned_block_number: z.number().int().positive(),
  scenarios: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('historical_replay'), blocks: z.number().int().positive().max(50_000) }),
    z.object({ type: z.literal('price_shock'), price_shock_bps: z.array(z.number().int().min(-9_900).max(10_000)).min(1) }),
    z.object({ type: z.literal('time_warp'), seconds: z.array(z.number().int().positive().max(365 * 24 * 60 * 60)).min(1) }),
  ])).min(1),
  strategy: z.object({ min_health_factor: z.number().positive().default(1.12), maturity_warning_seconds: z.number().int().positive().default(86_400) }).default({}),
});
export type BacktestSimulationConfig = z.infer<typeof BacktestSimulationConfigSchema>;

export interface PositionSnapshot {
  schema_version: '2.0.0';
  simulation_safe: true;
  as_of: { chain_id: number; block_number: string; block_hash: string; timestamp: string };
  protocol: AnalysisProtocol;
  borrower: string;
  collateral: { asset_address: string | null; amount_raw: string | null; unit: string };
  debt: { asset_address: string | null; amount_raw: string | null; unit: string };
  risk_metrics: { health_factor: string | null; current_ltv_bps: number | null; liquidation_ltv_bps: number | null };
  protocol_state: Record<string, string | number | boolean | null>;
  provenance: Array<{ source: 'rpc' | 'pendle_api'; contract: string | null; method: string; block_number: string | null }>;
  data_quality: { status: 'COMPLETE' | 'PARTIAL'; missing: string[] };
}

const CHAINS: Record<AnalysisChain, { id: number; name: string; rpcUrl: string }> = {
  'arbitrum-one': { id: 42161, name: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc' },
  'ethereum-mainnet': { id: 1, name: 'Ethereum', rpcUrl: 'https://eth.llamarpc.com' },
  'base-mainnet': { id: 8453, name: 'Base', rpcUrl: 'https://mainnet.base.org' },
};

function clientFor(chain: AnalysisChain, rpcUrl?: string): PublicClient {
  const meta = CHAINS[chain];
  return createPublicClient({
    chain: defineChain({ id: meta.id, name: meta.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl ?? meta.rpcUrl] } } }),
    transport: http(rpcUrl ?? meta.rpcUrl),
  });
}

async function assertContract(client: PublicClient, address: Address): Promise<void> {
  const code = await client.getCode({ address });
  if (!code || code === '0x') throw Object.assign(new Error(`No bytecode at ${address}.`), { code: 'CONTRACT_NOT_FOUND' });
}

const morphoAbi = [{ type: 'function', name: 'position', stateMutability: 'view', inputs: [{ type: 'bytes32', name: 'id' }, { type: 'address', name: 'user' }], outputs: [{ type: 'uint256', name: 'supplyShares' }, { type: 'uint128', name: 'borrowShares' }, { type: 'uint128', name: 'collateral' }] }] as const;
const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF66C77999499' as Address;
const dolomiteAbi = [{ type: 'function', name: 'getAccountWei', stateMutability: 'view', inputs: [{ type: 'tuple', name: 'account', components: [{ type: 'address', name: 'owner' }, { type: 'uint256', name: 'number' }] }, { type: 'uint256', name: 'marketId' }], outputs: [{ type: 'tuple', name: 'wei', components: [{ type: 'bool', name: 'sign' }, { type: 'uint256', name: 'value' }] }] }] as const;
const aaveAbi = [{ type: 'function', name: 'getUserAccountData', stateMutability: 'view', inputs: [{ type: 'address', name: 'user' }], outputs: [{ type: 'uint256', name: 'totalCollateralBase' }, { type: 'uint256', name: 'totalDebtBase' }, { type: 'uint256', name: 'availableBorrowsBase' }, { type: 'uint256', name: 'currentLiquidationThreshold' }, { type: 'uint256', name: 'ltv' }, { type: 'uint256', name: 'healthFactor' }] }] as const;
const siloAbi = [{ type: 'function', name: 'getDepositAssets', stateMutability: 'view', inputs: [{ type: 'address', name: 'user' }], outputs: [{ type: 'uint256', name: 'assets' }] }, { type: 'function', name: 'getDebtAssets', stateMutability: 'view', inputs: [{ type: 'address', name: 'user' }], outputs: [{ type: 'uint256', name: 'assets' }] }] as const;
const ptAbi = [{ type: 'function', name: 'expiry', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256', name: 'expiry' }] }] as const;

function asOf(block: { number: bigint | null; hash: Hex | null; timestamp: bigint }): PositionSnapshot['as_of'] {
  if (block.number == null || block.hash == null) throw Object.assign(new Error('RPC returned a block without number or hash.'), { code: 'INVALID_BLOCK' });
  return { chain_id: 0, block_number: block.number.toString(), block_hash: block.hash, timestamp: new Date(Number(block.timestamp) * 1_000).toISOString() };
}

export async function analyzeBorrowPosition(config: PositionAnalysisConfig, deps: { client?: PublicClient; pendleApiKey?: string } = {}): Promise<PositionSnapshot> {
  const client = deps.client ?? clientFor(config.chain);
  const block = config.block_number === 'latest'
    ? await client.getBlock({ blockTag: 'latest' })
    : await client.getBlock({ blockNumber: BigInt(config.block_number) });
  const pinned = block.number!;
  const base = asOf(block);
  base.chain_id = CHAINS[config.chain].id;
  const provenance: PositionSnapshot['provenance'] = [];
  const emptyRisk = { health_factor: null, current_ltv_bps: null, liquidation_ltv_bps: null };

  if (config.locator.protocol === 'morpho_blue') {
    await assertContract(client, MORPHO);
    const [supplyShares, borrowShares, collateral] = await client.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [config.locator.market_id as Hex, config.user_address as Address], blockNumber: pinned });
    provenance.push({ source: 'rpc', contract: MORPHO, method: 'position(bytes32,address)', block_number: pinned.toString() });
    return { schema_version: '2.0.0', simulation_safe: true, as_of: base, protocol: 'morpho_blue', borrower: config.user_address, collateral: { asset_address: null, amount_raw: collateral.toString(), unit: 'market collateral units' }, debt: { asset_address: null, amount_raw: borrowShares.toString(), unit: 'borrow shares' }, risk_metrics: emptyRisk, protocol_state: { market_id: config.locator.market_id, supply_shares_raw: supplyShares.toString(), borrow_shares_raw: borrowShares.toString() }, provenance, data_quality: { status: 'PARTIAL', missing: ['market token addresses', 'accrued borrow assets', 'oracle-derived risk metrics'] } };
  }
  if (config.locator.protocol === 'dolomite_margin') {
    const address = config.locator.margin_address as Address;
    await assertContract(client, address);
    const account = { owner: config.user_address as Address, number: BigInt(config.locator.account_number) };
    const [collateral, debt] = await Promise.all([client.readContract({ address, abi: dolomiteAbi, functionName: 'getAccountWei', args: [account, BigInt(config.locator.collateral_market_id)], blockNumber: pinned }), client.readContract({ address, abi: dolomiteAbi, functionName: 'getAccountWei', args: [account, BigInt(config.locator.debt_market_id)], blockNumber: pinned })]);
    provenance.push({ source: 'rpc', contract: address, method: 'getAccountWei(AccountInfo,uint256)', block_number: pinned.toString() });
    return { schema_version: '2.0.0', simulation_safe: true, as_of: base, protocol: 'dolomite_margin', borrower: config.user_address, collateral: { asset_address: null, amount_raw: collateral.value.toString(), unit: 'market wei' }, debt: { asset_address: null, amount_raw: debt.value.toString(), unit: 'market wei' }, risk_metrics: emptyRisk, protocol_state: { account_number: config.locator.account_number, collateral_market_id: config.locator.collateral_market_id, debt_market_id: config.locator.debt_market_id, collateral_sign: collateral.sign, debt_sign: debt.sign }, provenance, data_quality: { status: 'PARTIAL', missing: ['market token metadata', 'indices', 'oracle-derived risk metrics'] } };
  }
  if (config.locator.protocol === 'aave_v3') {
    const address = config.locator.pool_address as Address;
    await assertContract(client, address);
    const [totalCollateralBase, totalDebtBase, , liquidationThreshold, ltv, healthFactor] = await client.readContract({ address, abi: aaveAbi, functionName: 'getUserAccountData', args: [config.user_address as Address], blockNumber: pinned });
    provenance.push({ source: 'rpc', contract: address, method: 'getUserAccountData(address)', block_number: pinned.toString() });
    return { schema_version: '2.0.0', simulation_safe: true, as_of: base, protocol: 'aave_v3', borrower: config.user_address, collateral: { asset_address: null, amount_raw: totalCollateralBase.toString(), unit: 'Aave base currency' }, debt: { asset_address: null, amount_raw: totalDebtBase.toString(), unit: 'Aave base currency' }, risk_metrics: { health_factor: healthFactor.toString(), current_ltv_bps: Number(ltv), liquidation_ltv_bps: Number(liquidationThreshold) }, protocol_state: { pool_address: address }, provenance, data_quality: { status: 'PARTIAL', missing: ['per-reserve collateral and debt legs'] } };
  }
  if (config.locator.protocol === 'silo_v2') {
    const address = config.locator.silo_address as Address;
    await assertContract(client, address);
    const [collateral, debt] = await Promise.all([client.readContract({ address, abi: siloAbi, functionName: 'getDepositAssets', args: [config.user_address as Address], blockNumber: pinned }), client.readContract({ address, abi: siloAbi, functionName: 'getDebtAssets', args: [config.user_address as Address], blockNumber: pinned })]);
    provenance.push({ source: 'rpc', contract: address, method: 'getDepositAssets/getDebtAssets(address)', block_number: pinned.toString() });
    return { schema_version: '2.0.0', simulation_safe: true, as_of: base, protocol: 'silo_v2', borrower: config.user_address, collateral: { asset_address: config.locator.collateral_asset, amount_raw: collateral.toString(), unit: 'token base units' }, debt: { asset_address: config.locator.debt_asset, amount_raw: debt.toString(), unit: 'token base units' }, risk_metrics: emptyRisk, protocol_state: { silo_address: address }, provenance, data_quality: { status: 'PARTIAL', missing: ['oracle-derived risk metrics'] } };
  }
  const { market_address, pt_token_address } = config.locator;
  const analysis = await fetchPendleMarketAnalysis({ chainId: CHAINS[config.chain].id, marketAddress: market_address, apiKey: deps.pendleApiKey });
  provenance.push({ source: 'pendle_api', contract: market_address, method: 'historical-data?includeApyBreakdown=true', block_number: null });
  let expiry: string | null = null;
  if (pt_token_address) {
    await assertContract(client, pt_token_address as Address);
    expiry = (await client.readContract({ address: pt_token_address as Address, abi: ptAbi, functionName: 'expiry', blockNumber: pinned })).toString();
    provenance.push({ source: 'rpc', contract: pt_token_address, method: 'expiry()', block_number: pinned.toString() });
  }
  return { schema_version: '2.0.0', simulation_safe: true, as_of: base, protocol: 'pendle', borrower: config.user_address, collateral: { asset_address: pt_token_address ?? null, amount_raw: null, unit: 'not-applicable' }, debt: { asset_address: null, amount_raw: null, unit: 'not-applicable' }, risk_metrics: emptyRisk, protocol_state: { market_address, pt_expiry_timestamp: expiry, yt_apy_categories: analysis.yt_apy_breakdown.length, lp_apy_categories: analysis.lp_apy_breakdown.length }, provenance, data_quality: { status: 'PARTIAL', missing: ['borrow position', 'on-chain TWAP valuation'] } };
}

export async function backtestRolloverStrategy(config: BacktestSimulationConfig, env: NodeJS.ProcessEnv, deps: Parameters<typeof analyzeBorrowPosition>[1] = {}): Promise<Record<string, unknown>> {
  const archiveRpc = env[config.archive_rpc_env];
  if (!archiveRpc) throw Object.assign(new Error(`Archive RPC is required in ${config.archive_rpc_env}.`), { code: 'ARCHIVE_RPC_REQUIRED' });
  const snapshot = await analyzeBorrowPosition({ ...config.target_position, block_number: config.pinned_block_number }, { ...deps, client: deps.client ?? clientFor(config.target_position.chain, archiveRpc) });
  const scenarios = config.scenarios.map((scenario) => ({ type: scenario.type, status: 'MODELLED', trigger: scenario.type === 'time_warp' ? 'MATURITY_REVIEW' : scenario.type === 'price_shock' ? 'RISK_REVIEW' : 'HISTORICAL_OBSERVATION', action: 'NONE_EXECUTED' }));
  return { schema_version: '2.0.0', simulation_mode: 'modelled_transition', executable: false, pinned_block_number: snapshot.as_of.block_number, snapshot, scenarios, blockers: ['NO_CALLDATA', 'NO_SIGNING', 'NO_BROADCAST', 'NO_EXECUTOR_CONTRACT'] };
}

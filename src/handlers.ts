// 20 tool handlers — the imperative half of the registry.
//
// Lazy-imports n-payment (peerDep) so install/setup never fails when the SDK
// is not yet present. Stateful managers (sessions, delegations, streams,
// batches, AP2) are module-level singletons keyed by ctx + tool args.
//
// Each handler returns a ToolResult; never throws. Failures carry { code,
// hint } so the agent can self-recover.

import {
  createPublicClient,
  defineChain,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import type { ChainKey, ToolContext, ToolResult } from './tools.js';
import { ensureWallet, type WalletRecord } from './wallet.js';
import { CHAIN_META } from './faucet.js';
import {
  attachReferenceKey,
  queryReferenceKey,
  ReferenceKeyNotFound,
  MORPH_ALTFEE_TRACKING_URL,
  MORPH_PASSKEY_TRACKING_URL,
  type MorphCreds,
} from './morph.js';
import {
  buildStellarPaymentUri,
  fetchStellarBalance,
  isStellarConfigError,
  pickStellarConfig,
} from './stellar.js';
import {
  createSpaceRouterAdmin,
  formatSpaceWei,
  getSpaceRouterWallet,
  parseSpaceWei,
  pickSpaceRouterConfig,
  SpaceRouterClient,
  SpaceRouterError,
} from './spacerouter.js';
import * as flare from './flare.js';

// ─── n-payment lazy loader ───────────────────────────────────────────────────
// Optional peer dep — types only present when the SDK is actually installed.
// @ts-expect-error optional peer dep
type NP = typeof import('n-payment');
let _np: NP | null = null;
async function np(): Promise<NP> {
  if (_np) return _np;
  try {
    // @ts-expect-error optional peer dep
    _np = (await import('n-payment')) as NP;
    return _np;
  } catch {
    throw new Error(
      'n-payment SDK is not installed. Run `npm i n-payment` (or `pnpm add n-payment`).',
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const ok = (data: unknown, meta?: Record<string, unknown>): ToolResult => ({
  ok: true,
  data,
  meta,
});
const fail = (error: string, code?: string, hint?: string): ToolResult => ({
  ok: false,
  error,
  code,
  hint,
});

const wrap = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (e) {
    const err = e as Error & { code?: string };
    return fail(err.message, err.code, undefined);
  }
};

const guardMainnet = (chain: ChainKey, ctx: ToolContext): ToolResult | null =>
  /-mainnet$/.test(chain) && ctx.testnetMode
    ? fail(
        'Mainnet send blocked while testnetMode=true.',
        'MAINNET_GUARD',
        'Run `n-payment-skill config set testnetMode false` and provide real keys.',
      )
    : null;

async function getWallet(ctx: ToolContext): Promise<WalletRecord> {
  return ensureWallet(ctx.walletName);
}

async function getOWSWallet(ctx: ToolContext): Promise<unknown> {
  const { OWSWallet } = await np();
  const w = await getWallet(ctx);
  return new OWSWallet({ wallet: w.name, privateKey: w.privateKey });
}

function viemChain(chain: ChainKey) {
  const m = CHAIN_META[chain];
  return defineChain({
    id: m.chainId || 1,
    name: m.name,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [m.rpcUrl] } },
  });
}

/**
 * Resolve the canonical ERC-20 payment token for a chain. Returns the
 * chain's explicit `paymentToken` when set (e.g. SPACE on Creditcoin), or
 * a USDC-with-6-decimals shape derived from the legacy `usdc` field, or
 * undefined when the chain has no ERC-20 payment token registered.
 *
 * Single source of truth — used by check_balance and generate_qr so SPACE
 * (18 decimals) and USDC (6 decimals) flow through the same code paths.
 */
function resolvePaymentToken(
  chain: ChainKey,
): { address: Address; symbol: string; decimals: number } | undefined {
  const m = CHAIN_META[chain];
  if (m.paymentToken) return m.paymentToken;
  if (m.usdc) return { address: m.usdc, symbol: 'USDC', decimals: 6 };
  return undefined;
}

function pickGoatCreds(env: NodeJS.ProcessEnv): {
  apiKey: string;
  apiSecret: string;
  merchantId: string;
} | null {
  const { GOAT_API_KEY, GOAT_API_SECRET, GOAT_MERCHANT_ID } = env;
  if (!GOAT_API_KEY || !GOAT_API_SECRET || !GOAT_MERCHANT_ID) return null;
  return {
    apiKey: GOAT_API_KEY,
    apiSecret: GOAT_API_SECRET,
    merchantId: GOAT_MERCHANT_ID,
  };
}

function pickMorphCreds(env: NodeJS.ProcessEnv): MorphCreds | null {
  const { MORPH_ACCESS_KEY, MORPH_ACCESS_SECRET } = env;
  if (!MORPH_ACCESS_KEY || !MORPH_ACCESS_SECRET) return null;
  return { accessKey: MORPH_ACCESS_KEY, secretKey: MORPH_ACCESS_SECRET };
}

// ─── Stateful singletons (per-process) ───────────────────────────────────────
let _delMgr: any = null;
let _sessMgr: any = null;
let _batchMgr: any = null;
let _streamMgr: any = null;
let _ap2: Map<string, any> = new Map();

async function delegationMgr(): Promise<any> {
  if (_delMgr) return _delMgr;
  const { DelegationManager } = await np();
  _delMgr = new DelegationManager();
  return _delMgr;
}
async function sessionMgr(defaultBudget: number): Promise<any> {
  if (_sessMgr) return _sessMgr;
  const { SessionManager } = await np();
  _sessMgr = new SessionManager({ defaultBudget });
  return _sessMgr;
}
async function batchMgr(): Promise<any> {
  if (_batchMgr) return _batchMgr;
  const { BatchSettlementManager } = await np();
  _batchMgr = new BatchSettlementManager();
  return _batchMgr;
}
async function streamMgr(): Promise<any> {
  if (_streamMgr) return _streamMgr;
  const { StreamingPaymentManager } = await np();
  _streamMgr = new StreamingPaymentManager();
  return _streamMgr;
}
async function ap2For(agentId: string): Promise<any> {
  let c = _ap2.get(agentId);
  if (c) return c;
  const { AP2Client } = await np();
  c = new AP2Client({ agentId });
  _ap2.set(agentId, c);
  return c;
}

// ────────────────────────────────────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────────────────────────────────────

export const pay: NonNullable<unknown> = async (
  args: {
    url: string;
    chain?: ChainKey;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: string;
    max_price_micros?: number;
    proxy?: 'spacerouter' | 'auto' | 'none';
    reference_key?: string;
    region?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const chain = args.chain ?? ctx.defaultChain;
    const guard = guardMainnet(chain, ctx);
    if (guard) return guard;
    const w = await getWallet(ctx);
    const { createPaymentClient } = await np();
    const goat = chain.startsWith('goat-') ? pickGoatCreds(ctx.env) : null;
    if (chain.startsWith('goat-') && !goat) {
      return fail(
        'GOAT chain requires GOAT_API_KEY / GOAT_API_SECRET / GOAT_MERCHANT_ID env vars.',
        'GOAT_CREDS_MISSING',
        'Set the three env vars or switch to base-sepolia for testing.',
      );
    }
    const morph = chain.startsWith('morph-') ? pickMorphCreds(ctx.env) : null;
    if (chain.startsWith('morph-') && !morph) {
      return fail(
        'Morph chain requires MORPH_ACCESS_KEY / MORPH_ACCESS_SECRET env vars.',
        'MORPH_CREDS_MISSING',
        'Register at https://morph-rails.morph.network/x402 to obtain HMAC credentials.',
      );
    }
    let stellar: { secretKey: string; channelsApiKey?: string } | undefined;
    if (chain.startsWith('stellar-')) {
      const cfg = pickStellarConfig(ctx.env, w.privateKey, chain);
      if (isStellarConfigError(cfg)) return fail(cfg.error, cfg.code, cfg.hint);
      stellar = { secretKey: cfg.secretKey, channelsApiKey: cfg.channelsApiKey };
    }
    const client = createPaymentClient({
      chains: [chain] as never,
      ows: { wallet: w.name, privateKey: w.privateKey } as never,
      goat: goat ?? undefined,
      morph: morph ?? undefined,
      stellar,
    } as never);
    const init: Record<string, unknown> = { method: args.method ?? 'GET' };
    if (args.body) init.body = args.body;
    // v0.11+ options: proxy, referenceKey, region
    const opts: Record<string, unknown> = {};
    if (args.proxy) opts.proxy = args.proxy;
    if (args.reference_key) opts.referenceKey = args.reference_key;
    if (args.region) opts.region = args.region;
    const hasOpts = Object.keys(opts).length > 0;
    const res = await (client as { fetchWithPayment: (u: string, i?: unknown, o?: unknown) => Promise<Response> })
      .fetchWithPayment(args.url, init, hasOpts ? opts : undefined);
    const text = await res.text();
    return ok({ status: res.status, body: text.slice(0, 4000) });
  });

export const check_balance = async (
  args: { chain?: ChainKey },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const chain = args.chain ?? ctx.defaultChain;
    const w = await getWallet(ctx);
    if (chain.startsWith('stellar-')) {
      const cfg = pickStellarConfig(ctx.env, w.privateKey, chain);
      if (isStellarConfigError(cfg)) return fail(cfg.error, cfg.code, cfg.hint);
      const bal = await fetchStellarBalance(cfg.publicKey, chain);
      return ok({
        address: cfg.publicKey,
        chain,
        native_xlm: bal.native,
        usdc: bal.usdc,
      });
    }
    const meta = CHAIN_META[chain];
    const pub = createPublicClient({ chain: viemChain(chain), transport: http(meta.rpcUrl) });
    const native = await pub.getBalance({ address: w.address });
    const token = resolvePaymentToken(chain);
    let usdc: string | null = null;
    let paymentToken: { symbol: string; balance: string } | null = null;
    if (token) {
      const bal = (await pub.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [w.address],
      })) as bigint;
      const human = formatUnits(bal, token.decimals);
      paymentToken = { symbol: token.symbol, balance: human };
      // Back-compat: existing callers read .usdc — populate it only when the
      // canonical token is actually USDC, so creditcoin-mainnet doesn't lie.
      if (token.symbol === 'USDC') usdc = human;
    }
    return ok({
      address: w.address,
      chain,
      native_eth: formatUnits(native, 18),
      usdc,
      paymentToken,
    });
  });

export const create_paywall = async (args: {
  name: string;
  pay_to: Address;
  chain: ChainKey;
  tools: Array<{ name: string; description: string; price_micros: number }>;
}): Promise<ToolResult> =>
  wrap(async () => {
    const toolsLines = args.tools
      .map(
        (t) =>
          `    paidTool({ name: ${JSON.stringify(t.name)}, description: ${JSON.stringify(
            t.description,
          )}, price: ${t.price_micros}, handler: async (input) => ({ ok: true }) })`,
      )
      .join(',\n');
    const code =
      `import express from 'express';\n` +
      `import { createAgentProvider, paidTool } from 'n-payment';\n\n` +
      `const provider = createAgentProvider({\n` +
      `  name: ${JSON.stringify(args.name)},\n` +
      `  description: ${JSON.stringify(args.name + ' paywall')},\n` +
      `  payTo: ${JSON.stringify(args.pay_to)},\n` +
      `  chain: ${JSON.stringify(args.chain)},\n` +
      `  tools: [\n${toolsLines}\n  ],\n` +
      `});\n\n` +
      `const app = express();\napp.use(provider.middleware());\napp.listen(3000);`;
    return ok({ code });
  });

export const list_provider_tools = async (args: { url: string }): Promise<ToolResult> =>
  wrap(async () => {
    const url = args.url.replace(/\/+$/, '') + '/.well-known/tools';
    const res = await fetch(url);
    if (!res.ok) return fail(`Provider returned ${res.status}`, 'HTTP_ERROR');
    const data = await res.json();
    return ok(data);
  });

export const discover = async (args: {
  query: string;
  chain?: ChainKey;
  limit?: number;
}): Promise<ToolResult> =>
  wrap(async () => {
    const { createBazaarClient } = await np();
    const client = (createBazaarClient as (cfg?: unknown) => unknown)({
      mockCatalog: true,
    }) as { search: (q: string) => Promise<unknown> };
    const r = await client.search(args.query);
    return ok(r);
  });

export const select_provider = async (args: {
  candidates: Array<{
    url: string;
    reputation: number;
    price_micros: number;
    latency_ms?: number;
  }>;
  strategy?: 'cheapest' | 'fastest' | 'highest-reputation' | 'balanced';
}): Promise<ToolResult> =>
  wrap(async () => {
    const { ReputationRouter } = await np();
    const router = new ReputationRouter({ strategy: args.strategy ?? 'balanced' });
    const cands = args.candidates.map((c) => ({
      url: c.url,
      reputation: c.reputation,
      price: c.price_micros,
      latencyMs: c.latency_ms,
    }));
    const best = (router as { select: (c: unknown[]) => unknown }).select(cands);
    if (!best) return fail('No eligible provider', 'NO_PROVIDER');
    return ok(best);
  });

export const negotiate = async (args: {
  price_micros: number;
  caller_reputation: number;
  credit_threshold?: number;
  escrow_threshold_micros?: number;
}): Promise<ToolResult> =>
  wrap(async () => {
    // Use SDK PaymentNegotiator when available (v0.5+)
    try {
      const { PaymentNegotiator } = await np();
      const neg = new PaymentNegotiator({
        creditThreshold: args.credit_threshold ?? 80,
        escrowThreshold: args.escrow_threshold_micros ?? 50_000,
      });
      return ok(neg.negotiate(args.price_micros, args.caller_reputation));
    } catch {
      // Fallback inline logic when SDK not installed
      const creditThreshold = args.credit_threshold ?? 80;
      const escrowThreshold = args.escrow_threshold_micros ?? 50_000;
      if (args.caller_reputation >= creditThreshold) {
        return ok({ terms: 'credit', price: args.price_micros, reason: `Reputation ${args.caller_reputation} >= credit threshold` });
      }
      if (args.price_micros >= escrowThreshold && args.caller_reputation < creditThreshold) {
        return ok({ terms: 'escrow', price: args.price_micros, reason: `High value ${args.price_micros} with reputation ${args.caller_reputation}` });
      }
      return ok({ terms: 'direct', price: args.price_micros, reason: 'Standard direct payment' });
    }
  });

export const create_session = async (
  args: { provider: Address; chain: ChainKey; budget_micros: number; ttl_minutes?: number },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const mgr = await sessionMgr(args.budget_micros);
    const w = await getWallet(ctx);
    const session = (mgr as {
      create: (caller: string, provider: string, chain: ChainKey, b?: number) => unknown;
    }).create(w.address, args.provider, args.chain, args.budget_micros);
    return ok(session);
  });

export const create_escrow = async (
  args: {
    provider: Address;
    amount_micros: number;
    chain: ChainKey;
    evaluator?: string;
    timeout_hours?: number;
  },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const contract = ctx.env.NPAYMENT_ESCROW_CONTRACT;
    if (!contract) {
      return fail(
        'No escrow contract configured.',
        'ESCROW_CONFIG_MISSING',
        'Set NPAYMENT_ESCROW_CONTRACT to the ERC-8183 contract address for this chain.',
      );
    }
    const ows = await getOWSWallet(ctx);
    const { EscrowManager } = await np();
    const mgr = new EscrowManager(ows as never, {
      contractAddress: contract,
      evaluator: args.evaluator ?? 'self',
      chain: args.chain,
      timeoutMs: (args.timeout_hours ?? 1) * 3600_000,
    } as never);
    const job = await (mgr as {
      createJob: (provider: string, amount: number) => Promise<unknown>;
    }).createJob(args.provider, args.amount_micros);
    return ok(job);
  });

export const delegate_budget = async (args: {
  action: 'create' | 'delegate' | 'spend' | 'status';
  budget_micros?: number;
  amount_micros?: number;
  delegation_id?: string;
  chain?: ChainKey;
}, ctx: ToolContext): Promise<ToolResult> =>
  wrap(async () => {
    const mgr = await delegationMgr();
    const chain = args.chain ?? ctx.defaultChain;
    if (args.action === 'create') {
      if (args.budget_micros == null) return fail('budget_micros required for create');
      const root = (mgr as { createRoot: (b: number, c: ChainKey) => unknown }).createRoot(
        args.budget_micros,
        chain,
      );
      return ok(root);
    }
    if (!args.delegation_id) return fail('delegation_id required', 'MISSING_ARG');
    const parent = (mgr as { getContext: (id: string) => unknown | undefined }).getContext(
      args.delegation_id,
    );
    if (!parent) return fail('Delegation not found', 'NOT_FOUND');
    if (args.action === 'delegate') {
      if (args.amount_micros == null) return fail('amount_micros required for delegate');
      const child = (mgr as { delegate: (p: unknown, n: number) => unknown }).delegate(
        parent,
        args.amount_micros,
      );
      return ok(child);
    }
    if (args.action === 'spend') {
      if (args.amount_micros == null) return fail('amount_micros required for spend');
      const sp = (mgr as { spend: (c: unknown, n: number) => boolean }).spend(
        parent,
        args.amount_micros,
      );
      return sp ? ok({ remaining: (parent as { remainingBudget: number }).remainingBudget }) : fail('Insufficient budget', 'OVER_BUDGET');
    }
    return ok(parent);
  });

export const generate_qr = async (args: {
  merchant: Address;
  amount_usdc: string;
  chain: ChainKey;
  label?: string;
  memo?: string;
}): Promise<ToolResult> =>
  wrap(async () => {
    if (args.chain.startsWith('stellar-')) {
      const meta = CHAIN_META[args.chain];
      if (!meta.stellarUsdcIssuer)
        return fail(`No USDC issuer registered for ${args.chain}`, 'NO_USDC');
      const uri = buildStellarPaymentUri({
        destination: args.merchant as unknown as string,
        amount: args.amount_usdc,
        assetCode: 'USDC',
        assetIssuer: meta.stellarUsdcIssuer,
        memo: args.memo,
      });
      return ok({
        uri,
        chain: args.chain,
        merchant: args.merchant,
        amount_usdc: args.amount_usdc,
        label: args.label,
        memo: args.memo,
      });
    }
    const meta = CHAIN_META[args.chain];
    const token = resolvePaymentToken(args.chain);
    if (!token)
      return fail(`No ERC-20 payment token registered for ${args.chain}`, 'NO_USDC');
    const amount = parseUnits(args.amount_usdc, token.decimals);
    const uri =
      `ethereum:${token.address}@${meta.chainId}/transfer` +
      `?address=${args.merchant}&uint256=${amount.toString()}`;
    return ok({
      uri,
      chain: args.chain,
      merchant: args.merchant,
      amount_usdc: args.amount_usdc,
      token_symbol: token.symbol,
      label: args.label,
      memo: args.memo,
    });
  });

export const off_ramp = async (args: {
  amount_usdc: string;
  chain: ChainKey;
  fiat_currency?: string;
  destination_type: 'bank_account' | 'card' | 'mobile_money';
  destination_id: string;
  provider?: 'moonpay' | 'transak';
}): Promise<ToolResult> =>
  wrap(async () => {
    const { OffRampClient, MockMoonPayAdapter } = await np();
    const client = new OffRampClient(new MockMoonPayAdapter());
    const receipt = await (client as {
      withdraw: (p: unknown) => Promise<unknown>;
    }).withdraw({
      amount: args.amount_usdc,
      token: 'USDC',
      chain: args.chain,
      fiatCurrency: args.fiat_currency ?? 'USD',
      destination: { type: args.destination_type, id: args.destination_id },
    } as never);
    return ok(receipt);
  });

export const btc_lend = async (
  args: {
    action: 'borrow' | 'repay' | 'status';
    btc_amount?: string;
    usdc_amount?: string;
    vault_address?: Address;
    position_tx?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const vault = args.vault_address ?? (ctx.env.NPAYMENT_BTC_VAULT as Address | undefined);
    if (!vault) {
      return fail(
        'BTC vault address missing.',
        'VAULT_MISSING',
        'Pass vault_address arg or set NPAYMENT_BTC_VAULT env var.',
      );
    }
    const ows = await getOWSWallet(ctx);
    const { BtcLendingVault } = await np();
    const v = new BtcLendingVault(ows as never, {
      vaultAddress: vault,
      collateralRatio: 150,
    } as never);
    if (args.action === 'borrow') {
      if (!args.btc_amount || !args.usdc_amount) return fail('btc_amount + usdc_amount required');
      const tx = await (v as {
        lockAndBorrow: (b: string, u: string, c: number) => Promise<string>;
      }).lockAndBorrow(args.btc_amount, args.usdc_amount, CHAIN_META['goat-mainnet'].chainId);
      return ok({ tx });
    }
    return ok({ status: args.action, note: 'Repay/status to be wired with vault contract.' });
  });

export const register_identity = async (
  args: { agent_uri: string },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const ows = await getOWSWallet(ctx);
    const { GoatIdentity } = await np();
    const meta = CHAIN_META[ctx.defaultChain.startsWith('goat-') ? ctx.defaultChain : 'goat-mainnet'];
    const id = new GoatIdentity(ows as never, meta.rpcUrl, meta.chainId);
    const tx = await (id as { registerAgent: (u: string) => Promise<string> }).registerAgent(
      args.agent_uri,
    );
    return ok({ tx });
  });

export const get_reputation = async (
  args: { agent_id: string },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const ows = await getOWSWallet(ctx);
    const { GoatIdentity } = await np();
    const meta = CHAIN_META[ctx.defaultChain.startsWith('goat-') ? ctx.defaultChain : 'goat-mainnet'];
    const id = new GoatIdentity(ows as never, meta.rpcUrl, meta.chainId);
    const r = (await (id as {
      getSummary: (a: bigint) => Promise<{ count: bigint; sum: bigint }>;
    }).getSummary(BigInt(args.agent_id))) as { count: bigint; sum: bigint };
    return ok({
      agent_id: args.agent_id,
      count: r.count.toString(),
      sum: r.sum.toString(),
    });
  });

export const give_feedback = async (
  args: { agent_id: string; value: number; endpoint: string },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const ows = await getOWSWallet(ctx);
    const { GoatIdentity } = await np();
    const meta = CHAIN_META[ctx.defaultChain.startsWith('goat-') ? ctx.defaultChain : 'goat-mainnet'];
    const id = new GoatIdentity(ows as never, meta.rpcUrl, meta.chainId);
    const tx = await (id as {
      giveFeedback: (a: bigint, v: number, e: string) => Promise<string>;
    }).giveFeedback(BigInt(args.agent_id), args.value, args.endpoint);
    return ok({ tx });
  });

export const batch_settle = async (args: {
  action: 'open' | 'voucher' | 'settle' | 'status';
  session_id?: string;
  amount_micros?: number;
  budget_micros?: number;
  escrow_contract?: string;
  chain?: ChainKey;
}): Promise<ToolResult> =>
  wrap(async () => {
    const mgr = await batchMgr();
    if (args.action === 'open') {
      if (!args.budget_micros || !args.escrow_contract || !args.chain)
        return fail('open requires budget_micros, escrow_contract, chain');
      const session = (mgr as { openSession: (c: unknown) => unknown }).openSession({
        budget: BigInt(args.budget_micros),
        chain: args.chain,
        escrowContract: args.escrow_contract,
      });
      return ok(session);
    }
    if (!args.session_id) return fail('session_id required', 'MISSING_ARG');
    if (args.action === 'voucher') {
      if (args.amount_micros == null) return fail('amount_micros required');
      const v = (mgr as {
        signVoucher: (id: string, a: bigint) => unknown;
      }).signVoucher(args.session_id, BigInt(args.amount_micros));
      return ok(v);
    }
    if (args.action === 'settle') {
      const s = (mgr as { settle: (id: string) => unknown }).settle(args.session_id);
      return ok(s);
    }
    return ok((mgr as { getSession: (id: string) => unknown }).getSession(args.session_id));
  });

export const stream_pay = async (args: {
  action: 'open' | 'topup' | 'close' | 'status';
  recipient?: Address;
  rate_micros_per_sec?: number;
  duration_sec?: number;
  stream_id?: string;
  chain?: ChainKey;
}, ctx: ToolContext): Promise<ToolResult> =>
  wrap(async () => {
    const mgr = await streamMgr();
    if (args.action === 'open') {
      if (!args.recipient || !args.rate_micros_per_sec || !args.duration_sec)
        return fail('open requires recipient, rate_micros_per_sec, duration_sec');
      const budget = BigInt(args.rate_micros_per_sec * args.duration_sec);
      const stream = (mgr as { createStream: (c: unknown) => unknown }).createStream({
        provider: args.recipient,
        chain: args.chain ?? ctx.defaultChain,
        budget,
      });
      return ok(stream);
    }
    if (!args.stream_id) return fail('stream_id required', 'MISSING_ARG');
    if (args.action === 'close')
      return ok((mgr as { cancelStream: (id: string) => unknown }).cancelStream(args.stream_id));
    if (args.action === 'topup')
      return ok(
        (mgr as { settleInterval: (id: string) => unknown }).settleInterval(args.stream_id),
      );
    return ok((mgr as { getStream: (id: string) => unknown }).getStream(args.stream_id));
  });

export const ap2_mandate = async (
  args: { action: 'sign_intent' | 'sign_checkout' | 'verify'; mandate?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const w = await getWallet(ctx);
    const client = await ap2For(w.address);
    if (args.action === 'sign_checkout') {
      const m = (args.mandate as Record<string, unknown> | undefined) ?? {};
      const out = (client as {
        createCheckoutMandate: (c: unknown) => unknown;
      }).createCheckoutMandate(m);
      return ok(out);
    }
    if (args.action === 'sign_intent') {
      const { VerifiableIntentSigner } = await np();
      const signer = new VerifiableIntentSigner(w.address);
      const m = (args.mandate ?? {}) as Record<string, unknown>;
      const intent = (signer as {
        create: (a: string, c: Record<string, unknown>) => unknown;
      }).create(String(m.action ?? 'pay'), (m.constraints ?? {}) as Record<string, unknown>);
      return ok(intent);
    }
    // verify
    return fail('Verify requires mandate JSON', 'NOT_IMPLEMENTED', 'Pass `mandate` arg.');
  });

export const policy_check = async (
  args: { to: Address; amount_micros: number; chain: ChainKey; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const { PolicyEngine, AuditLog, SpendingGuard } = await np();
    // v0.12: build config from env vars for real amount enforcement
    const policyConfig: Record<string, unknown> = {};
    if (ctx.env.NPAYMENT_MAX_PER_TX) policyConfig.maxPerTransaction = BigInt(ctx.env.NPAYMENT_MAX_PER_TX);
    if (ctx.env.NPAYMENT_MAX_PER_HOUR) policyConfig.maxPerHour = BigInt(ctx.env.NPAYMENT_MAX_PER_HOUR);
    if (ctx.env.NPAYMENT_MAX_PER_DAY) policyConfig.maxPerDay = BigInt(ctx.env.NPAYMENT_MAX_PER_DAY);
    if (ctx.env.NPAYMENT_BLOCKLIST) policyConfig.blocklist = ctx.env.NPAYMENT_BLOCKLIST.split(',');
    if (ctx.env.NPAYMENT_TRUSTED_FACILITATORS) policyConfig.trustedFacilitators = ctx.env.NPAYMENT_TRUSTED_FACILITATORS.split(',');
    const engine = Object.keys(policyConfig).length > 0
      ? PolicyEngine.fromConfig(policyConfig)
      : new PolicyEngine([]);
    const guard = new SpendingGuard(engine, new AuditLog());
    const decision = await (guard as {
      evaluate: (req: unknown) => Promise<unknown>;
    }).evaluate({
      to: args.to,
      amount: BigInt(args.amount_micros),
      chain: args.chain,
      reason: args.reason,
      callerWallet: ctx.walletName,
    });
    return ok(decision);
  });

// ────────────────────────────────────────────────────────────────────────────
// XRPL handlers
// ────────────────────────────────────────────────────────────────────────────

function pickXrplSeed(env: NodeJS.ProcessEnv): string | null {
  return env.XRPL_SEED ?? null;
}

async function getXrplClient(chain: 'xrpl-testnet' | 'xrpl-mainnet', env: NodeJS.ProcessEnv) {
  const seed = pickXrplSeed(env);
  if (!seed) throw Object.assign(new Error('XRPL_SEED env var required.'), { code: 'XRPL_SEED_MISSING' });
  const { createXrplClient } = await np();
  return createXrplClient({ seed, network: chain === 'xrpl-mainnet' ? 'mainnet' : 'testnet' });
}

export const xrpl_pay = async (
  args: { destination: string; amount: string; chain: 'xrpl-testnet' | 'xrpl-mainnet' },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const guard = guardMainnet(args.chain, ctx);
    if (guard) return guard;
    const client = await getXrplClient(args.chain, ctx.env);
    try {
      const r = await client.sendRLUSD(args.destination, args.amount);
      return ok(r);
    } finally { await client.disconnect(); }
  });

export const xrpl_balance = async (
  args: { address?: string; chain: 'xrpl-testnet' | 'xrpl-mainnet' },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const client = await getXrplClient(args.chain, ctx.env);
    try {
      const addr = args.address ?? await client.getAddress();
      const balance = await client.getBalance(addr);
      return ok({ address: addr, chain: args.chain, rlusd: balance });
    } finally { await client.disconnect(); }
  });

export const xrpl_vault = async (
  args: { action: string; vault_id?: string; amount?: string; shares?: string; chain: 'xrpl-testnet' | 'xrpl-mainnet' },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const guard = guardMainnet(args.chain, ctx);
    if (guard) return guard;
    const client = await getXrplClient(args.chain, ctx.env);
    try {
      const v = client.vault;
      switch (args.action) {
        case 'create': return ok(await v.createVault());
        case 'deposit': {
          if (!args.vault_id || !args.amount) return fail('vault_id and amount required', 'MISSING_ARG');
          return ok(await v.deposit(args.vault_id, args.amount));
        }
        case 'withdraw': {
          if (!args.vault_id) return fail('vault_id required', 'MISSING_ARG');
          return ok(await v.withdraw(args.vault_id, { amount: args.amount, shares: args.shares }));
        }
        case 'info': {
          if (!args.vault_id) return fail('vault_id required', 'MISSING_ARG');
          return ok(await v.getVaultInfo(args.vault_id));
        }
        case 'exchange-rate': {
          if (!args.vault_id) return fail('vault_id required', 'MISSING_ARG');
          return ok(await v.getExchangeRate(args.vault_id));
        }
        default: return fail(`Unknown action: ${args.action}`);
      }
    } finally { await client.disconnect(); }
  });

export const xrpl_oracle = async (
  args: { asset: string; chain: 'xrpl-testnet' | 'xrpl-mainnet' },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const client = await getXrplClient(args.chain, ctx.env);
    try {
      return ok(await client.oracle.getPrice(args.asset));
    } finally { await client.disconnect(); }
  });

export const xrpl_trust_line = async (
  args: { chain: 'xrpl-testnet' | 'xrpl-mainnet' },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const guard = guardMainnet(args.chain, ctx);
    if (guard) return guard;
    const client = await getXrplClient(args.chain, ctx.env);
    try {
      const hash = await client.ensureTrustLine();
      return ok({ hash, existed: hash === null });
    } finally { await client.disconnect(); }
  });

// ────────────────────────────────────────────────────────────────────────────
// Circle Gateway nanopayments
// ────────────────────────────────────────────────────────────────────────────

export const circle_nanopay = async (
  args: { url: string; method?: string; body?: string; chain?: ChainKey },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const apiKey = ctx.env.CIRCLE_API_KEY;
    const walletId = ctx.env.CIRCLE_WALLET_ID;
    if (!apiKey) return fail('CIRCLE_API_KEY env var required.', 'CIRCLE_KEY_MISSING');
    const chain = args.chain ?? ctx.defaultChain;
    const guard = guardMainnet(chain, ctx);
    if (guard) return guard;
    const w = await getWallet(ctx);
    const { createPaymentClient } = await np();
    const client = createPaymentClient({
      chains: [chain] as never,
      ows: { wallet: w.name, privateKey: w.privateKey } as never,
      circle: { apiKey, environment: ctx.testnetMode ? 'sandbox' : 'production', walletId },
    } as never);
    const init: Record<string, unknown> = { method: args.method ?? 'GET' };
    if (args.body) init.body = args.body;
    const res = await (client as any).fetchWithPayment(args.url, init);
    return ok({ status: res.status, body: (await res.text()).slice(0, 4000) });
  });

// ────────────────────────────────────────────────────────────────────────────
// Stellar Trustless Work escrow
// ────────────────────────────────────────────────────────────────────────────

const _stellarJobs = new Map<string, unknown>();

export const stellar_escrow = async (
  args: { action: string; job_id?: string; milestone_index?: number; provider?: string; amount?: string; title?: string; milestones?: { description: string }[]; chain: 'stellar-testnet' | 'stellar-mainnet' },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const w = await getWallet(ctx);
    const cfg = pickStellarConfig(ctx.env, w.privateKey, args.chain);
    if (isStellarConfigError(cfg)) return fail(cfg.error, cfg.code, cfg.hint);
    const { TrustlessEscrowManager, StellarWallet } = await np();
    const wallet = new StellarWallet({ secretKey: cfg.secretKey });
    const mgr = new TrustlessEscrowManager(wallet, { chain: args.chain } as never);
    switch (args.action) {
      case 'create': {
        if (!args.provider || !args.amount || !args.title || !args.milestones)
          return fail('create requires provider, amount, title, milestones', 'MISSING_ARG');
        const job = await (mgr as any).createJob({ provider: args.provider, amount: args.amount, title: args.title, milestones: args.milestones });
        _stellarJobs.set(job.id, job);
        return ok(job);
      }
      case 'fund': {
        if (!args.job_id) return fail('job_id required', 'MISSING_ARG');
        return ok(await (mgr as any).fundJob(args.job_id));
      }
      case 'submit-milestone': {
        if (!args.job_id || args.milestone_index == null) return fail('job_id and milestone_index required', 'MISSING_ARG');
        return ok(await (mgr as any).submitMilestone(args.job_id, args.milestone_index));
      }
      case 'approve': {
        if (!args.job_id || args.milestone_index == null) return fail('job_id and milestone_index required', 'MISSING_ARG');
        return ok(await (mgr as any).approveAndRelease(args.job_id, args.milestone_index));
      }
      case 'release': {
        if (!args.job_id || args.milestone_index == null) return fail('job_id and milestone_index required', 'MISSING_ARG');
        return ok(await (mgr as any).approveAndRelease(args.job_id, args.milestone_index));
      }
      case 'dispute': {
        if (!args.job_id) return fail('job_id required', 'MISSING_ARG');
        return ok(await (mgr as any).dispute(args.job_id));
      }
      case 'status': {
        if (!args.job_id) return fail('job_id required', 'MISSING_ARG');
        return ok(_stellarJobs.get(args.job_id) ?? { error: 'Job not in local cache' });
      }
      default: return fail(`Unknown action: ${args.action}`);
    }
  });

// ────────────────────────────────────────────────────────────────────────────
// Agent Card (A2A)
// ────────────────────────────────────────────────────────────────────────────

export const agent_card = async (
  args: { action: 'generate' | 'read'; url?: string; name?: string; description?: string; pay_to?: string; chain?: ChainKey; skills?: { name: string; description: string; price: number }[] },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    if (args.action === 'read') {
      if (!args.url) return fail('url required for read', 'MISSING_ARG');
      const target = args.url.replace(/\/+$/, '') + '/.well-known/agent.json';
      const res = await fetch(target);
      if (!res.ok) return fail(`Agent card fetch returned ${res.status}`, 'HTTP_ERROR');
      return ok(await res.json());
    }
    // generate
    const { AgentCard } = await np();
    const card = new AgentCard({
      name: args.name ?? 'Agent',
      description: args.description ?? '',
      url: args.url ?? 'https://localhost',
      skills: (args.skills ?? []).map(s => ({ ...s, pricingMode: 'per-call' as const, inputSchema: {} })),
      chains: [args.chain ?? ctx.defaultChain],
      protocols: ['x402', 'a2a'],
      payTo: args.pay_to ?? '0x0000000000000000000000000000000000000000',
    } as never);
    return ok((card as any).toJSON());
  });

// ────────────────────────────────────────────────────────────────────────────
// Permit2 gasless approval
// ────────────────────────────────────────────────────────────────────────────

export const permit2_approve = async (
  args: { token: string; amount: string; spender: string; chain: ChainKey; deadline?: number },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const guard = guardMainnet(args.chain, ctx);
    if (guard) return guard;
    const { Permit2Signer } = await np();
    const w = await getWallet(ctx);
    const signer = new Permit2Signer(w.privateKey as `0x${string}`, CHAIN_META[args.chain].chainId);
    const params = {
      token: args.token,
      amount: BigInt(args.amount),
      spender: args.spender,
      nonce: BigInt(Date.now()),
      deadline: args.deadline ?? Math.floor(Date.now() / 1000) + 3600,
    };
    const sig = await (signer as any).sign(params);
    return ok({ ...params, amount: params.amount.toString(), nonce: params.nonce.toString(), signature: sig });
  });

// ────────────────────────────────────────────────────────────────────────────
// Direct ERC-20 transfer
// ────────────────────────────────────────────────────────────────────────────

export const direct_transfer = async (
  args: { to: string; token_address: string; amount: string; chain: ChainKey },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const guard = guardMainnet(args.chain, ctx);
    if (guard) return guard;
    const w = await getWallet(ctx);
    const { ViemTransactor } = await np();
    const meta = CHAIN_META[args.chain];
    const transactor = new ViemTransactor(
      { chainId: meta.chainId, name: meta.name, rpcUrl: meta.rpcUrl, protocols: [], tokens: {} } as never,
      w.privateKey as `0x${string}`,
    );
    const r = await transactor.transferERC20(args.to, args.token_address, BigInt(args.amount));
    return ok({ txHash: r.txHash, blockNumber: r.blockNumber.toString() });
  });

// ────────────────────────────────────────────────────────────────────────────
// Morph-specific handlers
// ────────────────────────────────────────────────────────────────────────────

export const morph_reference_key = async (args: {
  action: 'attach' | 'query';
  reference: string;
}): Promise<ToolResult> =>
  wrap(async () => {
    if (args.action === 'attach') {
      return ok({ calldata: attachReferenceKey(args.reference) });
    }
    try {
      const record = await queryReferenceKey(args.reference);
      return ok(record);
    } catch (e) {
      if (e instanceof ReferenceKeyNotFound) {
        return fail(
          e.message,
          e.code,
          'Reference Key requires Morph mainnet (April 2026+). On Hoodi testnet the API may return 404.',
        );
      }
      throw e;
    }
  });

export const morph_altfee_pay = async (): Promise<ToolResult> =>
  fail(
    'AltFee Type-0x7F gas-in-USDC transactions are pending n-payment SDK upstream support.',
    'STUB',
    `Track progress at ${MORPH_ALTFEE_TRACKING_URL}`,
  );

export const morph_passkey_pay = async (): Promise<ToolResult> =>
  fail(
    'Morph Passkey payments are pending n-payment SDK upstream support.',
    'STUB',
    `Track progress at ${MORPH_PASSKEY_TRACKING_URL}`,
  );

// ────────────────────────────────────────────────────────────────────────────
// SpaceRouter (Spacecoin) handlers — all on creditcoin-mainnet
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a SpaceRouterClient against the dedicated wallet. Single source of
 * truth so every spacerouter_* handler shares the exact same wiring.
 */
async function buildSpaceRouterClient(
  ctx: ToolContext,
  opts: {
    region?: string;
    ipType?: 'residential' | 'mobile' | 'business' | 'hosting';
    dryRun?: boolean;
  } = {},
): Promise<{ client: SpaceRouterClient; address: `0x${string}` }> {
  const w = await getSpaceRouterWallet();
  const cfg = pickSpaceRouterConfig(ctx.env, w.privateKey, opts);
  return { client: new SpaceRouterClient(cfg, ctx.env), address: w.address };
}

const failFromSr = (e: unknown): ToolResult => {
  if (e instanceof SpaceRouterError) return fail(e.message, e.code, e.hint);
  return fail((e as Error).message);
};

export const spacerouter_pay = async (
  args: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: string;
    region?: string;
    ip_type?: 'residential' | 'mobile' | 'business' | 'hosting';
    max_rate_space_per_gb?: string;
    auto_settle?: boolean;
    dry_run?: boolean;
  },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const dry = !!args.dry_run;
    if (!dry && ctx.testnetMode) {
      return fail(
        'creditcoin-mainnet is mainnet — opt in or pass dry_run=true.',
        'MAINNET_GUARD',
        'Run `n-payment-skill config set testnetMode false`, fund the dedicated SpaceRouter wallet with SPACE+CTC, or retry with dry_run=true.',
      );
    }
    const { client } = await buildSpaceRouterClient(ctx, {
      region: args.region,
      ipType: args.ip_type,
      dryRun: dry,
    });
    try {
      const res = await client.pay(
        args.url,
        {
          method: args.method ?? 'GET',
          ...(args.body ? { body: args.body } : {}),
        },
        {
          maxRateSpacePerGb: args.max_rate_space_per_gb
            ? parseSpaceWei(args.max_rate_space_per_gb)
            : undefined,
          autoSettle: args.auto_settle ?? true,
        },
      );
      return ok(res);
    } catch (e) {
      return failFromSr(e);
    }
  });

export const spacerouter_escrow = async (
  args: {
    action:
      | 'deposit'
      | 'balance'
      | 'initiate-withdrawal'
      | 'execute-withdrawal'
      | 'cancel-withdrawal'
      | 'status';
    amount_space?: string;
    address?: `0x${string}`;
    dry_run?: boolean;
  },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const dry = !!args.dry_run;
    const writes = new Set([
      'deposit',
      'initiate-withdrawal',
      'execute-withdrawal',
      'cancel-withdrawal',
    ]);
    if (!dry && writes.has(args.action) && ctx.testnetMode) {
      return fail(
        'creditcoin-mainnet is mainnet — opt in or pass dry_run=true.',
        'MAINNET_GUARD',
        'Run `n-payment-skill config set testnetMode false` and ensure the SpaceRouter wallet has SPACE+CTC before calling on-chain writes.',
      );
    }
    const { client, address } = await buildSpaceRouterClient(ctx, {
      dryRun: dry,
    });
    const target = args.address ?? address;
    try {
      switch (args.action) {
        case 'deposit': {
          if (!args.amount_space)
            return fail('amount_space required for deposit', 'MISSING_ARG');
          const r = await client.depositToEscrow(parseSpaceWei(args.amount_space));
          return ok({ action: 'deposit', ...r });
        }
        case 'balance': {
          const wei = await client.getEscrowBalance(target);
          return ok({
            address: target,
            balance_wei: wei.toString(),
            balance_space: formatSpaceWei(wei),
          });
        }
        case 'initiate-withdrawal': {
          if (!args.amount_space)
            return fail(
              'amount_space required for initiate-withdrawal',
              'MISSING_ARG',
            );
          const r = await client.initiateWithdrawal(parseSpaceWei(args.amount_space));
          return ok({ action: 'initiate-withdrawal', ...r });
        }
        case 'execute-withdrawal': {
          const r = await client.executeWithdrawal();
          return ok({ action: 'execute-withdrawal', ...r });
        }
        case 'cancel-withdrawal': {
          const r = await client.cancelWithdrawal();
          return ok({ action: 'cancel-withdrawal', ...r });
        }
        case 'status': {
          const s = await client.getStatus(target);
          return ok({ address: target, ...s });
        }
      }
    } catch (e) {
      return failFromSr(e);
    }
  });

export const spacerouter_sync_receipts = async (
  args: { dry_run?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const { client } = await buildSpaceRouterClient(ctx, {
      dryRun: !!args.dry_run,
    });
    try {
      return ok(await client.syncReceipts());
    } catch (e) {
      return failFromSr(e);
    }
  });

export const spacerouter_admin = async (
  args: {
    action: 'create' | 'list' | 'revoke';
    name?: string;
    api_key_id?: string;
    rate_limit_rpm?: number;
  },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const url = ctx.env.SR_ADMIN_URL;
    if (!url) {
      return fail(
        'SR_ADMIN_URL is not set.',
        'SPACEROUTER_ADMIN_URL_MISSING',
        'Export SR_ADMIN_URL pointing at your SpaceRouter coordination/admin API instance.',
      );
    }
    try {
      const admin = await createSpaceRouterAdmin(url);
      switch (args.action) {
        case 'create': {
          if (!args.name)
            return fail('name required for create', 'MISSING_ARG');
          return ok(
            await admin.createApiKey(args.name, {
              rateLimitRpm: args.rate_limit_rpm,
            }),
          );
        }
        case 'list':
          return ok(await admin.listApiKeys());
        case 'revoke': {
          if (!args.api_key_id)
            return fail('api_key_id required for revoke', 'MISSING_ARG');
          return ok(await admin.revokeApiKey(args.api_key_id));
        }
      }
    } catch (e) {
      return failFromSr(e);
    }
  });

// ────────────────────────────────────────────────────────────────────────────
// Aave V3 yield (Base Sepolia, USDC)
// ────────────────────────────────────────────────────────────────────────────
//
// Hybrid path resolved once per process (probeAavePath):
//   1. n-payment v0.13   — LendingClient | AaveAdapter | createYieldClient
//   2. @aave/client      — official supply/withdraw actions (mainnet-only today)
//   3. viem-direct       — Aave V3 Pool ABI on local provider (always works)
//
// Each `via=*` path is its own `tryAave*Via*` function. `aaveSupply`/
// `aaveWithdraw` walk the priority list, returning the first non-null result.
// Open/Closed: add a new SDK path = add a new try* function to the list.

type AaveAction = 'demo' | 'supply' | 'withdraw' | 'position';
type AaveVia = 'n-payment-v0.13' | '@aave/client' | 'viem-direct';

const AAVE_DEMO_DEFAULT_USDC = '1';
const AAVE_MIN_NATIVE_WEI = parseUnits('0.0005', 18); // gas reserve for Base Sepolia
const AAVE_BASE_SEPOLIA_CHAIN_ID = 84532;

const AAVE_POOL_ABI = [
  {
    type: 'function',
    name: 'supply',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'uint256' },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
] as const;

// Aave's testnet mock USDC exposes a public mint(to, amount). Some variants
// also expose a parameterless mint(amount) — we try mint(to,amount) first.
const MOCK_ERC20_MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

interface AaveCtx {
  chain: 'base-sepolia';
  pool: Address;
  usdc: Address;
  decimals: 6;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: any;
  owner: Address;
}

let _aavePathCache: AaveVia | null = null;

/** Test-only hook: reset the cached SDK probe between vitest cases. */
export function __resetAavePathForTests(): void {
  _aavePathCache = null;
}

/** Returns the env override, the chain-meta default, or null. */
function resolveAavePool(env: NodeJS.ProcessEnv): Address | null {
  const override = env.AAVE_POOL_ADDRESS;
  if (override && /^0x[a-fA-F0-9]{40}$/.test(override)) return override as Address;
  return CHAIN_META['base-sepolia'].aave?.pool ?? null;
}

/**
 * Aave's testnet Pool registers its own mock USDC, distinct from Circle's
 * USDC used elsewhere on Base Sepolia. Resolution order:
 *   1. AAVE_USDC_ADDRESS env override
 *   2. CHAIN_META['base-sepolia'].aave.usdc (Aave mock)
 *   3. CHAIN_META['base-sepolia'].usdc        (Circle's, fallback only)
 */
function resolveAaveUsdc(env: NodeJS.ProcessEnv): Address | null {
  const override = env.AAVE_USDC_ADDRESS;
  if (override && /^0x[a-fA-F0-9]{40}$/.test(override)) return override as Address;
  const meta = CHAIN_META['base-sepolia'];
  return (meta.aave?.usdc as Address | undefined) ?? (meta.usdc as Address | undefined) ?? null;
}

async function buildAaveCtx(
  ctx: ToolContext,
): Promise<AaveCtx | ToolResult> {
  const chain = 'base-sepolia' as const;
  const meta = CHAIN_META[chain];
  const usdc = resolveAaveUsdc(ctx.env);
  if (!usdc) return fail('USDC not configured for base-sepolia.', 'NO_USDC');
  const pool = resolveAavePool(ctx.env);
  if (!pool)
    return fail(
      'No Aave V3 Pool configured for base-sepolia.',
      'AAVE_POOL_MISSING',
      'Set AAVE_POOL_ADDRESS env var to a deployed V3 Pool.',
    );
  const w = await getWallet(ctx);
  const { createWalletClient } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(w.privateKey);
  const transport = http(meta.rpcUrl);
  const vchain = viemChain(chain);
  const publicClient = createPublicClient({ chain: vchain, transport });
  const walletClient = createWalletClient({ account, chain: vchain, transport });
  return {
    chain,
    pool,
    usdc,
    decimals: 6,
    publicClient,
    walletClient,
    owner: account.address,
  };
}

async function readATokenAddress(c: AaveCtx): Promise<Address> {
  const data = (await c.publicClient.readContract({
    address: c.pool,
    abi: AAVE_POOL_ABI,
    functionName: 'getReserveData',
    args: [c.usdc],
  })) as { aTokenAddress: Address };
  return data.aTokenAddress;
}

async function readUsdcBalance(c: AaveCtx): Promise<bigint> {
  return (await c.publicClient.readContract({
    address: c.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [c.owner],
  })) as bigint;
}

async function readATokenBalance(c: AaveCtx, aToken: Address): Promise<bigint> {
  return (await c.publicClient.readContract({
    address: aToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [c.owner],
  })) as bigint;
}

async function ensureAllowance(c: AaveCtx, amount: bigint): Promise<Hex | null> {
  const allowance = (await c.publicClient.readContract({
    address: c.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [c.owner, c.pool],
  })) as bigint;
  if (allowance >= amount) return null;
  const hash = (await c.walletClient.writeContract({
    address: c.usdc,
    abi: erc20Abi,
    functionName: 'approve',
    args: [c.pool, amount],
  })) as Hex;
  await c.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Probe upstream lending SDKs in priority order. Cached for the process
 * lifetime — no path can downgrade mid-run. Returns 'viem-direct' as the
 * always-available fallback.
 */
async function probeAavePath(): Promise<AaveVia> {
  if (_aavePathCache) return _aavePathCache;
  // 1) n-payment v0.13 lending exports.
  try {
    const sdk = (await np()) as Record<string, unknown>;
    if (
      typeof sdk['LendingClient'] === 'function' ||
      typeof sdk['AaveAdapter'] === 'function' ||
      typeof sdk['createYieldClient'] === 'function'
    ) {
      _aavePathCache = 'n-payment-v0.13';
      return _aavePathCache;
    }
  } catch {
    // n-payment not installed — continue.
  }
  // 2) @aave/client (optional peerDep).
  try {
    // @ts-expect-error optional peer dep, may not be installed
    await import('@aave/client');
    _aavePathCache = '@aave/client';
    return _aavePathCache;
  } catch {
    // not installed — continue.
  }
  _aavePathCache = 'viem-direct';
  return _aavePathCache;
}

// ─── SDK try-paths (return null on miss/fail; aaveSupply/Withdraw fall through)

/** Execute an @aave/client returned plan via the local wallet client. */
async function executeAavePlan(
  c: AaveCtx,
  plan: any,
): Promise<{ approval_tx?: Hex; tx_hash: Hex }> {
  let approval_tx: Hex | undefined;
  if (plan?.__typename === 'ApprovalRequired') {
    approval_tx = (await c.walletClient.sendTransaction({
      to: plan.approval.to,
      value: BigInt(plan.approval.value ?? 0),
      data: plan.approval.data,
    })) as Hex;
    await c.publicClient.waitForTransactionReceipt({ hash: approval_tx });
  }
  const tx = plan?.__typename === 'ApprovalRequired' ? plan.originalTransaction : plan;
  const tx_hash = (await c.walletClient.sendTransaction({
    to: tx.to,
    value: BigInt(tx.value ?? 0),
    data: tx.data,
  })) as Hex;
  await c.publicClient.waitForTransactionReceipt({ hash: tx_hash });
  return { approval_tx, tx_hash };
}

async function tryAaveSupplyViaNPayment(
  c: AaveCtx,
  amount: bigint,
): Promise<ToolResult | null> {
  try {
    const sdk = (await np()) as Record<string, any>;
    const factory = sdk.createYieldClient as ((cfg: unknown) => any) | undefined;
    const Klass = (sdk.LendingClient ?? sdk.AaveAdapter) as
      | (new (cfg: unknown) => any)
      | undefined;
    const client = factory
      ? factory({ chain: c.chain })
      : Klass
        ? new Klass({ chain: c.chain })
        : null;
    if (!client || typeof client.supply !== 'function') return null;
    const r = await client.supply({
      asset: c.usdc,
      amount,
      onBehalfOf: c.owner,
      pool: c.pool,
    });
    if (!r?.txHash && !r?.tx_hash && !r?.hash) return null;
    const supply_tx = (r.txHash ?? r.tx_hash ?? r.hash) as Hex;
    const aToken = await readATokenAddress(c);
    const aUsdcBalance = formatUnits(await readATokenBalance(c, aToken), c.decimals);
    return ok({
      chain: c.chain,
      owner: c.owner,
      supplied_amount: formatUnits(amount, c.decimals),
      aTokenAddress: aToken,
      aUsdcBalance,
      approval_tx: r.approvalTx ?? r.approval_tx,
      supply_tx,
      via: 'n-payment-v0.13' as AaveVia,
    });
  } catch {
    return null;
  }
}

async function tryAaveSupplyViaAaveClient(
  c: AaveCtx,
  amount: bigint,
  amountUsdc: string,
): Promise<ToolResult | null> {
  try {
    // @ts-expect-error optional peer dep
    const { AaveClient, evmAddress } = await import('@aave/client');
    // @ts-expect-error optional peer dep
    const { supply } = await import('@aave/client/actions');
    const aaveClient = AaveClient.create();
    const r = await supply(aaveClient, {
      market: c.pool,
      amount: { erc20: { currency: c.usdc, value: amountUsdc } },
      sender: evmAddress(c.owner),
      chainId: AAVE_BASE_SEPOLIA_CHAIN_ID,
    });
    if (r.isErr()) return null;
    const { approval_tx, tx_hash } = await executeAavePlan(c, r.value);
    const aToken = await readATokenAddress(c);
    const aUsdcBalance = formatUnits(await readATokenBalance(c, aToken), c.decimals);
    return ok({
      chain: c.chain,
      owner: c.owner,
      supplied_amount: amountUsdc,
      aTokenAddress: aToken,
      aUsdcBalance,
      approval_tx,
      supply_tx: tx_hash,
      via: '@aave/client' as AaveVia,
    });
  } catch {
    return null;
  }
}

async function aaveSupplyViaViem(
  c: AaveCtx,
  amount: bigint,
  amountUsdc: string,
): Promise<ToolResult> {
  let aToken: Address;
  try {
    aToken = await readATokenAddress(c);
  } catch {
    return fail(
      `Aave Pool at ${c.pool} did not return reserve data for USDC.`,
      'AAVE_POOL_INVALID',
      'Override with AAVE_POOL_ADDRESS env var.',
    );
  }
  const approval_tx = await ensureAllowance(c, amount);
  const supply_tx = (await c.walletClient.writeContract({
    address: c.pool,
    abi: AAVE_POOL_ABI,
    functionName: 'supply',
    args: [c.usdc, amount, c.owner, 0],
  })) as Hex;
  await c.publicClient.waitForTransactionReceipt({ hash: supply_tx });
  const aUsdcBalance = formatUnits(await readATokenBalance(c, aToken), c.decimals);
  return ok({
    chain: c.chain,
    owner: c.owner,
    supplied_amount: amountUsdc,
    aTokenAddress: aToken,
    aUsdcBalance,
    approval_tx,
    supply_tx,
    via: 'viem-direct' as AaveVia,
  });
}

async function aaveWithdrawViaViem(
  c: AaveCtx,
  amount: bigint,
  amountUsdc: string,
): Promise<ToolResult> {
  let aToken: Address;
  try {
    aToken = await readATokenAddress(c);
  } catch {
    return fail(
      `Aave Pool at ${c.pool} did not return reserve data for USDC.`,
      'AAVE_POOL_INVALID',
      'Override with AAVE_POOL_ADDRESS env var.',
    );
  }
  const aBal = await readATokenBalance(c, aToken);
  if (aBal < amount)
    return fail(
      `Supplied balance is ${formatUnits(aBal, c.decimals)} aUSDC, less than ${amountUsdc}.`,
      'INSUFFICIENT_AUSDC',
    );
  const withdraw_tx = (await c.walletClient.writeContract({
    address: c.pool,
    abi: AAVE_POOL_ABI,
    functionName: 'withdraw',
    args: [c.usdc, amount, c.owner],
  })) as Hex;
  await c.publicClient.waitForTransactionReceipt({ hash: withdraw_tx });
  const wallet_usdc = formatUnits(await readUsdcBalance(c), c.decimals);
  return ok({
    chain: c.chain,
    owner: c.owner,
    withdrawn_amount: amountUsdc,
    wallet_usdc,
    withdraw_tx,
    via: 'viem-direct' as AaveVia,
  });
}

// ─── Public action implementations ──────────────────────────────────────────

async function aavePosition(c: AaveCtx, via: AaveVia): Promise<ToolResult> {
  let aToken: Address;
  try {
    aToken = await readATokenAddress(c);
  } catch {
    return fail(
      `Aave Pool at ${c.pool} did not return reserve data for USDC.`,
      'AAVE_POOL_INVALID',
      'Override with AAVE_POOL_ADDRESS env var.',
    );
  }
  const [aBal, uBal] = await Promise.all([
    readATokenBalance(c, aToken),
    readUsdcBalance(c),
  ]);
  return ok({
    chain: c.chain,
    owner: c.owner,
    aTokenAddress: aToken,
    supplied_aUSDC: formatUnits(aBal, c.decimals),
    wallet_usdc: formatUnits(uBal, c.decimals),
    via,
  });
}

async function aaveSupply(
  c: AaveCtx,
  amountUsdc: string,
  via: AaveVia,
): Promise<ToolResult> {
  const amount = parseUnits(amountUsdc, c.decimals);
  if (amount <= 0n) return fail('amount_usdc must be > 0', 'INVALID_AMOUNT');
  const balance = await readUsdcBalance(c);
  if (balance < amount)
    return fail(
      `Wallet has ${formatUnits(balance, c.decimals)} USDC but ${amountUsdc} required.`,
      'INSUFFICIENT_FUNDS',
      'Run `n-payment-skill faucet --chain base-sepolia` or open https://faucet.circle.com.',
    );
  if (via === 'n-payment-v0.13') {
    const r = await tryAaveSupplyViaNPayment(c, amount);
    if (r) return r;
  }
  if (via === '@aave/client') {
    const r = await tryAaveSupplyViaAaveClient(c, amount, amountUsdc);
    if (r) return r;
  }
  return aaveSupplyViaViem(c, amount, amountUsdc);
}

async function aaveWithdraw(
  c: AaveCtx,
  amountUsdc: string,
  _via: AaveVia,
): Promise<ToolResult> {
  // Withdraw uses viem-direct unconditionally — neither upstream SDK
  // supports Base Sepolia today, and the Pool ABI is stable.
  const amount = parseUnits(amountUsdc, c.decimals);
  if (amount <= 0n) return fail('amount_usdc must be > 0', 'INVALID_AMOUNT');
  return aaveWithdrawViaViem(c, amount, amountUsdc);
}

async function aaveDemo(
  c: AaveCtx,
  amountUsdc: string,
  autoFaucet: boolean,
  via: AaveVia,
): Promise<ToolResult> {
  // 1) Gas guard: Base Sepolia ETH has no programmatic faucet — fail fast.
  const native = await c.publicClient.getBalance({ address: c.owner });
  if (native < AAVE_MIN_NATIVE_WEI)
    return fail(
      `Wallet has ${formatUnits(native, 18)} ETH on Base Sepolia, less than 0.0005 needed for gas.`,
      'INSUFFICIENT_GAS',
      'Drip ETH at https://www.alchemy.com/faucets/base-sepolia',
    );
  // 2) USDC balance with optional auto-faucet via mint() on Aave's mock USDC.
  //    The Circle faucet wouldn't help here — Aave's testnet Pool only knows
  //    its own mock token, distinct from Circle's USDC.
  const required = parseUnits(amountUsdc, c.decimals);
  let balance = await readUsdcBalance(c);
  let mintTx: Hex | undefined;
  if (balance < required && autoFaucet) {
    mintTx = (await tryMintAaveMockUsdc(c, required - balance)) ?? undefined;
    if (mintTx) balance = await readUsdcBalance(c);
  }
  if (balance < required)
    return fail(
      `Wallet has ${formatUnits(balance, c.decimals)} mock-USDC at ${c.usdc}, but ${amountUsdc} required.`,
      'INSUFFICIENT_FUNDS',
      `Mint mock-USDC at ${c.usdc} (call mint(yourAddress, amount)) and retry.`,
    );
  // 3) Supply.
  const result = await aaveSupply(c, amountUsdc, via);
  if (!result.ok) return result;
  return ok({ ...(result.data as object), mint_tx: mintTx });
}

/**
 * Attempt to mint Aave's mock USDC. Returns the tx hash when the mock
 * exposes a public `mint(address,uint256)`, or null if the call reverts
 * (e.g., the deployment uses a different funding mechanism).
 */
async function tryMintAaveMockUsdc(
  c: AaveCtx,
  amount: bigint,
): Promise<Hex | null> {
  try {
    const hash = (await c.walletClient.writeContract({
      address: c.usdc,
      abi: MOCK_ERC20_MINT_ABI,
      functionName: 'mint',
      args: [c.owner, amount],
    })) as Hex;
    await c.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  } catch {
    return null;
  }
}

export const aave_yield = async (
  args: {
    action: AaveAction;
    amount_usdc?: string;
    chain?: 'base-sepolia';
    auto_faucet?: boolean;
  },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const c = await buildAaveCtx(ctx);
    if (!('publicClient' in c)) return c; // ToolResult error
    const via = await probeAavePath();
    switch (args.action) {
      case 'position':
        return aavePosition(c, via);
      case 'supply':
        if (!args.amount_usdc)
          return fail('amount_usdc required for supply', 'MISSING_ARG');
        return aaveSupply(c, args.amount_usdc, via);
      case 'withdraw':
        if (!args.amount_usdc)
          return fail('amount_usdc required for withdraw', 'MISSING_ARG');
        return aaveWithdraw(c, args.amount_usdc, via);
      case 'demo':
        return aaveDemo(
          c,
          args.amount_usdc ?? AAVE_DEMO_DEFAULT_USDC,
          args.auto_faucet ?? true,
          via,
        );
    }
  });


// ────────────────────────────────────────────────────────────────────────────
// Flare FAssets — XRP → FXRP bridge via Flare Smart Accounts (proof-based).
//
// One-line UX: the user prompts "bridge XRP to FXRP". The handler:
//   1. Auto-discovers the operator XRPL address and first agent vault on
//      Flare Coston2 (zero config; env overrides honored).
//   2. Encodes the FXRP collateralReservation reference (32 bytes).
//   3. Submits ONE XRPL Payment carrying the reference as InvoiceID. The
//      Flare operator backend pulls an FDC attestation and calls
//      `MasterAccountController.reserveCollateral` on the user's deterministic
//      PersonalAccount; FXRP is minted into that account.
//   4. Polls FXRP balance until it increases, or timeout.
// ────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XrplLib = any;

async function loadXrplLib(): Promise<XrplLib> {
  try {
    // xrpl is a transitive dep of n-payment; loaded lazily so install never
    // fails when the SDK is unavailable. Typed as `any` because the type
    // package is optional too.
    // @ts-expect-error optional transitive dep — types may be absent
    return await import('xrpl');
  } catch {
    throw Object.assign(
      new Error(
        'xrpl library not found. Install n-payment latest: `npm i n-payment@latest` or `pnpm add n-payment@^0.15`.',
      ),
      { code: 'XRPL_LIB_MISSING' },
    );
  }
}

async function xrplAddressFromSeed(seed: string): Promise<string> {
  const xrpl = await loadXrplLib();
  return xrpl.Wallet.fromSeed(seed).address as string;
}

const XRPL_TESTNET_WS = 'wss://s.altnet.rippletest.net:51233';
const XRPL_MAINNET_WS = 'wss://xrplcluster.com';

async function submitXrplPayment(opts: {
  seed: string;
  destination: string;
  amountXrp: string;
  reference: `0x${string}`;
  network: 'testnet' | 'mainnet';
}): Promise<{ hash: string }> {
  const xrpl = await loadXrplLib();
  const client = new xrpl.Client(
    opts.network === 'mainnet' ? XRPL_MAINNET_WS : XRPL_TESTNET_WS,
  );
  await client.connect();
  try {
    const wallet = xrpl.Wallet.fromSeed(opts.seed);
    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: wallet.address,
      Destination: opts.destination,
      Amount: xrpl.xrpToDrops(opts.amountXrp),
      // XRPL InvoiceID is exactly 32 bytes (64 hex chars, uppercase, no 0x).
      InvoiceID: opts.reference.slice(2).toUpperCase(),
    };
    const prepared = await client.autofill(tx as never);
    const signed = wallet.sign(prepared as never);
    const result = await client.submitAndWait(signed.tx_blob);
    const meta = (result.result as { meta?: { TransactionResult?: string } }).meta;
    const code = meta?.TransactionResult ?? 'UNKNOWN';
    if (code !== 'tesSUCCESS') {
      throw Object.assign(new Error(`XRPL Payment failed: ${code}`), {
        code: 'XRPL_SUBMIT_FAILED',
      });
    }
    return { hash: (result.result as { hash: string }).hash };
  } finally {
    await client.disconnect();
  }
}

export const xrpl_to_fxrp_bridge = async (
  args: {
    amount_xrp: string;
    lots: number;
    agent_vault_id?: string;
    operator_xrpl?: string;
    wait: boolean;
    poll_interval_ms: number;
    timeout_ms: number;
    chain: 'flare-coston2' | 'flare-mainnet';
  },
  ctx: ToolContext,
): Promise<ToolResult> =>
  wrap(async () => {
    const guard = guardMainnet(args.chain as ChainKey, ctx);
    if (guard) return guard;

    const seed = ctx.env.XRPL_SEED;
    if (!seed) {
      return fail(
        'XRPL_SEED env var is required for the XRPL → FXRP bridge.',
        'XRPL_SEED_MISSING',
        'export XRPL_SEED=sEd…   (XRPL Testnet seed; faucet: https://faucet.altnet.rippletest.net/accounts).',
      );
    }

    // Auto-discover operator XRPL + first agent vault in parallel.
    const [operators, agents] = await Promise.all([
      flare.getOperatorXrplAddresses(args.chain),
      flare.getAgentVaults(args.chain),
    ]);
    if (operators.length === 0) {
      return fail(
        'No operator XRPL addresses are registered on this Flare network.',
        'FLARE_NOT_CONFIGURED',
        'Verify the chain has Smart Accounts deployed; check https://dev.flare.network/smart-accounts/overview.',
      );
    }
    if (agents.length === 0) {
      return fail(
        'No FAssets agent vaults are registered on this Flare network.',
        'NO_AGENT_VAULTS',
        'Wait for an agent to register, or pass a known agent_vault_id explicitly.',
      );
    }

    const operatorXrpl = args.operator_xrpl ?? operators[0]!;
    const agentVaultId = args.agent_vault_id
      ? BigInt(args.agent_vault_id)
      : agents[0]!.id;

    const xrplAddress = await xrplAddressFromSeed(seed);
    const personalAccount = await flare.getPersonalAccountAddress(
      xrplAddress,
      args.chain,
    );
    const reference = flare.encodeCollateralReservationReference({
      agentVaultId,
      lots: BigInt(args.lots),
    });
    const fxrpBalanceBefore = await flare.getFxrpBalance(
      personalAccount,
      args.chain,
    );

    const submitted = await submitXrplPayment({
      seed,
      destination: operatorXrpl,
      amountXrp: args.amount_xrp,
      reference,
      network: args.chain === 'flare-mainnet' ? 'mainnet' : 'testnet',
    });

    const baseResult = {
      xrpl_tx_hash: submitted.hash,
      xrpl_address: xrplAddress,
      operator_xrpl: operatorXrpl,
      agent_vault_id: agentVaultId.toString(),
      personal_account_address: personalAccount,
      reference,
      fxrp_balance_before: fxrpBalanceBefore.toString(),
    };

    if (!args.wait) {
      return ok({ step: 'submitted', ...baseResult });
    }

    const start = Date.now();
    let fxrpBalanceAfter = fxrpBalanceBefore;
    while (Date.now() - start < args.timeout_ms) {
      await sleep(args.poll_interval_ms);
      fxrpBalanceAfter = await flare.getFxrpBalance(personalAccount, args.chain);
      if (fxrpBalanceAfter > fxrpBalanceBefore) break;
    }
    const minted = fxrpBalanceAfter > fxrpBalanceBefore;
    const duration_ms = Date.now() - start;

    if (!minted) {
      return fail(
        `FXRP balance did not increase within ${Math.round(args.timeout_ms / 1000)}s. The mint may still complete asynchronously; the XRPL Payment ${submitted.hash} is on-chain.`,
        'MINT_TIMEOUT',
        `Track ${personalAccount} on https://coston2-explorer.flare.network or re-run with wait=false to skip polling.`,
      );
    }

    return ok({
      step: 'minted',
      ...baseResult,
      fxrp_balance_after: fxrpBalanceAfter.toString(),
      duration_ms,
    });
  });

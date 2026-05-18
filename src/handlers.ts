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

// ─── n-payment lazy loader ───────────────────────────────────────────────────
type NP = typeof import('n-payment');
let _np: NP | null = null;
async function np(): Promise<NP> {
  if (_np) return _np;
  try {
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
    const client = createPaymentClient({
      chains: [chain] as never,
      ows: { wallet: w.name, privateKey: w.privateKey } as never,
      goat: goat ?? undefined,
    } as never);
    const init: Record<string, unknown> = { method: args.method ?? 'GET' };
    if (args.body) init.body = args.body;
    const res = await (client as { fetchWithPayment: (u: string, i?: unknown) => Promise<Response> })
      .fetchWithPayment(args.url, init);
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
    const meta = CHAIN_META[chain];
    const pub = createPublicClient({ chain: viemChain(chain), transport: http(meta.rpcUrl) });
    const native = await pub.getBalance({ address: w.address });
    let usdc: string | null = null;
    if (meta.usdc) {
      const bal = (await pub.readContract({
        address: meta.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [w.address],
      })) as bigint;
      usdc = formatUnits(bal, 6);
    }
    return ok({
      address: w.address,
      chain,
      native_eth: formatUnits(native, 18),
      usdc,
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
    const { PaymentNegotiator } = await np();
    const neg = new PaymentNegotiator({
      creditThreshold: args.credit_threshold,
      escrowThreshold: args.escrow_threshold_micros,
    });
    const r = (neg as {
      negotiate: (p: number, rep: number) => unknown;
    }).negotiate(args.price_micros, args.caller_reputation);
    return ok(r);
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
    const meta = CHAIN_META[args.chain];
    if (!meta.usdc) return fail(`No USDC token registered for ${args.chain}`, 'NO_USDC');
    const amount = parseUnits(args.amount_usdc, 6);
    const uri =
      `ethereum:${meta.usdc}@${meta.chainId}/transfer` +
      `?address=${args.merchant}&uint256=${amount.toString()}`;
    return ok({
      uri,
      chain: args.chain,
      merchant: args.merchant,
      amount_usdc: args.amount_usdc,
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
    // Default deny-nothing policy when user hasn't configured rules.
    const engine = new PolicyEngine([]);
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

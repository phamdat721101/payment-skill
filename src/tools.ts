// Single source of truth for every tool the agent can call.
//
// One declarative array drives:
//   • the SKILL.md tool section (skill.ts)
//   • MCP `tools/list` and `tools/call` handlers (mcp.ts)
//   • the OpenAI / function-call tools.json export (schema.ts)
//   • LangChain & LlamaIndex adapters (T13)
//
// SOLID: each Tool object owns its name, schema, and handler. Adding a tool =
// one new entry. Handlers receive an injected ToolContext (no global lookups).
// Handler implementations live in ./handlers.ts to keep this file declarative.

import { z } from 'zod';
import * as h from './handlers.js';

// ─── Shared enums & primitives ───────────────────────────────────────────────
export const CHAIN_KEYS = [
  'base-sepolia',
  'arbitrum-sepolia',
  'goat-testnet',
  'goat-mainnet',
  'tempo-testnet',
  'tempo-mainnet',
  'base-mainnet',
  'xrpl-testnet',
  'xrpl-mainnet',
  'stellar-testnet',
  'stellar-mainnet',
  'solana-mainnet',
  'solana-devnet',
] as const;

export type ChainKey = (typeof CHAIN_KEYS)[number];
export const Chain = z.enum(CHAIN_KEYS);

const Address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'invalid 0x address');
const PositiveInt = z.number().int().positive();
const PriceMicros = z.number().int().nonnegative()
  .describe('Price in token base units (1 USDC = 1_000_000)');

// ─── Tool contract ───────────────────────────────────────────────────────────
export type ToolResult =
  | { ok: true; data: unknown; meta?: Record<string, unknown> }
  | { ok: false; error: string; code?: string; hint?: string };

export interface ToolContext {
  /** Wallet name under ~/.n-payment/wallets/<name>.json */
  walletName: string;
  /** Default chain when caller omits one */
  defaultChain: ChainKey;
  /** True when the user has not opted into mainnet keys */
  testnetMode: boolean;
  /** Process env, injected for testability */
  env: NodeJS.ProcessEnv;
}

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  readonly handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

// Type-checks the schema/handler pair at definition site, then widens to
// the homogeneous storage type so the registry array is sound.
const def = <S extends z.ZodTypeAny>(t: Tool<S>): Tool => t as unknown as Tool;

// ─── Tool registry (20) ──────────────────────────────────────────────────────
export const TOOLS: ReadonlyArray<Tool> = [
  def({
    name: 'pay',
    description:
      'Pay any URL via x402 / MPP / GOAT (auto-detect). Handles HTTP 402 challenge → sign → settle → retry. Returns the final response body.',
    schema: z.object({
      url: z.string().url(),
      chain: Chain.optional(),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
      body: z.string().optional(),
      max_price_micros: PriceMicros.optional()
        .describe('Refuse to pay if price exceeds this cap'),
    }),
    handler: h.pay as never,
  }),

  def({
    name: 'check_balance',
    description: 'Check the agent wallet USDC + native balance on a chain.',
    schema: z.object({ chain: Chain.optional() }),
    handler: h.check_balance as never,
  }),

  def({
    name: 'create_paywall',
    description:
      'Generate Express middleware that monetizes one or more endpoints. Returns ready-to-paste TypeScript code.',
    schema: z.object({
      name: z.string().min(1),
      pay_to: Address,
      chain: Chain,
      tools: z.array(z.object({
        name: z.string(),
        description: z.string(),
        price_micros: PriceMicros,
      })).min(1),
    }),
    handler: h.create_paywall as never,
  }),

  def({
    name: 'list_provider_tools',
    description: 'Fetch a provider`s catalog from `<base>/.well-known/tools`.',
    schema: z.object({ url: z.string().url() }),
    handler: h.list_provider_tools as never,
  }),

  def({
    name: 'discover',
    description: 'Search the bazaar for paid services matching a query.',
    schema: z.object({
      query: z.string().min(1),
      chain: Chain.optional(),
      limit: PositiveInt.max(50).default(10),
    }),
    handler: h.discover as never,
  }),

  def({
    name: 'select_provider',
    description:
      'Pick the best provider from candidates using reputation-weighted routing (default: balanced).',
    schema: z.object({
      candidates: z.array(z.object({
        url: z.string().url(),
        reputation: z.number().min(0).max(100),
        price_micros: PriceMicros,
        latency_ms: z.number().nonnegative().optional(),
      })).min(1),
      strategy: z.enum(['cheapest', 'fastest', 'highest-reputation', 'balanced'])
        .default('balanced'),
    }),
    handler: h.select_provider as never,
  }),

  def({
    name: 'negotiate',
    description:
      'Recommend payment terms (direct / escrow / credit) given price and caller reputation.',
    schema: z.object({
      price_micros: PriceMicros,
      caller_reputation: z.number().min(0).max(100),
      credit_threshold: z.number().min(0).max(100).default(80),
      escrow_threshold_micros: PriceMicros.default(50_000),
    }),
    handler: h.negotiate as never,
  }),

  def({
    name: 'create_session',
    description:
      'Open a micropayment session: one on-chain tx covers many sub-cent calls until the budget runs out.',
    schema: z.object({
      provider: Address,
      chain: Chain,
      budget_micros: PriceMicros,
      ttl_minutes: PositiveInt.max(60 * 24).default(5),
    }),
    handler: h.create_session as never,
  }),

  def({
    name: 'create_escrow',
    description:
      'Lock funds in an ERC-8183 escrow for a high-value task. Funds release on evaluator approval.',
    schema: z.object({
      provider: Address,
      amount_micros: PriceMicros,
      chain: Chain,
      evaluator: z.union([Address, z.literal('self')]).default('self'),
      timeout_hours: PositiveInt.max(24 * 30).default(1),
    }),
    handler: h.create_escrow as never,
  }),

  def({
    name: 'delegate_budget',
    description:
      'Multi-agent budget chain: create a root, sub-delegate to a child agent, charge spending, query remaining.',
    schema: z.object({
      action: z.enum(['create', 'delegate', 'spend', 'status']),
      budget_micros: PriceMicros.optional(),
      amount_micros: PriceMicros.optional(),
      delegation_id: z.string().optional(),
      chain: Chain.optional(),
    }),
    handler: h.delegate_budget as never,
  }),

  def({
    name: 'generate_qr',
    description:
      'Build an ERC-681 USDC payment URI scannable by any wallet. Returns the URI plus an SVG.',
    schema: z.object({
      merchant: Address,
      amount_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/, 'use a decimal like "5.00"'),
      chain: Chain,
      label: z.string().optional(),
      memo: z.string().optional(),
    }),
    handler: h.generate_qr as never,
  }),

  def({
    name: 'off_ramp',
    description: 'Convert USDC to fiat via a registered off-ramp provider (MoonPay or Transak).',
    schema: z.object({
      amount_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
      chain: Chain,
      fiat_currency: z.string().length(3).default('USD'),
      destination_type: z.enum(['bank_account', 'card', 'mobile_money']),
      destination_id: z.string().min(1),
      provider: z.enum(['moonpay', 'transak']).default('moonpay'),
    }),
    handler: h.off_ramp as never,
  }),

  def({
    name: 'btc_lend',
    description:
      'Lock BTC as collateral and borrow USDC for agent payments on GOAT Network.',
    schema: z.object({
      action: z.enum(['borrow', 'repay', 'status']),
      btc_amount: z.string().optional(),
      usdc_amount: z.string().optional(),
      vault_address: Address.optional(),
      position_tx: z.string().optional(),
    }),
    handler: h.btc_lend as never,
  }),

  def({
    name: 'register_identity',
    description:
      'Register an agent identity on the GOAT ERC-8004 IdentityRegistry. Returns the tx hash and on-chain agentId.',
    schema: z.object({
      agent_uri: z.string().url(),
    }),
    handler: h.register_identity as never,
  }),

  def({
    name: 'get_reputation',
    description: 'Read the ERC-8004 reputation summary { count, sum } for an agentId.',
    schema: z.object({ agent_id: z.string().regex(/^\d+$/) }),
    handler: h.get_reputation as never,
  }),

  def({
    name: 'give_feedback',
    description: 'Submit ERC-8004 feedback (1-5) for an agent that served you.',
    schema: z.object({
      agent_id: z.string().regex(/^\d+$/),
      value: z.number().int().min(1).max(5),
      endpoint: z.string().url(),
    }),
    handler: h.give_feedback as never,
  }),

  def({
    name: 'batch_settle',
    description:
      'Aggregate many off-chain vouchers into a single on-chain settlement (n-payment v0.8 BatchSettlementManager). Action-based: open / voucher / settle / status.',
    schema: z.object({
      action: z.enum(['open', 'voucher', 'settle', 'status']),
      session_id: z.string().optional(),
      amount_micros: PriceMicros.optional(),
      budget_micros: PriceMicros.optional(),
      escrow_contract: Address.optional(),
      chain: Chain.optional(),
    }),
    handler: h.batch_settle as never,
  }),

  def({
    name: 'stream_pay',
    description:
      'Open or update a streaming payment that flows USDC per-second to a recipient (v0.8 StreamingPaymentManager).',
    schema: z.object({
      action: z.enum(['open', 'topup', 'close', 'status']),
      recipient: Address.optional(),
      rate_micros_per_sec: z.number().positive().optional(),
      duration_sec: PositiveInt.optional(),
      stream_id: z.string().optional(),
      chain: Chain.optional(),
    }),
    handler: h.stream_pay as never,
  }),

  def({
    name: 'ap2_mandate',
    description:
      'Sign or verify an AP2 verifiable intent / checkout mandate (n-payment v0.8 AP2Client).',
    schema: z.object({
      action: z.enum(['sign_intent', 'sign_checkout', 'verify']),
      mandate: z.unknown().describe('Mandate JSON; see AP2 spec'),
    }),
    handler: h.ap2_mandate as never,
  }),

  def({
    name: 'policy_check',
    description:
      'Evaluate a payment request against the configured PolicyEngine (allow / deny / require_review). Always run before mainnet sends.',
    schema: z.object({
      to: Address,
      amount_micros: PriceMicros,
      chain: Chain,
      reason: z.string().optional(),
    }),
    handler: h.policy_check as never,
  }),
];

// ─── Convenience indexes ─────────────────────────────────────────────────────
export const TOOL_BY_NAME: Readonly<Record<string, Tool>> = Object.freeze(
  Object.fromEntries(TOOLS.map((t) => [t.name, t])),
);

export const TOOL_NAMES: ReadonlyArray<string> = TOOLS.map((t) => t.name);

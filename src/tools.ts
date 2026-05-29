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
  'bnb-mainnet',
  'bnb-testnet',
  'xrpl-testnet',
  'xrpl-mainnet',
  'stellar-testnet',
  'stellar-mainnet',
  'solana-mainnet',
  'solana-devnet',
  'morph-mainnet',
  'morph-hoodi-testnet',
  'creditcoin-mainnet',
  'creditcoin-testnet',
  'flare-coston2',
  'flare-mainnet',
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
      proxy: z.enum(['spacerouter', 'auto', 'none']).optional()
        .describe('Route through SpaceRouter residential proxy (v0.11+)'),
      reference_key: z.string().max(32).optional()
        .describe('Morph Reference Key — merchant order ID linked on-chain'),
      region: z.string().regex(/^[A-Z]{2}$/).optional()
        .describe('ISO 3166-1 alpha-2 region for proxy routing'),
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
      'Build an ERC-681 (EVM) or SEP-7 (Stellar) USDC payment URI scannable by any wallet. Returns the URI.',
    schema: z.object({
      merchant: z
        .string()
        .regex(/^(0x[a-fA-F0-9]{40}|G[A-Z2-7]{55})$/, 'EVM 0x… or Stellar G… address'),
      amount_usdc: z.string().regex(/^\d+(\.\d{1,7})?$/, 'use a decimal like "5.00"'),
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

  def({
    name: 'morph_reference_key',
    description:
      'Attach or query a Morph Reference Key — a merchant-defined order ID linked on-chain. attach returns calldata bytes to embed in the next tx; query reads the linked tx record from the Morph Rails API.',
    schema: z.object({
      action: z.enum(['attach', 'query']),
      reference: z.string().min(1).max(32),
    }),
    handler: h.morph_reference_key as never,
  }),

  def({
    name: 'morph_altfee_pay',
    description:
      'STUB: Pay gas in USDC / USDT0 / BGB on Morph via AltFee (Type-0x7F transaction). Awaiting n-payment SDK upstream support.',
    schema: z.object({
      to: Address,
      amount_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
      gas_token: z.enum(['usdc', 'usdt0', 'bgb']).default('usdc'),
      chain: z.enum(['morph-mainnet', 'morph-hoodi-testnet']),
    }),
    handler: h.morph_altfee_pay as never,
  }),

  def({
    name: 'morph_passkey_pay',
    description:
      'STUB: Passwordless onchain payment on Morph using a registered Passkey (WebAuthn). Awaiting n-payment SDK upstream support.',
    schema: z.object({
      recipient: Address,
      amount_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
      passkey_credential_id: z.string().optional(),
      chain: z.enum(['morph-mainnet', 'morph-hoodi-testnet']),
    }),
    handler: h.morph_passkey_pay as never,
  }),

  // ─── XRPL (Ripple) tools ─────────────────────────────────────────────────
  def({
    name: 'xrpl_pay',
    description: 'Send RLUSD on XRPL to a destination address.',
    schema: z.object({
      destination: z.string().min(25),
      amount: z.string().regex(/^\d+(\.\d+)?$/),
      chain: z.enum(['xrpl-testnet', 'xrpl-mainnet']).default('xrpl-testnet'),
    }),
    handler: h.xrpl_pay as never,
  }),

  def({
    name: 'xrpl_balance',
    description: 'Check RLUSD balance on XRPL.',
    schema: z.object({
      address: z.string().min(25).optional(),
      chain: z.enum(['xrpl-testnet', 'xrpl-mainnet']).default('xrpl-testnet'),
    }),
    handler: h.xrpl_balance as never,
  }),

  def({
    name: 'xrpl_vault',
    description: 'Manage XRPL native vaults: create, deposit, withdraw, info, exchange-rate.',
    schema: z.object({
      action: z.enum(['create', 'deposit', 'withdraw', 'info', 'exchange-rate']),
      vault_id: z.string().optional(),
      amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      shares: z.string().optional(),
      chain: z.enum(['xrpl-testnet', 'xrpl-mainnet']).default('xrpl-testnet'),
    }),
    handler: h.xrpl_vault as never,
  }),

  def({
    name: 'xrpl_oracle',
    description: 'Get DIA oracle price feed on XRPL (RLUSD, XRP, BTC, ETH).',
    schema: z.object({
      asset: z.enum(['RLUSD', 'XRP', 'BTC', 'ETH']),
      chain: z.enum(['xrpl-testnet', 'xrpl-mainnet']).default('xrpl-testnet'),
    }),
    handler: h.xrpl_oracle as never,
  }),

  def({
    name: 'xrpl_trust_line',
    description: 'Ensure RLUSD trust line exists on the agent XRPL account.',
    schema: z.object({
      chain: z.enum(['xrpl-testnet', 'xrpl-mainnet']).default('xrpl-testnet'),
    }),
    handler: h.xrpl_trust_line as never,
  }),

  // ─── Circle Gateway nanopayments ───────────────────────────────────────────
  def({
    name: 'circle_nanopay',
    description: 'Pay a URL via Circle Gateway gas-free nanopayments (EIP-3009). Requires CIRCLE_API_KEY env.',
    schema: z.object({
      url: z.string().url(),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
      body: z.string().optional(),
      chain: Chain.optional(),
    }),
    handler: h.circle_nanopay as never,
  }),

  // ─── Stellar Trustless Work escrow ─────────────────────────────────────────
  def({
    name: 'stellar_escrow',
    description: 'Manage milestone-based escrow on Stellar via Trustless Work: create, fund, submit-milestone, approve, release, dispute, status.',
    schema: z.object({
      action: z.enum(['create', 'fund', 'submit-milestone', 'approve', 'release', 'dispute', 'status']),
      job_id: z.string().optional(),
      milestone_index: z.number().int().nonnegative().optional(),
      provider: z.string().optional(),
      amount: z.string().optional(),
      title: z.string().optional(),
      milestones: z.array(z.object({ description: z.string() })).optional(),
      chain: z.enum(['stellar-testnet', 'stellar-mainnet']).default('stellar-testnet'),
    }),
    handler: h.stellar_escrow as never,
  }),

  // ─── Agent Card (A2A) ──────────────────────────────────────────────────────
  def({
    name: 'agent_card',
    description: 'Generate or read an A2A Agent Card (/.well-known/agent.json).',
    schema: z.object({
      action: z.enum(['generate', 'read']),
      url: z.string().url().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      pay_to: Address.optional(),
      chain: Chain.optional(),
      skills: z.array(z.object({ name: z.string(), description: z.string(), price: z.number() })).optional(),
    }),
    handler: h.agent_card as never,
  }),

  // ─── Permit2 gasless approval ──────────────────────────────────────────────
  def({
    name: 'permit2_approve',
    description: 'Sign an off-chain Permit2 (EIP-712) approval for gasless token spending.',
    schema: z.object({
      token: Address,
      amount: z.string().regex(/^\d+$/),
      spender: Address,
      chain: Chain,
      deadline: z.number().int().optional(),
    }),
    handler: h.permit2_approve as never,
  }),

  // ─── Direct ERC-20 transfer ────────────────────────────────────────────────
  def({
    name: 'direct_transfer',
    description: 'Send ERC-20 tokens directly (no 402 flow). Mainnet guard applies.',
    schema: z.object({
      to: Address,
      token_address: Address,
      amount: z.string().regex(/^\d+$/),
      chain: Chain,
    }),
    handler: h.direct_transfer as never,
  }),

  // ─── Aave V3 yield (Base Sepolia, USDC) ────────────────────────────────────
  def({
    name: 'aave_yield',
    description:
      'Earn yield on USDC via Aave V3 on Base Sepolia. action=demo runs the one-prompt happy path (gas guard → auto-faucet → approve → supply 1 USDC → return aUSDC). supply/withdraw take amount_usdc; position reads aUSDC + USDC balances. Override AAVE_POOL_ADDRESS to use a different V3 Pool. Hybrid path: n-payment v0.13 → @aave/client → viem-direct.',
    schema: z.object({
      action: z.enum(['demo', 'supply', 'withdraw', 'position']),
      amount_usdc: z
        .string()
        .regex(/^\d+(\.\d{1,6})?$/, 'use a decimal like "1.0"')
        .optional()
        .describe('USDC amount. Required for supply/withdraw. Default for demo: "1".'),
      chain: z.enum(['base-sepolia']).default('base-sepolia'),
      auto_faucet: z
        .boolean()
        .default(true)
        .describe('demo only: auto-call the Circle faucet when balance < demo amount.'),
    }),
    handler: h.aave_yield as never,
  }),

  // ─── SpaceRouter (SpaceCoin) — residential proxy + on-chain SPACE escrow ─
  def({
    name: 'spacerouter_pay',
    description:
      'Send a paid HTTP request through the SpaceRouter residential-proxy network. Pays in SPACE on Creditcoin via the dedicated wallet at ~/.n-payment/wallets/spacerouter.json. Region/IP-type optional. Returns body + node_id + country.',
    schema: z.object({
      url: z.string().url(),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
      body: z.string().optional(),
      region: z
        .string()
        .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 country code, e.g. US, KR')
        .optional(),
      ip_type: z
        .enum(['residential', 'mobile', 'business', 'hosting'])
        .optional(),
      max_rate_space_per_gb: z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'decimal SPACE amount')
        .optional(),
      auto_settle: z.boolean().default(true),
      dry_run: z.boolean().default(false),
    }),
    handler: h.spacerouter_pay as never,
  }),

  def({
    name: 'spacerouter_escrow',
    description:
      'Manage the on-chain SPACE escrow at TokenPaymentEscrow on Creditcoin: deposit | balance | initiate-withdrawal | execute-withdrawal (after 5-day timelock) | cancel-withdrawal | status.',
    schema: z.object({
      action: z.enum([
        'deposit',
        'balance',
        'initiate-withdrawal',
        'execute-withdrawal',
        'cancel-withdrawal',
        'status',
      ]),
      amount_space: z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'decimal SPACE amount, e.g. "10" or "0.5"')
        .optional(),
      address: Address.optional(),
      dry_run: z.boolean().default(false),
    }),
    handler: h.spacerouter_escrow as never,
  }),

  def({
    name: 'spacerouter_sync_receipts',
    description:
      'Push pending Leg-1 (Consumer→Gateway) receipts on-chain so they settle into the SpaceRouter escrow. Returns accepted/rejected UUID arrays + pending count.',
    schema: z.object({
      dry_run: z.boolean().default(false),
    }),
    handler: h.spacerouter_sync_receipts as never,
  }),

  def({
    name: 'spacerouter_admin',
    description:
      'Manage SpaceRouter API keys via a SpaceRouter coordination/admin API instance. Advanced — set SR_ADMIN_URL to point at your admin endpoint. Actions: create | list | revoke.',
    schema: z.object({
      action: z.enum(['create', 'list', 'revoke']),
      name: z.string().min(1).optional(),
      api_key_id: z.string().optional(),
      rate_limit_rpm: z.number().int().positive().optional(),
    }),
    handler: h.spacerouter_admin as never,
  }),

  // ─── GOAT USDC Acquisition Router (n-payment v0.17) ─────────────────────
  def({
    name: 'goat_swap_to_usdc',
    description:
      'Swap BTC (native gas on GOAT) to USDC on GOAT Network via the n-payment v0.17 USDC Acquisition Router using the swap-only path (PegBTC→USDC on OKU/Uniswap V3). Provide exactly one of amount_usdc or amount_btc. dry_run=true returns the OKU quote without spending. Default chain: goat-testnet; goat-mainnet is gated by testnetMode. No GOAT facilitator creds required (on-chain only).',
    schema: z.object({
      amount_usdc: z
        .string()
        .regex(/^\d+(\.\d{1,6})?$/, 'use a decimal like "1.0"')
        .optional(),
      amount_btc: z
        .string()
        .regex(/^\d+(\.\d{1,8})?$/, 'use a decimal with up to 8 sat-precision digits')
        .optional(),
      max_slippage_bps: z.number().int().min(1).max(1000).default(50),
      chain: z.enum(['goat-testnet', 'goat-mainnet']).default('goat-testnet'),
      dry_run: z.boolean().default(false),
      idempotency_key: z.string().min(1).max(64).optional()
        .describe('Optional caller-supplied id for SDK replay-safety. Defaults to a fresh random key per call.'),
    }).refine((v) => Boolean(v.amount_usdc) !== Boolean(v.amount_btc), {
      message: 'Provide exactly one of amount_usdc or amount_btc.',
    }),
    handler: h.goat_swap_to_usdc as never,
  }),

  // ─── Flare FAssets — XRP → FXRP bridge via Smart Accounts ────────────────
  def({
    name: 'xrpl_to_fxrp_bridge',
    description:
      'Bridge XRP from XRPL into FXRP on Flare Coston2 via Flare Smart Accounts (proof-based mint). Auto-discovers the operator XRPL address and the first agent vault on-chain, encodes the FXRP collateralReservation reference, submits one XRPL Payment, then polls the user\'s PersonalAccount FXRP balance. Default: 10 XRP / 1 lot. Sync: blocks up to 180s. Requires XRPL_SEED env var (testnet seed).',
    schema: z.object({
      amount_xrp: z
        .string()
        .regex(/^\d+(\.\d{1,6})?$/, 'decimal XRP, e.g. "10" or "1.5"')
        .default('10'),
      lots: z.number().int().positive().max(10_000).default(1),
      agent_vault_id: z.string().regex(/^\d+$/).optional()
        .describe('FAssets agent vault id; default = first registered'),
      operator_xrpl: z.string().min(25).optional()
        .describe('Operator XRPL address; default = first registered with MasterAccountController'),
      wait: z.boolean().default(true),
      poll_interval_ms: z.number().int().min(1000).max(30_000).default(5000),
      timeout_ms: z.number().int().min(10_000).max(600_000).default(180_000),
      chain: z.enum(['flare-coston2', 'flare-mainnet']).default('flare-coston2'),
    }),
    handler: h.xrpl_to_fxrp_bridge as never,
  }),
];

// ─── Convenience indexes ─────────────────────────────────────────────────────
export const TOOL_BY_NAME: Readonly<Record<string, Tool>> = Object.freeze(
  Object.fromEntries(TOOLS.map((t) => [t.name, t])),
);

export const TOOL_NAMES: ReadonlyArray<string> = TOOLS.map((t) => t.name);

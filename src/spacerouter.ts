// SpaceRouter (Spacecoin) adapter: dedicated wallet, escrow ABI, gateway client.
//
// Mirrors src/morph.ts and src/stellar.ts. All SpaceRouter-specific knowledge
// lives in this module so the rest of the skill stays chain-agnostic. Pure
// helpers are exported for direct testing; stateful logic is encapsulated in
// SpaceRouterClient. The @spacenetwork/spacerouter SDK is loaded lazily (peer
// dep) so install never fails when the SDK isn't on the registry.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// ─── Public constants ────────────────────────────────────────────────────────
export const SR_GATEWAY_URL = 'https://gateway.spacerouter.org';
export const SR_GATEWAY_MGMT_URL = 'https://gateway.spacerouter.org:8081';
export const CREDITCOIN_CHAIN_ID = 102030;
export const CREDITCOIN_RPC_URL = 'https://mainnet3.creditcoin.network';
export const SPACE_TOKEN_ADDRESS: Address =
  '0x7ab7C6A935Ab2D1437398790C9C0660af62A80b9';
export const TOKEN_PAYMENT_ESCROW_ADDRESS: Address =
  '0xC130F5D76f0b4Ce8FE2ceA0D2C2b8f53A39a5cd0';
export const STAKING_V2_ADDRESS: Address =
  '0x5d07fEd750F77C2DB8e7D1c031c05E3A5d2bc9fA';
export const WITHDRAWAL_TIMELOCK_SECONDS = 5 * 24 * 3600;
export const SPACE_DECIMALS = 18;

/** Dedicated wallet filename, scoped to ~/.n-payment/wallets/. */
export const SR_WALLET_NAME = 'spacerouter';

// ─── Minimal escrow + ERC-20 ABI ─────────────────────────────────────────────
// Names and signatures match the public TokenPaymentEscrow surface documented
// in the SpaceRouter Pay-with-SPACE v1.5 guide. Bump on contract redeploy.
export const TOKEN_PAYMENT_ESCROW_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'initiateWithdrawal',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'executeWithdrawal',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'cancelWithdrawal',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'pendingWithdrawal',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'unlockAt', type: 'uint64' },
    ],
  },
] as const;

export const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ─── Errors ──────────────────────────────────────────────────────────────────
export type SpaceRouterErrorCode =
  | 'SPACEROUTER_GATEWAY_UNREACHABLE'
  | 'SPACEROUTER_AUTH_FAILED'
  | 'SPACEROUTER_NO_NODES'
  | 'SPACEROUTER_PAYMENT_REQUIRED'
  | 'SPACEROUTER_RECEIPT_REJECTED'
  | 'SPACEROUTER_TIMELOCK_NOT_EXPIRED'
  | 'SPACEROUTER_WALLET_MISSING_FUNDS'
  | 'SPACEROUTER_SDK_MISSING'
  | 'SPACEROUTER_ADMIN_URL_MISSING';

export class SpaceRouterError extends Error {
  readonly code: SpaceRouterErrorCode;
  readonly hint?: string;
  constructor(message: string, code: SpaceRouterErrorCode, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

// ─── Decimal helpers (SPACE = 18 decimals) ──────────────────────────────────
export const parseSpaceWei = (amount: string): bigint =>
  parseUnits(amount, SPACE_DECIMALS);
export const formatSpaceWei = (wei: bigint): string =>
  formatUnits(wei, SPACE_DECIMALS);

// ─── Dedicated wallet (auto-create on first call) ────────────────────────────
export interface SpaceRouterWallet {
  address: Address;
  privateKey: Hex;
}

const walletDir = (home: string): string => join(home, '.n-payment', 'wallets');
const walletFile = (home: string): string =>
  join(walletDir(home), `${SR_WALLET_NAME}.json`);

/**
 * Load (or auto-create) the dedicated SpaceRouter wallet at
 * ~/.n-payment/wallets/spacerouter.json (chmod 0600). Idempotent.
 */
export async function getSpaceRouterWallet(
  home: string = homedir(),
): Promise<SpaceRouterWallet> {
  const f = walletFile(home);
  if (existsSync(f)) {
    const r = JSON.parse(await readFile(f, 'utf8')) as {
      address: Address;
      privateKey: Hex;
    };
    return { address: r.address, privateKey: r.privateKey };
  }
  await mkdir(walletDir(home), { recursive: true, mode: 0o700 });
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const record = {
    name: SR_WALLET_NAME,
    address: account.address,
    privateKey,
    createdAt: new Date().toISOString(),
  };
  await writeFile(f, JSON.stringify(record, null, 2), { mode: 0o600 });
  await chmod(f, 0o600);
  return { address: account.address, privateKey };
}

// ─── Config picker ───────────────────────────────────────────────────────────
export interface SpaceRouterConfig {
  gatewayUrl: string;
  gatewayMgmtUrl: string;
  escrowAddress: Address;
  escrowPrivateKey: Hex;
  rpcUrl: string;
  region?: string;
  ipType?: 'residential' | 'mobile' | 'business' | 'hosting';
  adminUrl?: string;
  dryRun: boolean;
}

/**
 * Pick a SpaceRouter config from env vars (preferred) with fallback to defaults
 * + the dedicated wallet's private key. Pure function — no I/O.
 */
export function pickSpaceRouterConfig(
  env: NodeJS.ProcessEnv,
  walletPrivateKey: Hex,
  opts: {
    region?: string;
    ipType?: 'residential' | 'mobile' | 'business' | 'hosting';
    dryRun?: boolean;
  } = {},
): SpaceRouterConfig {
  return {
    gatewayUrl: env.SR_GATEWAY_URL ?? SR_GATEWAY_URL,
    gatewayMgmtUrl: env.SR_GATEWAY_MANAGEMENT_URL ?? SR_GATEWAY_MGMT_URL,
    escrowAddress:
      (env.SR_ESCROW_CONTRACT_ADDRESS as Address | undefined) ??
      TOKEN_PAYMENT_ESCROW_ADDRESS,
    escrowPrivateKey:
      (env.SR_ESCROW_PRIVATE_KEY as Hex | undefined) ?? walletPrivateKey,
    rpcUrl: env.SR_ESCROW_CHAIN_RPC ?? CREDITCOIN_RPC_URL,
    region: opts.region ?? env.SR_REGION,
    ipType:
      opts.ipType ??
      (env.SR_IP_TYPE as SpaceRouterConfig['ipType'] | undefined),
    adminUrl: env.SR_ADMIN_URL,
    dryRun: !!opts.dryRun,
  };
}

// ─── Lazy SDK loader ─────────────────────────────────────────────────────────
type SrSdk = {
  SpaceRouter?: new (apiKey: string, opts?: unknown) => unknown;
  SpaceRouterAdmin?: new (url: string) => unknown;
};
type SrPaymentSdk = {
  SpaceRouterSPACE?: new (opts: unknown) => unknown;
};

async function loadSdk(): Promise<{ core: SrSdk; payment: SrPaymentSdk }> {
  try {
    // @ts-expect-error optional peer dep — types only present when installed
    const core = (await import('@spacenetwork/spacerouter')) as SrSdk;
    const payment = (await import(
      // @ts-expect-error optional peer dep — types only present when installed
      '@spacenetwork/spacerouter/payment'
    )) as SrPaymentSdk;
    return { core, payment };
  } catch {
    throw new SpaceRouterError(
      '@spacenetwork/spacerouter SDK is not installed.',
      'SPACEROUTER_SDK_MISSING',
      'Run `npm i @spacenetwork/spacerouter`. The skill marks it optional so install never fails.',
    );
  }
}

// ─── Viem client builder (used for on-chain reads + writes) ──────────────────
function creditcoinChain() {
  return defineChain({
    id: CREDITCOIN_CHAIN_ID,
    name: 'Creditcoin',
    nativeCurrency: { name: 'Creditcoin', symbol: 'CTC', decimals: 18 },
    rpcUrls: { default: { http: [CREDITCOIN_RPC_URL] } },
  });
}

// ─── Client ──────────────────────────────────────────────────────────────────
export interface SpaceRouterPayResult {
  status: number;
  body: string;
  request_id?: string;
  node_id?: string;
  country?: string;
  ip_type?: string;
}

export interface SpaceRouterTx {
  txHash: string;
  amountWei?: string;
}

export interface SpaceRouterEscrowStatus {
  deposited_wei: string;
  pending_wei: string;
  unlock_at_iso: string | null;
}

/**
 * Thin wrapper over @spacenetwork/spacerouter + on-chain TokenPaymentEscrow.
 *
 * Two responsibilities only:
 *   1. Sign + relay paid HTTP requests through the SpaceRouter gateway.
 *   2. Manage the on-chain SPACE escrow lifecycle (deposit/withdraw/balance).
 *
 * Dry-run mode short-circuits every chain or gateway call so reviewers can
 * walk through the agent flow without holding SPACE/CTC. All synthetic tx
 * hashes are prefixed `0xdry…` so they're impossible to confuse with real
 * Creditcoin tx hashes.
 */
export class SpaceRouterClient {
  readonly #cfg: SpaceRouterConfig;
  readonly #env: NodeJS.ProcessEnv;

  constructor(cfg: SpaceRouterConfig, env: NodeJS.ProcessEnv = process.env) {
    this.#cfg = cfg;
    this.#env = env;
  }

  // ── Read helpers (no signing) ────────────────────────────────────────────
  async getEscrowBalance(address: Address): Promise<bigint> {
    if (this.#cfg.dryRun) return 0n;
    const pub = createPublicClient({
      chain: creditcoinChain(),
      transport: http(this.#cfg.rpcUrl),
    });
    return (await pub.readContract({
      address: this.#cfg.escrowAddress,
      abi: TOKEN_PAYMENT_ESCROW_ABI,
      functionName: 'balanceOf',
      args: [address],
    })) as bigint;
  }

  async getStatus(address: Address): Promise<SpaceRouterEscrowStatus> {
    if (this.#cfg.dryRun) {
      return { deposited_wei: '0', pending_wei: '0', unlock_at_iso: null };
    }
    const pub = createPublicClient({
      chain: creditcoinChain(),
      transport: http(this.#cfg.rpcUrl),
    });
    const [deposited, pending] = await Promise.all([
      pub.readContract({
        address: this.#cfg.escrowAddress,
        abi: TOKEN_PAYMENT_ESCROW_ABI,
        functionName: 'balanceOf',
        args: [address],
      }) as Promise<bigint>,
      pub.readContract({
        address: this.#cfg.escrowAddress,
        abi: TOKEN_PAYMENT_ESCROW_ABI,
        functionName: 'pendingWithdrawal',
        args: [address],
      }) as Promise<readonly [bigint, bigint]>,
    ]);
    const [pendingAmount, unlockAt] = pending;
    return {
      deposited_wei: deposited.toString(),
      pending_wei: pendingAmount.toString(),
      unlock_at_iso:
        pendingAmount > 0n
          ? new Date(Number(unlockAt) * 1000).toISOString()
          : null,
    };
  }

  // ── Write helpers (signed via wallet client) ─────────────────────────────
  async depositToEscrow(amountWei: bigint): Promise<SpaceRouterTx> {
    if (this.#cfg.dryRun) return this.#dryTx(amountWei);
    const wc = this.#walletClient();
    // ERC-20 approve then escrow.deposit. Allowance check skipped for
    // simplicity — re-approving idempotently is cheaper than a read round-trip.
    await wc.writeContract({
      address: SPACE_TOKEN_ADDRESS,
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [this.#cfg.escrowAddress, amountWei],
    });
    const txHash = await wc.writeContract({
      address: this.#cfg.escrowAddress,
      abi: TOKEN_PAYMENT_ESCROW_ABI,
      functionName: 'deposit',
      args: [amountWei],
    });
    return { txHash, amountWei: amountWei.toString() };
  }

  async initiateWithdrawal(amountWei: bigint): Promise<SpaceRouterTx> {
    if (this.#cfg.dryRun) return this.#dryTx(amountWei);
    const txHash = await this.#walletClient().writeContract({
      address: this.#cfg.escrowAddress,
      abi: TOKEN_PAYMENT_ESCROW_ABI,
      functionName: 'initiateWithdrawal',
      args: [amountWei],
    });
    return { txHash, amountWei: amountWei.toString() };
  }

  async executeWithdrawal(): Promise<SpaceRouterTx> {
    if (this.#cfg.dryRun) return this.#dryTx();
    const txHash = await this.#walletClient().writeContract({
      address: this.#cfg.escrowAddress,
      abi: TOKEN_PAYMENT_ESCROW_ABI,
      functionName: 'executeWithdrawal',
      args: [],
    });
    return { txHash };
  }

  async cancelWithdrawal(): Promise<SpaceRouterTx> {
    if (this.#cfg.dryRun) return this.#dryTx();
    const txHash = await this.#walletClient().writeContract({
      address: this.#cfg.escrowAddress,
      abi: TOKEN_PAYMENT_ESCROW_ABI,
      functionName: 'cancelWithdrawal',
      args: [],
    });
    return { txHash };
  }

  // ── Gateway request (proxy + receipt) ────────────────────────────────────
  async pay(
    url: string,
    init: RequestInit | undefined,
    opts: {
      maxRateSpacePerGb?: bigint;
      autoSettle?: boolean;
      apiKey?: string;
    } = {},
  ): Promise<SpaceRouterPayResult> {
    if (this.#cfg.dryRun) {
      const res = await fetch(url, {
        ...init,
        headers: { ...init?.headers, 'X-Dry-Run': '1' },
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text.slice(0, 4000),
        node_id: 'dry-node',
        country: this.#cfg.region,
        ip_type: this.#cfg.ipType,
      };
    }
    const { core, payment } = await loadSdk();
    if (!core.SpaceRouter || !payment.SpaceRouterSPACE) {
      throw new SpaceRouterError(
        '@spacenetwork/spacerouter is missing required exports.',
        'SPACEROUTER_SDK_MISSING',
      );
    }
    const consumer = new payment.SpaceRouterSPACE({
      gatewayMgmtUrl: this.#cfg.gatewayMgmtUrl,
      privateKey: this.#cfg.escrowPrivateKey,
      escrowContract: this.#cfg.escrowAddress,
      escrowChainRpc: this.#cfg.rpcUrl,
      maxRatePerGb: opts.maxRateSpacePerGb,
    } as never);
    const client = new core.SpaceRouter(opts.apiKey ?? 'sr_skill_local', {
      gatewayUrl: this.#cfg.gatewayUrl,
      payment: consumer,
      autoSettle: opts.autoSettle ?? true,
      region: this.#cfg.region,
      ipType: this.#cfg.ipType,
    } as never);
    const c = client as {
      request: (
        method: string,
        url: string,
        init?: RequestInit,
      ) => Promise<{
        status: number;
        body: string;
        text?: () => Promise<string>;
        nodeId?: string;
        requestId?: string;
        country?: string;
        ipType?: string;
      }>;
    };
    const method = (init?.method ?? 'GET').toUpperCase();
    const r = await c.request(method, url, init);
    const body =
      typeof r.body === 'string'
        ? r.body
        : r.text
        ? await r.text()
        : '';
    return {
      status: r.status,
      body: body.slice(0, 4000),
      request_id: r.requestId,
      node_id: r.nodeId,
      country: r.country,
      ip_type: r.ipType,
    };
  }

  async syncReceipts(): Promise<{
    accepted: string[];
    rejected: string[];
    pending_count: number;
  }> {
    if (this.#cfg.dryRun)
      return { accepted: [], rejected: [], pending_count: 0 };
    const { payment } = await loadSdk();
    if (!payment.SpaceRouterSPACE) {
      throw new SpaceRouterError(
        '@spacenetwork/spacerouter/payment missing SpaceRouterSPACE.',
        'SPACEROUTER_SDK_MISSING',
      );
    }
    const consumer = new payment.SpaceRouterSPACE({
      gatewayMgmtUrl: this.#cfg.gatewayMgmtUrl,
      privateKey: this.#cfg.escrowPrivateKey,
      escrowContract: this.#cfg.escrowAddress,
      escrowChainRpc: this.#cfg.rpcUrl,
    } as never);
    const r = (await (consumer as { syncReceipts: () => Promise<unknown> })
      .syncReceipts()) as {
      accepted?: string[];
      rejected?: string[];
      pending_count?: number;
    };
    return {
      accepted: r.accepted ?? [],
      rejected: r.rejected ?? [],
      pending_count: r.pending_count ?? 0,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────
  #walletClient() {
    const account = privateKeyToAccount(this.#cfg.escrowPrivateKey);
    return createWalletClient({
      account,
      chain: creditcoinChain(),
      transport: http(this.#cfg.rpcUrl),
    });
  }

  #dryTx(amountWei?: bigint): SpaceRouterTx {
    return {
      txHash: `0xdry${Date.now().toString(16).padStart(60, '0')}`,
      ...(amountWei !== undefined ? { amountWei: amountWei.toString() } : {}),
    };
  }

  // Hint for unused-warning silencers when env is queried indirectly.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _env = (): NodeJS.ProcessEnv => this.#env;
}

// ─── Admin helper (lazy) ─────────────────────────────────────────────────────
export async function createSpaceRouterAdmin(
  url: string,
): Promise<{
  createApiKey: (name: string, opts?: unknown) => Promise<unknown>;
  listApiKeys: () => Promise<unknown[]>;
  revokeApiKey: (id: string) => Promise<unknown>;
}> {
  const { core } = await loadSdk();
  if (!core.SpaceRouterAdmin) {
    throw new SpaceRouterError(
      '@spacenetwork/spacerouter is missing SpaceRouterAdmin.',
      'SPACEROUTER_SDK_MISSING',
    );
  }
  return new core.SpaceRouterAdmin(url) as never;
}

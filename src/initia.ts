// Initia / iUSD helpers (n-payment v0.23) — SRP module.
//
// Encapsulates everything the iusd_bridge tool and the initia-aware branches
// of pay / check_balance need:
//
//   • buildInitiaConfig         — resolve env (mnemonic + denom) → cfg | err
//   • createInitiaPaymentClient — wires PaymentClient + IusdBridgeOrchestrator
//   • initiaErrorOf             — map SDK / peer-dep errors → ToolResult.fail()
//   • readIusdCaps              — conservative env-driven per-tx / per-day caps
//
// SOLID:
//   • SRP — Initia signer/bridge wiring is in this file only. handlers.ts stays
//     declarative; tools.ts stays a registry.
//   • DIP — handlers depend on the shapes returned here, not on n-payment types.
//   • OCP — extend by composition (additional sourceChain in priority order;
//     swap SkipApiClient for a wrapper at the call-site).
//
// Peer deps are soft-loaded:
//   • `n-payment`              — required at first call (already-installed).
//   • `@cosmjs/proto-signing`  — required for any Initia signer build.
//   • `@cosmjs/stargate`       — required for tx broadcast (loaded inside SDK).
//   • `@skip-go/client`        — required only for `executeRoute`. Quote works
//                                without it.

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_META } from './faucet.js';
import type { ChainKey, ToolContext, ToolResult } from './tools.js';

// ─── Public types ──────────────────────────────────────────────────────────
export type InitiaChain = 'initia-testnet' | 'initia-mainnet';

export interface InitiaConfig {
  /** SDK accepts 'testnet' | 'mainnet'. Derived from chain key. */
  network: 'testnet' | 'mainnet';
  mnemonic: string;
  /** iUSD denom, env-resolved (placeholder warning surfaced by SDK). */
  iusdDenom: string;
}

export interface InitiaCaps {
  /** Per-call ceiling, decimal USD string. Default 50. */
  perTransfer: string;
  /** Per-day ceiling, decimal USD string. Default 200. */
  perDay: string;
}

// ─── Internals ─────────────────────────────────────────────────────────────
type NP = typeof import('n-payment');
let _np: NP | null = null;
async function np(): Promise<NP> {
  if (_np) return _np;
  try {
    _np = (await import('n-payment')) as NP;
    return _np;
  } catch {
    throw asCoded(
      'n-payment SDK is not installed. Run `npm i n-payment@^0.23.0`.',
      'NPAYMENT_SDK_MISSING',
    );
  }
}

const asCoded = (msg: string, code: string, hint?: string): Error & {
  code: string;
  hint?: string;
} => Object.assign(new Error(msg), { code, hint });

const isInitiaChain = (c: string): c is InitiaChain =>
  c === 'initia-testnet' || c === 'initia-mainnet';

const networkFromChain = (c: InitiaChain): 'testnet' | 'mainnet' =>
  c === 'initia-testnet' ? 'testnet' : 'mainnet';

const denomEnvKey = (c: InitiaChain): string =>
  c === 'initia-testnet' ? 'INITIA_IUSD_DENOM_TESTNET' : 'INITIA_IUSD_DENOM_MAINNET';

const defaultSourceForDest = (c: InitiaChain): ChainKey =>
  c === 'initia-testnet' ? 'base-sepolia' : 'base-mainnet';

// ─── buildInitiaConfig ─────────────────────────────────────────────────────
/**
 * Resolve env → InitiaConfig or a structured ToolResult failure. Pure: no I/O.
 * `requireMnemonic=false` lets read-only paths (foreign-address balance) skip
 * the signer requirement.
 */
export function buildInitiaConfig(
  env: NodeJS.ProcessEnv,
  chain: InitiaChain,
  opts: { requireMnemonic?: boolean } = {},
): { ok: true; cfg: InitiaConfig } | { ok: false; err: ToolResult } {
  const mnemonic = (env.INITIA_MNEMONIC ?? '').trim();
  const requireMnemonic = opts.requireMnemonic ?? true;
  if (requireMnemonic && !mnemonic) {
    return {
      ok: false,
      err: {
        ok: false,
        error: 'INITIA_MNEMONIC env var is required for Initia signing.',
        code: 'INITIA_MNEMONIC_MISSING',
        hint: 'export INITIA_MNEMONIC="word1 word2 … word12" (BIP-39).',
      },
    };
  }
  const denomKey = denomEnvKey(chain);
  const iusdDenom = (env[denomKey] ?? '').trim();
  if (!iusdDenom) {
    return {
      ok: false,
      err: {
        ok: false,
        error: `${denomKey} env var is required to resolve the iUSD denom on ${chain}.`,
        code: 'INITIA_IUSD_DENOM_MISSING',
        hint: `export ${denomKey}="ibc/…"   See n-payment INITIA_ASSETS registry.`,
      },
    };
  }
  return {
    ok: true,
    cfg: { network: networkFromChain(chain), mnemonic, iusdDenom },
  };
}

// ─── readIusdCaps ──────────────────────────────────────────────────────────
export const readIusdCaps = (env: NodeJS.ProcessEnv): InitiaCaps => ({
  perTransfer: env.IUSD_MAX_PER_TRANSFER ?? '50',
  perDay: env.IUSD_MAX_PER_DAY ?? '200',
});

// ─── initiaErrorOf ─────────────────────────────────────────────────────────
/**
 * Normalize SDK / peer-dep errors into a ToolResult.fail() shape with a
 * stable code + actionable hint. Preserves unknown errors verbatim.
 */
export function initiaErrorOf(e: unknown): ToolResult {
  const err = e as Error & { code?: string; hint?: string };
  const code = err.code;
  const map: Record<string, { hint: string }> = {
    INITIA_PEER_DEP_MISSING: {
      hint: 'npm i @cosmjs/stargate @cosmjs/proto-signing',
    },
    SKIP_PEER_DEP_MISSING: {
      hint: 'npm i @skip-go/client (route quoting works without it).',
    },
    LAYERZERO_AUSD_TESTNET_UNAVAILABLE: {
      hint: 'AUSD-OFT is mainnet-only today. Use Skip API on testnet.',
    },
    INITIA_BROADCAST_FAILED: {
      hint: 'Inspect rawLog in error payload; ensure the account holds uinit for gas.',
    },
  };
  return {
    ok: false,
    error: err.message ?? String(e),
    code,
    hint: err.hint ?? (code ? map[code]?.hint : undefined),
  };
}

// ─── EVM source helpers ────────────────────────────────────────────────────
const viemChainOf = (chain: ChainKey) => {
  const m = CHAIN_META[chain];
  return defineChain({
    id: m.chainId || 1,
    name: m.name,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [m.rpcUrl] } },
  });
};

async function readUsdcBalanceWei(
  chain: ChainKey,
  owner: Address,
): Promise<bigint> {
  const meta = CHAIN_META[chain];
  if (!meta.usdc) return 0n;
  const pub = createPublicClient({
    chain: viemChainOf(chain),
    transport: http(meta.rpcUrl),
  });
  return (await pub.readContract({
    address: meta.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint;
}

// ─── createInitiaPaymentClient (factory) ──────────────────────────────────
/**
 * Wire a `PaymentClient` configured for `sourceChain → destChain` and an
 * `IusdBridgeOrchestrator` whose `ensureIusd` is bound to the SDK adapter.
 *
 * Caller decides whether to call `client.fetchWithPayment(url)` (402 flow)
 * or `orchestrator.ensureIusd({...})` (explicit bridge). The factory does
 * not read holdings or initiate any tx.
 *
 * Throws an `Error & { code }` that callers map via {@link initiaErrorOf}.
 */
export async function createInitiaPaymentClient(args: {
  ctx: ToolContext;
  destChain: InitiaChain;
  sourceChain?: ChainKey;
}): Promise<{
  client: any;
  orchestrator: any;
  initia: any;
  sourceChain: ChainKey;
}> {
  const { ctx, destChain } = args;
  const sourceChain = args.sourceChain ?? defaultSourceForDest(destChain);

  const built = buildInitiaConfig(ctx.env, destChain);
  if (!built.ok) {
    const e = built.err as { error: string; code?: string };
    throw asCoded(e.error, e.code ?? 'INITIA_CONFIG');
  }

  const sdk: any = await np();
  const w = await loadWalletRecord(ctx);

  // 1. PaymentClient — soft-constructs InitiaClient + InitiaIusdAdapter
  //    when an initia-* chain is in `chains`.
  const client = sdk.createPaymentClient({
    chains: [sourceChain, destChain],
    ows: { wallet: w.name, privateKey: w.privateKey },
    initia: { network: built.cfg.network, mnemonic: built.cfg.mnemonic },
  });

  const initia = client.initiaClient;
  const initiaAdapter = client.initiaAdapter;
  if (!initia || !initiaAdapter) {
    throw asCoded(
      'PaymentClient did not construct InitiaClient — check n-payment >= 0.23.0.',
      'INITIA_CLIENT_UNAVAILABLE',
    );
  }

  // 2. Orchestrator — Skip API primary; SDK falls back to Wormhole NTT
  //    transparently on mainnet when configured. LayerZero AUSD throws on
  //    testnet (corridor selector routes around it).
  const skip = new sdk.SkipApiClient();

  const ownerAddress = w.address;
  const evmAccount = privateKeyToAccount(w.privateKey);
  const evmWalletClient = createWalletClient({
    account: evmAccount,
    chain: viemChainOf(sourceChain),
    transport: http(CHAIN_META[sourceChain].rpcUrl),
  });
  const evmChainId = String(CHAIN_META[sourceChain].chainId || 1);
  const initiaAddress: string = await initia.getAddress();

  const orchestrator = new sdk.IusdBridgeOrchestrator({
    initia,
    skip,
    getHoldings: async () => ({
      iusd: { [destChain]: await initia.getIusdBalance() },
      usdc: { [sourceChain]: await readUsdcBalanceWei(sourceChain, ownerAddress) },
    }),
    skipSigners: {
      cosmos: async () => initia,
      evm: async () => evmWalletClient,
      addresses: [
        { chainId: evmChainId, address: ownerAddress },
        { chainId: destChain === 'initia-testnet' ? 'initiation-2' : 'interwoven-1', address: initiaAddress },
      ],
    },
  });

  // 3. Late-bind the bridge into the adapter so 402 flows auto-bridge.
  initiaAdapter.setBridgeIfNeeded((req: { requiredAmount: bigint; recipient: string }) =>
    orchestrator.ensureIusd(req),
  );

  return { client, orchestrator, initia, sourceChain };
}

/** Resolve the wallet record without coupling to handlers.ts internals. */
async function loadWalletRecord(ctx: ToolContext): Promise<{
  name: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
}> {
  const { ensureWallet } = await import('./wallet.js');
  return ensureWallet(ctx.walletName);
}

// ─── Re-export tiny chain-key guard so handlers can stay decoupled ────────
export { isInitiaChain };

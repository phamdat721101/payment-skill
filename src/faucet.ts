// Testnet faucet + doctor self-test.
//
// Faucet strategy: only call PUBLIC drip endpoints (Circle for Base/Arb
// Sepolia). For chains with no programmatic faucet (GOAT testnet, Stellar
// testnet), return a click-through URL the user can copy. We never ship a
// funder private key in this package.
//
// Doctor strategy: verify the wallet record, RPC reachability via viem, and
// the USDC balance. Returns a structured report so the CLI can pretty-print
// and CI can assert.

import {
  createPublicClient,
  defineChain,
  formatUnits,
  http,
  type Address,
} from 'viem';
import { erc20Abi } from 'viem';
import type { ChainKey } from './tools.js';

// ─── Chain metadata ──────────────────────────────────────────────────────────
// Kept in this file so the skill never has to load the full n-payment SDK
// just to bootstrap. Stays in sync with n-payment/src/chains.ts at v0.8.0.
interface ChainMeta {
  name: string;
  chainId: number;
  rpcUrl: string;
  usdc?: Address;
  /**
   * Primary ERC-20 payment token when it isn't USDC (e.g. SPACE on Creditcoin).
   * Handlers prefer this over `usdc` when both are present, and fall back to
   * USDC defaults (6 decimals) for chains where only `usdc` is set.
   */
  paymentToken?: { address: Address; symbol: string; decimals: number };
  /** programmatic faucet: 'circle' | 'tempo' | null */
  faucet?: 'circle' | 'tempo' | null;
  /** click-through faucet URL printed when programmatic isn't available */
  manualFaucetUrl?: string;
  /** Stellar Asset Contract ID for USDC (SEP-41 token contract). Stellar-only. */
  stellarUsdcContract?: string;
  /** Stellar issuer account (G…) for USDC. Stellar-only. */
  stellarUsdcIssuer?: string;
  /** Aave V3 Pool address on this chain. Override at runtime via AAVE_POOL_ADDRESS. */
  aave?: { pool: Address; usdc?: Address };
}

export const CHAIN_META: Record<ChainKey, ChainMeta> = {
  'base-sepolia': {
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    faucet: 'circle',
    manualFaucetUrl: 'https://faucet.circle.com',
    aave: {
      pool: '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27',
      usdc: '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f',
    },
  },
  'arbitrum-sepolia': {
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    faucet: 'circle',
    manualFaucetUrl: 'https://faucet.circle.com',
  },
  'goat-testnet': {
    name: 'GOAT Testnet3',
    chainId: 48816,
    rpcUrl: 'https://rpc.testnet3.goat.network',
    faucet: null,
    manualFaucetUrl: 'https://faucet.testnet3.goat.network',
  },
  'goat-mainnet': {
    name: 'GOAT Mainnet',
    chainId: 2345,
    rpcUrl: 'https://rpc.goat.network',
  },
  'tempo-testnet': {
    name: 'Tempo Testnet',
    chainId: 42431,
    rpcUrl: 'https://rpc.testnet.tempo.xyz',
    faucet: 'tempo',
    manualFaucetUrl: 'https://docs.tempo.xyz/faucet',
  },
  'tempo-mainnet': {
    name: 'Tempo',
    chainId: 4217,
    rpcUrl: 'https://rpc.tempo.xyz',
  },
  'base-mainnet': {
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  'xrpl-testnet': {
    name: 'XRPL Testnet',
    chainId: 0,
    rpcUrl: 'https://s.altnet.rippletest.net:51234',
    manualFaucetUrl: 'https://faucet.altnet.rippletest.net/accounts',
  },
  'xrpl-mainnet': { name: 'XRPL', chainId: 0, rpcUrl: 'https://xrplcluster.com' },
  'stellar-testnet': {
    name: 'Stellar Testnet',
    chainId: 0,
    rpcUrl: 'https://horizon-testnet.stellar.org',
    manualFaucetUrl: 'https://laboratory.stellar.org/#account-creator',
    stellarUsdcContract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    stellarUsdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
  'stellar-mainnet': {
    name: 'Stellar',
    chainId: 0,
    rpcUrl: 'https://horizon.stellar.org',
    stellarUsdcContract: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    stellarUsdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
  'solana-mainnet': {
    name: 'Solana',
    chainId: 0,
    rpcUrl: 'https://api.mainnet-beta.solana.com',
  },
  'solana-devnet': {
    name: 'Solana Devnet',
    chainId: 0,
    rpcUrl: 'https://api.devnet.solana.com',
    manualFaucetUrl: 'https://faucet.solana.com',
  },
  'morph-mainnet': {
    name: 'Morph Mainnet',
    chainId: 2818,
    rpcUrl: 'https://rpc-quicknode.morph.network',
    usdc: '0xe34c91815d7fc18A9e2148bcD4241d0a5848b693',
  },
  'morph-hoodi-testnet': {
    name: 'Morph Hoodi Testnet',
    chainId: 2910,
    rpcUrl: 'https://rpc-hoodi.morph.network',
    faucet: null,
    manualFaucetUrl: 'https://bridge-hoodi.morph.network',
  },
  'creditcoin-mainnet': {
    name: 'Creditcoin',
    chainId: 102030,
    rpcUrl: 'https://mainnet3.creditcoin.network',
    paymentToken: {
      address: '0x7ab7C6A935Ab2D1437398790C9C0660af62A80b9',
      symbol: 'SPACE',
      decimals: 18,
    },
    faucet: null,
    manualFaucetUrl:
      'https://docs.spacecoin.org/usdspace-token/token-overview-and-utility',
  },
  'creditcoin-testnet': {
    name: 'Creditcoin CC3 Testnet',
    chainId: 102031,
    rpcUrl: 'https://rpc.cc3-testnet.creditcoin.network',
    paymentToken: {
      address: '0x7ab7C6A935Ab2D1437398790C9C0660af62A80b9',
      symbol: 'SPACE',
      decimals: 18,
    },
    faucet: null,
    manualFaucetUrl: 'https://faucet.cc3-testnet.creditcoin.network',
  },
  'bnb-mainnet': {
    name: 'BNB Chain',
    chainId: 56,
    rpcUrl: 'https://bsc-dataseed.binance.org',
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  },
  'bnb-testnet': {
    name: 'BNB Testnet',
    chainId: 97,
    rpcUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545',
    usdc: '0x64544969ed7EBf5f083679233325356EbE738930',
    faucet: null,
    manualFaucetUrl: 'https://testnet.bnbchain.org/faucet-smart',
  },
  'flare-coston2': {
    name: 'Flare Coston2',
    chainId: 114,
    rpcUrl: 'https://coston2-api.flare.network/ext/C/rpc',
    faucet: null,
    manualFaucetUrl: 'https://faucet.flare.network/coston2',
  },
  'flare-mainnet': {
    name: 'Flare',
    chainId: 14,
    rpcUrl: 'https://flare-api.flare.network/ext/C/rpc',
  },
};

export const isTestnetChain = (chain: ChainKey): boolean =>
  /-(testnet|sepolia|devnet|hoodi)$/.test(chain);

// ─── Faucet ──────────────────────────────────────────────────────────────────
export interface FaucetResult {
  ok: boolean;
  chain: ChainKey;
  programmatic: boolean;
  message: string;
  manualUrl?: string;
}

export async function requestFaucet(
  address: Address,
  chain: ChainKey,
  fetchFn: typeof fetch = fetch,
): Promise<FaucetResult> {
  const meta = CHAIN_META[chain];
  if (!isTestnetChain(chain)) {
    return {
      ok: false,
      chain,
      programmatic: false,
      message: `Refusing to faucet on mainnet chain '${chain}'.`,
    };
  }
  if (meta.faucet === 'circle') {
    const circleChain = chain === 'base-sepolia' ? 'BASE-SEPOLIA' : 'ARB-SEPOLIA';
    try {
      const res = await fetchFn('https://faucet.circle.com/api/drip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, chain: circleChain, amount: '10000000' }),
      });
      return {
        ok: res.ok,
        chain,
        programmatic: true,
        message: res.ok
          ? `Circle faucet dripped 10 USDC to ${address} on ${meta.name}.`
          : `Circle faucet returned ${res.status}; try the URL.`,
        manualUrl: meta.manualFaucetUrl,
      };
    } catch (e) {
      return {
        ok: false,
        chain,
        programmatic: true,
        message: `Circle faucet error: ${(e as Error).message}`,
        manualUrl: meta.manualFaucetUrl,
      };
    }
  }
  if (meta.faucet === 'tempo') {
    try {
      const res = await fetchFn('https://docs.tempo.xyz/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.toLowerCase() }),
      });
      return {
        ok: res.ok,
        chain,
        programmatic: true,
        message: res.ok ? `Tempo faucet sent funds.` : `Tempo faucet ${res.status}.`,
        manualUrl: meta.manualFaucetUrl,
      };
    } catch (e) {
      return {
        ok: false,
        chain,
        programmatic: true,
        message: `Tempo faucet error: ${(e as Error).message}`,
        manualUrl: meta.manualFaucetUrl,
      };
    }
  }
  return {
    ok: true,
    chain,
    programmatic: false,
    message: `No programmatic faucet for ${meta.name}. Open the URL to fund.`,
    manualUrl: meta.manualFaucetUrl,
  };
}

// ─── Doctor ──────────────────────────────────────────────────────────────────
export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  hint?: string;
}
export interface DoctorReport {
  ok: boolean;
  address?: Address;
  chain: ChainKey;
  checks: DoctorCheck[];
}

export async function runDoctor(
  address: Address,
  chain: ChainKey,
  fetchFn: typeof fetch = fetch,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const meta = CHAIN_META[chain];

  checks.push({ name: 'wallet', status: 'ok', message: address });

  // RPC reachability + chain id
  let chainIdOk = false;
  let pub;
  try {
    const vchain = defineChain({
      id: meta.chainId || 1,
      name: meta.name,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [meta.rpcUrl] } },
    });
    pub = createPublicClient({ chain: vchain, transport: http(meta.rpcUrl) });
    const id = await pub.getChainId();
    chainIdOk = meta.chainId === 0 || id === meta.chainId;
    checks.push({
      name: 'rpc',
      status: chainIdOk ? 'ok' : 'warn',
      message: chainIdOk
        ? `${meta.rpcUrl} (chainId=${id})`
        : `Chain id mismatch: rpc=${id}, expected=${meta.chainId}`,
    });
  } catch (e) {
    checks.push({
      name: 'rpc',
      status: 'fail',
      message: `RPC unreachable: ${(e as Error).message}`,
      hint: 'Check internet, then retry `n-payment-skill doctor`.',
    });
  }

  // USDC balance (best-effort)
  if (pub && meta.usdc) {
    try {
      const bal = (await pub.readContract({
        address: meta.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint;
      const human = formatUnits(bal, 6);
      checks.push({
        name: 'balance',
        status: bal > 0n ? 'ok' : 'warn',
        message: `${human} USDC on ${meta.name}`,
        hint:
          bal === 0n
            ? `Run \`n-payment-skill faucet --chain ${chain}\` or open ${meta.manualFaucetUrl}`
            : undefined,
      });
    } catch (e) {
      checks.push({
        name: 'balance',
        status: 'warn',
        message: `Balance read failed: ${(e as Error).message}`,
      });
    }
  }

  // Faucet availability summary (no actual call here — pure info)
  if (isTestnetChain(chain)) {
    checks.push({
      name: 'faucet',
      status: 'ok',
      message:
        meta.faucet === 'circle'
          ? `Programmatic Circle faucet available.`
          : meta.faucet === 'tempo'
            ? `Programmatic Tempo faucet available.`
            : `Manual faucet: ${meta.manualFaucetUrl ?? '(none)'}`,
    });
  }

  return {
    ok: checks.every((c) => c.status !== 'fail'),
    address,
    chain,
    checks,
  };
}

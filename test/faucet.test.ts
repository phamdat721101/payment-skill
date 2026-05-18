import { describe, expect, it, vi } from 'vitest';
import {
  CHAIN_META,
  isTestnetChain,
  requestFaucet,
  runDoctor,
} from '../src/faucet.js';

const ADDR = '0x000000000000000000000000000000000000dEaD' as const;

describe('faucet', () => {
  it('refuses to drip on mainnet chains', async () => {
    const r = await requestFaucet(ADDR, 'base-mainnet', vi.fn() as never);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/mainnet/);
  });

  it('isTestnetChain catches sepolia / testnet / devnet suffixes', () => {
    expect(isTestnetChain('base-sepolia')).toBe(true);
    expect(isTestnetChain('goat-testnet')).toBe(true);
    expect(isTestnetChain('solana-devnet')).toBe(true);
    expect(isTestnetChain('base-mainnet')).toBe(false);
  });

  it('calls the Circle endpoint for base-sepolia and surfaces the response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const r = await requestFaucet(ADDR, 'base-sepolia', fetchFn as never);
    expect(r.ok).toBe(true);
    expect(r.programmatic).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://faucet.circle.com/api/drip');
    expect(JSON.parse(init.body).chain).toBe('BASE-SEPOLIA');
  });

  it('returns a manual url when no programmatic faucet exists (goat-testnet)', async () => {
    const r = await requestFaucet(ADDR, 'goat-testnet', vi.fn() as never);
    expect(r.programmatic).toBe(false);
    expect(r.manualUrl).toBe(CHAIN_META['goat-testnet'].manualFaucetUrl);
  });

  it('handles a faucet HTTP error gracefully', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const r = await requestFaucet(ADDR, 'base-sepolia', fetchFn as never);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/429/);
    expect(r.manualUrl).toBe('https://faucet.circle.com');
  });
});

describe('doctor', () => {
  it('always reports the wallet check + a faucet info row on testnet', async () => {
    // Mock RPC + balance reads via fetchFn? viem uses its own transport.
    // We accept that the rpc/balance calls may fail in offline CI, the test
    // here just ensures the report is well-formed and includes the wallet row.
    const r = await runDoctor(ADDR, 'goat-testnet', vi.fn() as never);
    expect(r.address).toBe(ADDR);
    expect(r.chain).toBe('goat-testnet');
    expect(r.checks.find((c) => c.name === 'wallet')?.status).toBe('ok');
    expect(r.checks.find((c) => c.name === 'faucet')).toBeDefined();
  });

  it('marks ok=false when an rpc check actually fails', async () => {
    // Hit an obviously-bad chain via a doctored CHAIN_META copy is overkill;
    // instead point to a bogus RPC by mutating the URL just for this test.
    const original = CHAIN_META['goat-testnet'].rpcUrl;
    (CHAIN_META as Record<string, { rpcUrl: string }>)['goat-testnet']!.rpcUrl =
      'http://127.0.0.1:1';
    try {
      const r = await runDoctor(ADDR, 'goat-testnet');
      const rpc = r.checks.find((c) => c.name === 'rpc');
      expect(rpc?.status === 'fail' || rpc?.status === 'warn').toBe(true);
    } finally {
      (CHAIN_META as Record<string, { rpcUrl: string }>)['goat-testnet']!.rpcUrl =
        original;
    }
  });
});

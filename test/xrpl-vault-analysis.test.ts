import { describe, expect, it, vi } from 'vitest';
import { TOOL_BY_NAME, TOOL_NAMES } from '../src/tools.js';
import type { ToolContext } from '../src/tools.js';

// Mock n-payment's createXrplClient so no live XRPL network calls happen.
// Matches this repo's existing mocking convention (see test/xrpfi.test.ts).
const mockState = {
  getVaultInfo: undefined as unknown,
  getExchangeRate: undefined as unknown,
  disconnect: vi.fn(async () => undefined),
};

vi.mock('n-payment', () => ({
  createXrplClient: vi.fn(() => ({
    vault: {
      getVaultInfo: (...args: unknown[]) =>
        (mockState.getVaultInfo as (...a: unknown[]) => unknown)(...args),
      getExchangeRate: (...args: unknown[]) =>
        (mockState.getExchangeRate as (...a: unknown[]) => unknown)(...args),
    },
    disconnect: mockState.disconnect,
  })),
}));

const ctx = (env: NodeJS.ProcessEnv = { XRPL_SEED: 'sEdTest' }, testnetMode = true): ToolContext => ({
  walletName: 'default',
  defaultChain: 'xrpl-testnet',
  testnetMode,
  env,
});

describe('xrpl_vault_analysis — registry & schema', () => {
  const t = TOOL_BY_NAME.xrpl_vault_analysis!;

  it('is registered exactly once', () => {
    expect(t).toBeDefined();
    expect(TOOL_NAMES.filter((n) => n === 'xrpl_vault_analysis')).toHaveLength(1);
  });

  it('requires vault_id', () => {
    expect(t.schema.safeParse({}).success).toBe(false);
    expect(t.schema.safeParse({ vault_id: 'V123' }).success).toBe(true);
  });

  it('defaults chain to xrpl-testnet', () => {
    const r = t.schema.parse({ vault_id: 'V123' }) as { chain: string };
    expect(r.chain).toBe('xrpl-testnet');
  });

  it('rejects unsupported chain values', () => {
    expect(
      t.schema.safeParse({ vault_id: 'V123', chain: 'base-mainnet' }).success,
    ).toBe(false);
  });
});

describe('xrpl_vault_analysis — handler', () => {
  it('combines vault info + exchange rate into one read-only snapshot', async () => {
    mockState.getVaultInfo = vi.fn(async () => ({
      vaultId: 'V123',
      owner: 'rOwner',
      asset: { currency: 'RLUSD', issuer: 'rIssuer' },
      totalAssets: '1000',
      totalShares: '950',
      lossUnrealized: '0',
      sharesMPTId: '00001234',
    }));
    mockState.getExchangeRate = vi.fn(async () => ({ deposit: 1.0526, withdrawal: 0.95 }));

    const t = TOOL_BY_NAME.xrpl_vault_analysis!;
    const r = await t.handler({ vault_id: 'V123', chain: 'xrpl-testnet' }, ctx());

    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as Record<string, unknown>;
      expect(data.vault_id).toBe('V123');
      expect(data.total_assets).toBe('1000');
      expect(data.total_shares).toBe('950');
      expect(data.share_price).toBe(1.0526);
      expect(data.withdrawal_rate).toBe(0.95);
      expect(typeof data.implied_apy_pct).toBe('number');
      expect(data.implied_apy_pct).toBeCloseTo(5.26, 1);
    }
  });

  it('fails with MISSING_ARG shape when vault_id is empty at the handler boundary', async () => {
    const t = TOOL_BY_NAME.xrpl_vault_analysis!;
    // Schema requires vault_id, but exercise the handler's own defensive
    // check too (defense in depth, per this repo's input-validation rule).
    const r = await t.handler(
      { vault_id: '', chain: 'xrpl-testnet' } as never,
      ctx(),
    );
    expect(r).toMatchObject({ ok: false, code: 'MISSING_ARG' });
  });

  it('blocks xrpl-mainnet while testnetMode=true (guardMainnet)', async () => {
    const t = TOOL_BY_NAME.xrpl_vault_analysis!;
    const r = await t.handler(
      { vault_id: 'V123', chain: 'xrpl-mainnet' },
      ctx({ XRPL_SEED: 'sEdTest' }, true),
    );
    expect(r).toMatchObject({ ok: false, code: 'MAINNET_GUARD' });
  });

  it('propagates XRPL_SEED_MISSING when no seed is configured', async () => {
    const t = TOOL_BY_NAME.xrpl_vault_analysis!;
    const r = await t.handler({ vault_id: 'V123', chain: 'xrpl-testnet' }, ctx({}, true));
    expect(r).toMatchObject({ ok: false, code: 'XRPL_SEED_MISSING' });
  });
});

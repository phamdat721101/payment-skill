import { describe, expect, it, vi } from 'vitest';
import { TOOL_BY_NAME, TOOL_NAMES } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { xrpfi_redeem_bridge } from '../src/handlers.ts';

// Mock n-payment to nothing → exercises the RLUSD_SDK_TOO_OLD probe path,
// and lets the dry-run happy-path test override `selectRlusdCorridor` per-call.
const mockState = { selectRlusdCorridor: undefined as unknown };
vi.mock('n-payment', () => ({
  get selectRlusdCorridor() {
    return mockState.selectRlusdCorridor;
  },
  createPaymentClient: vi.fn(() => ({})),
}));

const ctx = (env: NodeJS.ProcessEnv = {}, testnetMode = true): ToolContext => ({
  walletName: 'default',
  defaultChain: 'base-mainnet',
  testnetMode,
  env,
});

const baseArgs = {
  amount_fxrp: '10',
  target_chain: 'base-mainnet' as const,
  flare_chain: 'flare-mainnet' as const,
  xrpl_chain: 'xrpl-mainnet' as const,
  swap_max_slippage_bps: 100,
  redemption_timeout_ms: 600_000,
  wait: true,
  poll_interval_ms: 10_000,
  timeout_ms: 600_000,
  dry_run: false,
};

const testnetArgs = {
  ...baseArgs,
  target_chain: 'xrpl-testnet' as const,
  flare_chain: 'flare-coston2' as const,
  xrpl_chain: 'xrpl-testnet' as const,
};

// ─── Registry & schema ──────────────────────────────────────────────────────

describe('xrpfi_redeem_bridge — registry & schema', () => {
  const t = TOOL_BY_NAME.xrpfi_redeem_bridge!;

  it('is registered exactly once', () => {
    expect(t).toBeDefined();
    expect(TOOL_NAMES.filter((n) => n === 'xrpfi_redeem_bridge')).toHaveLength(1);
  });

  it('parses minimal input with sane defaults', () => {
    const r = t.schema.parse({ amount_fxrp: '10' }) as Record<string, unknown>;
    expect(r.target_chain).toBe('base-mainnet');
    expect(r.flare_chain).toBe('flare-mainnet');
    expect(r.xrpl_chain).toBe('xrpl-mainnet');
    expect(r.swap_max_slippage_bps).toBe(100);
    expect(r.wait).toBe(true);
    expect(r.dry_run).toBe(false);
    expect(r.timeout_ms).toBe(600_000);
  });

  it('rejects non-decimal amount_fxrp', () => {
    expect(t.schema.safeParse({ amount_fxrp: 'ten' }).success).toBe(false);
  });

  it('rejects unsupported target_chain', () => {
    expect(
      t.schema.safeParse({ amount_fxrp: '10', target_chain: 'solana-mainnet' }).success,
    ).toBe(false);
  });

  it('accepts XRPL-only target (stops at swap leg)', () => {
    expect(
      t.schema.safeParse({ amount_fxrp: '5', target_chain: 'xrpl-mainnet' }).success,
    ).toBe(true);
  });
});

// ─── Handler guards (no SDK / no ethers reached) ────────────────────────────

describe('xrpfi_redeem_bridge — handler guards', () => {
  it('blocks every mainnet chain in the corridor while testnetMode=true', async () => {
    const r = await xrpfi_redeem_bridge(baseArgs, ctx({ XRPL_SEED: 'sEd' }, true));
    expect(r).toMatchObject({ ok: false, code: 'MAINNET_GUARD' });
  });

  it('errors XRPL_SEED_MISSING when XRPL_SEED is unset (testnet path)', async () => {
    const r = await xrpfi_redeem_bridge(testnetArgs, ctx({}, true));
    expect(r).toMatchObject({ ok: false, code: 'XRPL_SEED_MISSING' });
  });

  it('errors WORMHOLE_SIGNER_KEY_MISSING when EVM target lacks the matching env key', async () => {
    // testnetMode=false → mainnet guard passes; signer-key check then fires.
    const r = await xrpfi_redeem_bridge(baseArgs, ctx({ XRPL_SEED: 'sEd' }, false));
    expect(r).toMatchObject({ ok: false, code: 'WORMHOLE_SIGNER_KEY_MISSING' });
    if (!r.ok) expect(r.hint).toContain('BASE_KEY');
  });

  it('errors XRPFI_CAPS_EXCEEDED when amount > RLUSD_MAX_PER_TRANSFER', async () => {
    const r = await xrpfi_redeem_bridge(
      { ...testnetArgs, amount_fxrp: '1000' },
      ctx({ XRPL_SEED: 'sEd', RLUSD_MAX_PER_TRANSFER: '50' }, true),
    );
    expect(r).toMatchObject({ ok: false, code: 'XRPFI_CAPS_EXCEEDED' });
  });
});

// ─── SDK integration ────────────────────────────────────────────────────────

describe('xrpfi_redeem_bridge — SDK integration', () => {
  it('errors RLUSD_SDK_TOO_OLD when selectRlusdCorridor is missing from the SDK', async () => {
    mockState.selectRlusdCorridor = undefined;
    const r = await xrpfi_redeem_bridge(testnetArgs, ctx({ XRPL_SEED: 'sEd' }, true));
    expect(r).toMatchObject({ ok: false, code: 'RLUSD_SDK_TOO_OLD' });
  });

  it('dry_run=true returns the plan only and never executes (XRPL target)', async () => {
    const fakePlan = { route: 'xrpfi-redeem-then-swap', cost_estimate_xrp: '0.1' };
    const planFn = vi.fn(async () => fakePlan);
    mockState.selectRlusdCorridor = planFn;

    const r = await xrpfi_redeem_bridge(
      {
        ...testnetArgs,
        dry_run: true,
        recipient: 'rTest1234567890Recipient1234567890ab',
      },
      ctx({ XRPL_SEED: 'sEd' }, true),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { step: string }).step).toBe('dry-run');
      expect((r.data as { plan: unknown }).plan).toEqual(fakePlan);
      expect((r.data as { target_chain: string }).target_chain).toBe('xrpl-testnet');
      expect((r.data as { max_per_transfer: string }).max_per_transfer).toBe('50');
    }
    expect(planFn).toHaveBeenCalledOnce();
  });
});

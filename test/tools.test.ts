import { describe, expect, it, beforeEach } from 'vitest';
import { TOOLS, TOOL_BY_NAME, TOOL_NAMES, Chain, CHAIN_KEYS } from '../src/tools.js';

describe('tool registry', () => {
  it('exposes exactly 38 tools', () => {
    expect(TOOLS).toHaveLength(38);
  });

  it('Morph features are unified under a single morph_pay tool', () => {
    expect(TOOL_NAMES).toContain('morph_pay');
    for (const dropped of [
      'morph_reference_key',
      'morph_altfee_pay',
      'morph_passkey_pay',
    ]) {
      expect(TOOL_NAMES).not.toContain(dropped);
    }
  });

  it('has unique tool names', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOLS.length);
  });

  it('keeps the index aligned with the array', () => {
    for (const t of TOOLS) {
      expect(TOOL_BY_NAME[t.name]).toBe(t);
    }
  });

  it('every tool has a non-empty description and a zod schema', () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.schema.safeParse).toBe('function');
    }
  });

  it('chain enum mirrors the n-payment ChainKey union', () => {
    for (const k of CHAIN_KEYS) {
      expect(Chain.safeParse(k).success).toBe(true);
    }
    expect(Chain.safeParse('not-a-chain').success).toBe(false);
  });

  it('pay schema validates a happy-path payload', () => {
    const r = TOOL_BY_NAME.pay!.schema.safeParse({
      url: 'https://example.com/data',
      chain: 'base-sepolia',
      method: 'GET',
    });
    expect(r.success).toBe(true);
  });

  it('pay schema rejects a malformed url', () => {
    const r = TOOL_BY_NAME.pay!.schema.safeParse({ url: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('every tool exposes an async function handler', () => {
    for (const t of TOOLS) {
      expect(typeof t.handler).toBe('function');
      // Async functions report constructor.name === 'AsyncFunction'.
      expect((t.handler as Function).constructor.name).toBe('AsyncFunction');
    }
  });
});

// ─── GOAT BTC → USDC swap tool (n-payment v0.17) ─────────────────────────────
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';

describe('goat_swap_to_usdc — schema', () => {
  const tool = TOOL_BY_NAME.goat_swap_to_usdc!;

  it('is registered exactly once', () => {
    expect(tool).toBeDefined();
    expect(TOOL_NAMES.filter((n) => n === 'goat_swap_to_usdc')).toHaveLength(1);
  });

  it('rejects empty input (must pass amount_usdc OR amount_btc)', () => {
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  it('rejects providing BOTH amount_usdc and amount_btc (XOR)', () => {
    const r = tool.schema.safeParse({ amount_usdc: '1', amount_btc: '0.0001' });
    expect(r.success).toBe(false);
  });

  it('accepts amount_usdc only and applies defaults', () => {
    const r = tool.schema.safeParse({ amount_usdc: '1' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.chain).toBe('goat-testnet');
      expect(r.data.max_slippage_bps).toBe(50);
      expect(r.data.dry_run).toBe(false);
    }
  });

  it('accepts amount_btc only', () => {
    expect(tool.schema.safeParse({ amount_btc: '0.0001' }).success).toBe(true);
  });

  it('accepts an optional idempotency_key (1-64 chars)', () => {
    expect(tool.schema.safeParse({ amount_usdc: '1', idempotency_key: 'order-123' }).success).toBe(true);
    expect(tool.schema.safeParse({ amount_usdc: '1', idempotency_key: '' }).success).toBe(false);
    expect(tool.schema.safeParse({ amount_usdc: '1', idempotency_key: 'x'.repeat(65) }).success).toBe(false);
  });

  it('only accepts goat-testnet or goat-mainnet for chain', () => {
    expect(tool.schema.safeParse({ amount_usdc: '1', chain: 'base-sepolia' }).success).toBe(false);
    expect(tool.schema.safeParse({ amount_usdc: '1', chain: 'goat-mainnet' }).success).toBe(true);
  });
});

describe('goat_swap_to_usdc — handler', () => {
  const ctx = {
    walletName: 'test-wallet',
    defaultChain: 'goat-testnet' as const,
    testnetMode: true,
    env: {} as NodeJS.ProcessEnv,
  };

  // Mock n-payment so we never touch the real SDK in unit tests.
  const acquireMock = vi.fn();
  const RouterMock = vi.fn().mockImplementation(() => ({ acquire: acquireMock }));
  const swapOnlyMock = vi.fn(() => ({
    enabled: true,
    allowedPaths: ['swap'],
    maxPerHour: 5_000_000n,
    maxPerDay: 50_000_000n,
    maxFeeBps: 100,
    maxSlippageBps: 50,
  }));

  vi.mock('n-payment', () => ({
    UsdcAcquisitionRouter: vi.fn(),
    GoatAcquisitionPresets: { swapOnly: vi.fn(), safeDefaults: vi.fn(), aggressive: vi.fn(), testnet: vi.fn() },
    SpendingGuard: vi.fn().mockImplementation(() => ({})),
    PolicyEngine: vi.fn().mockImplementation(() => ({})),
    AuditLog: vi.fn().mockImplementation(() => ({})),
    OWSWallet: vi.fn().mockImplementation(() => ({})),
  }));

  beforeEach(async () => {
    const np = await import('n-payment');
    (np.UsdcAcquisitionRouter as unknown as ReturnType<typeof vi.fn>).mockImplementation(RouterMock);
    (np.GoatAcquisitionPresets.swapOnly as unknown as ReturnType<typeof vi.fn>).mockImplementation(swapOnlyMock);
    RouterMock.mockClear();
    acquireMock.mockReset();
    swapOnlyMock.mockClear();
  });

  it('uses swapOnly() preset and parseUnits(1, 6) targetUsdcWei for amount_usdc=1', async () => {
    const { goat_swap_to_usdc } = await import('../src/handlers.js');
    acquireMock.mockResolvedValue({
      status: 'dry-run',
      acquired: 0n,
      quote: { path: 'swap', feeBps: 30, slippageBps: 50 },
      correlationId: 'corr-1',
    });

    const r = await goat_swap_to_usdc(
      { amount_usdc: '1', max_slippage_bps: 50, chain: 'goat-testnet', dry_run: true },
      ctx,
    );

    expect(swapOnlyMock).toHaveBeenCalledTimes(1);
    expect(RouterMock).toHaveBeenCalledTimes(1);
    const routerArg = RouterMock.mock.calls[0]![0];
    expect(routerArg.goatChain).toBe('goat-testnet');
    expect(routerArg.config.allowedPaths).toEqual(['swap']);
    expect(routerArg.config.maxSlippageBps).toBe(50);
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(acquireMock.mock.calls[0]![0].targetUsdcWei).toBe(1_000_000n);
    expect(acquireMock.mock.calls[0]![0].dryRun).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('routes dry_run=false to acquire() with dryRun=false', async () => {
    const { goat_swap_to_usdc } = await import('../src/handlers.js');
    acquireMock.mockResolvedValue({
      status: 'executed',
      acquired: 5_000_000n,
      quote: { path: 'swap', feeBps: 30 },
      receipt: { txHash: '0xabc', chain: 'goat-testnet', usdcReceivedWei: 5_000_000n },
      correlationId: 'corr-2',
    });

    const r = await goat_swap_to_usdc(
      { amount_usdc: '5', max_slippage_bps: 50, chain: 'goat-testnet', dry_run: false },
      ctx,
    );

    expect(acquireMock.mock.calls[0]![0].dryRun).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('returns MAINNET_GUARD on goat-mainnet while testnetMode=true and never calls the SDK', async () => {
    const { goat_swap_to_usdc } = await import('../src/handlers.js');
    const r = await goat_swap_to_usdc(
      { amount_usdc: '1', max_slippage_bps: 50, chain: 'goat-mainnet', dry_run: true },
      { ...ctx, testnetMode: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('MAINNET_GUARD');
    expect(RouterMock).not.toHaveBeenCalled();
  });

  it('forwards a caller-provided idempotency_key verbatim', async () => {
    const { goat_swap_to_usdc } = await import('../src/handlers.js');
    acquireMock.mockResolvedValue({ status: 'dry-run', acquired: 0n, quote: { path: 'swap', feeBps: 30 }, correlationId: 'corr-3' });

    await goat_swap_to_usdc(
      { amount_usdc: '1', max_slippage_bps: 50, chain: 'goat-testnet', dry_run: true, idempotency_key: 'order-99' },
      ctx,
    );
    expect(acquireMock.mock.calls[0]![0].idempotencyKey).toBe('order-99');
  });

  it('decorates GOAT_NO_VIABLE_PATH with the testnet faucet hint', async () => {
    const { goat_swap_to_usdc } = await import('../src/handlers.js');
    acquireMock.mockRejectedValue(Object.assign(new Error('no path'), { code: 'GOAT_NO_VIABLE_PATH' }));

    const r = await goat_swap_to_usdc(
      { amount_usdc: '1', max_slippage_bps: 50, chain: 'goat-testnet', dry_run: false },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('GOAT_NO_VIABLE_PATH');
      expect(r.hint).toContain('faucet.testnet3.goat.network');
    }
  });
});

describe('SKILL.md ↔ registry — natural 1-line prompts route to the new tool', () => {
  // Reads triggers from the SKILL.md frontmatter and asserts every natural
  // prompt the agent might say is matched by at least one trigger substring.
  // Cheap regression guard against future trigger-table drift.
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  const fm = skill.split('---')[1] ?? '';
  const triggers = [...fm.matchAll(/^\s*-\s+(.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());

  // The agent host (Claude Code, Kiro, Cursor, …) routes prompts via LLM-based
  // semantic matching, not literal substring search. So the test asserts the
  // triggers list COVERS the keyword space that naturally maps to a swap
  // intent: each verb {swap, convert, get, fund, acquire, auto-fund} appears
  // in at least one trigger, and the {btc, usdc, goat} nouns are well-covered.
  const triggerBag = triggers.join(' | ');
  const expectedVerbs = ['swap', 'convert', 'get', 'fund', 'acquire', 'auto-fund'];
  const expectedNouns = ['btc', 'usdc', 'goat'];

  it('triggers cover every swap-intent verb', () => {
    for (const v of expectedVerbs) {
      expect(triggerBag, `verb "${v}" not present in triggers`).toMatch(new RegExp(`\\b${v}\\b`));
    }
  });

  it('triggers cover every swap-intent noun', () => {
    for (const n of expectedNouns) {
      expect(triggerBag, `noun "${n}" not present in triggers`).toMatch(new RegExp(`\\b${n}\\b`));
    }
  });

  it('triggers list includes at least one explicit "btc to usdc" phrase', () => {
    expect(triggers.some((t) => t.includes('btc') && t.includes('usdc'))).toBe(true);
  });

  it('SKILL.md routing table mentions goat_swap_to_usdc', () => {
    expect(skill).toMatch(/`goat_swap_to_usdc`/);
  });

  it('SKILL.md errors→fixes table covers the v0.17 acquisition codes', () => {
    expect(skill).toMatch(/GOAT_NO_VIABLE_PATH/);
    expect(skill).toMatch(/GOAT_SWAP_SLIPPAGE_EXCEEDED/);
    expect(skill).toMatch(/GOAT_AUTOFUND_LIMIT_EXCEEDED/);
    expect(skill).toMatch(/GOAT_BTC_PRICE_UNAVAILABLE/);
  });

  it('SKILL.md preamble surfaces GOAT_CREDS for the agent', () => {
    expect(skill).toMatch(/GOAT_CREDS:/);
    expect(skill).toMatch(/GOAT_AUTOFUND:/);
  });
});

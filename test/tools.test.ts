import { describe, expect, it, beforeEach } from 'vitest';
import { TOOLS, TOOL_BY_NAME, TOOL_NAMES, Chain, CHAIN_KEYS } from '../src/tools.js';

describe('tool registry', () => {
  it('exposes exactly 48 tools', () => {
    expect(TOOLS).toHaveLength(48);
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
    // Stellar (v0.30) exports — overridden per-test in the stellar_off_ramp / stellar_session suites.
    DefaultAnchorRegistry: vi.fn(),
    StellarWallet: vi.fn(),
    stellarAgentKit: vi.fn(),
    createPaymentClient: vi.fn(),
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


// ─── iUSD on Initia (n-payment v0.23) ────────────────────────────────────────
describe('iusd_bridge — schema', () => {
  const tool = TOOL_BY_NAME.iusd_bridge!;

  it('is registered exactly once', () => {
    expect(tool).toBeDefined();
    expect(TOOL_NAMES.filter((n) => n === 'iusd_bridge')).toHaveLength(1);
  });

  it('chain enum gained initia-testnet and initia-mainnet', () => {
    expect(CHAIN_KEYS).toContain('initia-testnet');
    expect(CHAIN_KEYS).toContain('initia-mainnet');
  });

  it('quote / execute require amount_iusd', () => {
    for (const action of ['quote', 'execute'] as const) {
      const r = tool.schema.safeParse({ action, dest_chain: 'initia-testnet' });
      expect(r.success).toBe(false);
    }
  });

  it('balance does NOT require amount_iusd', () => {
    const r = tool.schema.safeParse({ action: 'balance', dest_chain: 'initia-testnet' });
    expect(r.success).toBe(true);
  });

  it('pay_url requires url', () => {
    const r1 = tool.schema.safeParse({ action: 'pay_url', dest_chain: 'initia-testnet' });
    expect(r1.success).toBe(false);
    const r2 = tool.schema.safeParse({
      action: 'pay_url',
      dest_chain: 'initia-testnet',
      url: 'https://api.example.com/x',
    });
    expect(r2.success).toBe(true);
  });

  it('default dest_chain is initia-testnet (testnet-first)', () => {
    const r = tool.schema.safeParse({ action: 'balance' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.dest_chain).toBe('initia-testnet');
  });

  it('rejects bad amount_iusd format', () => {
    const r = tool.schema.safeParse({
      action: 'quote',
      amount_iusd: 'not-a-number',
      dest_chain: 'initia-testnet',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a happy-path execute payload', () => {
    const r = tool.schema.safeParse({
      action: 'execute',
      amount_iusd: '0.5',
      source_chain: 'base-sepolia',
      dest_chain: 'initia-testnet',
    });
    expect(r.success).toBe(true);
  });
});

// ─── Stellar off-ramp (MoneyGram via n-payment v0.30) ────────────────────────
describe('stellar_off_ramp — schema', () => {
  const tool = TOOL_BY_NAME.stellar_off_ramp!;

  it('is registered exactly once', () => {
    expect(tool).toBeDefined();
    expect(TOOL_NAMES.filter((n) => n === 'stellar_off_ramp')).toHaveLength(1);
  });

  it('defaults chain to stellar-testnet + asset USDC + fiat USD', () => {
    const r = tool.schema.safeParse({ action: 'corridors' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.chain).toBe('stellar-testnet');
      expect(r.data.asset).toBe('USDC');
      expect(r.data.fiat).toBe('USD');
      expect(r.data.timeout_ms).toBe(12_000);
    }
  });

  it('rejects quote / cash_out / b2b_payout without amount', () => {
    for (const action of ['quote', 'cash_out', 'b2b_payout'] as const) {
      expect(tool.schema.safeParse({ action }).success).toBe(false);
    }
  });

  it('rejects status without handle_id', () => {
    expect(tool.schema.safeParse({ action: 'status' }).success).toBe(false);
    expect(tool.schema.safeParse({ action: 'status', handle_id: 'txn-1' }).success).toBe(true);
  });

  it('rejects non-Stellar chains', () => {
    expect(tool.schema.safeParse({ action: 'corridors', chain: 'base-sepolia' }).success).toBe(false);
  });

  it('rejects malformed amount (non-decimal)', () => {
    expect(tool.schema.safeParse({ action: 'quote', amount: 'abc' }).success).toBe(false);
    expect(tool.schema.safeParse({ action: 'quote', amount: '10.5' }).success).toBe(true);
  });
});

describe('stellar_off_ramp — handler', () => {
  const ctx = {
    walletName: 'test-wallet',
    defaultChain: 'stellar-testnet' as const,
    testnetMode: true,
    env: {} as NodeJS.ProcessEnv,
  };

  // Mock stellarAgentKit — capture calls and return canned payloads.
  const corridorsMock = vi.fn();
  const quoteMock = vi.fn();
  const cashOutMock = vi.fn();
  const b2bMock = vi.fn();
  const statusMock = vi.fn();
  const kitFactoryMock = vi.fn(() => ({
    corridors: corridorsMock,
    quote: quoteMock,
    cashOut: cashOutMock,
    b2bPayout: b2bMock,
    status: statusMock,
  }));
  const registryAdded: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    const np = await import('n-payment');
    (np.DefaultAnchorRegistry as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      add: (a: Record<string, unknown>) => {
        registryAdded.push(a);
      },
    }));
    (np.StellarWallet as unknown as ReturnType<typeof vi.fn>).mockImplementation((opts: { secretKey: string }) => ({
      secretKey: opts.secretKey,
    }));
    (np.stellarAgentKit as unknown as ReturnType<typeof vi.fn>).mockImplementation(kitFactoryMock);
    kitFactoryMock.mockClear();
    corridorsMock.mockReset();
    quoteMock.mockReset();
    cashOutMock.mockReset();
    b2bMock.mockReset();
    statusMock.mockReset();
    registryAdded.length = 0;
  });

  it('action=corridors on testnet returns SDK payload verbatim', async () => {
    corridorsMock.mockResolvedValue([{ homeDomain: 'testanchor.stellar.org' }]);
    const { stellar_off_ramp } = await import('../src/handlers.js');
    const r = await stellar_off_ramp({ action: 'corridors', chain: 'stellar-testnet' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([{ homeDomain: 'testanchor.stellar.org' }]);
    // Registry auto-registered SDF test anchor.
    expect(registryAdded[0]!.homeDomain).toBe('testanchor.stellar.org');
    // isMainnet=false on testnet path.
    expect(kitFactoryMock.mock.calls[0]![1].isMainnet).toBe(false);
  });

  it('action=cash_out on stellar-mainnet returns MAINNET_GUARD before SDK is loaded', async () => {
    const { stellar_off_ramp } = await import('../src/handlers.js');
    const r = await stellar_off_ramp(
      { action: 'cash_out', chain: 'stellar-mainnet', amount: '10' },
      { ...ctx, testnetMode: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('MAINNET_GUARD');
    expect(kitFactoryMock).not.toHaveBeenCalled();
  });

  it('action=cash_out on stellar-mainnet without STELLAR_OZ_API_KEY returns STELLAR_OZ_KEY_MISSING', async () => {
    const { stellar_off_ramp } = await import('../src/handlers.js');
    const r = await stellar_off_ramp(
      { action: 'cash_out', chain: 'stellar-mainnet', amount: '10' },
      { ...ctx, testnetMode: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('STELLAR_OZ_KEY_MISSING');
    expect(kitFactoryMock).not.toHaveBeenCalled();
  });

  it('action=quote forwards amount/asset/fiat/country 1:1 to the SDK', async () => {
    quoteMock.mockResolvedValue({ quoteId: 'q-1', rate: '1.00', feeFixed: '0.10' });
    const { stellar_off_ramp } = await import('../src/handlers.js');
    const r = await stellar_off_ramp(
      { action: 'quote', chain: 'stellar-testnet', amount: '10', country: 'US' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(quoteMock).toHaveBeenCalledWith({
      amount: '10',
      asset: 'USDC',
      fiat: 'USD',
      country: 'US',
    });
  });

  it('action=cash_out strips SDK-handle functions before returning', async () => {
    cashOutMock.mockResolvedValue({
      id: 'txn-42',
      moreInfoUrl: 'https://testanchor.stellar.org/sep24/…',
      status: () => Promise.resolve('pending'),
    });
    const { stellar_off_ramp } = await import('../src/handlers.js');
    const r = await stellar_off_ramp(
      { action: 'cash_out', chain: 'stellar-testnet', amount: '10' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as Record<string, unknown>;
      expect(data.id).toBe('txn-42');
      expect(data.moreInfoUrl).toContain('testanchor.stellar.org');
      expect(data.status).toBeUndefined(); // function stripped for JSON safety
    }
  });

  it('action=b2b_payout forwards receiver_id + quote_id + fields to SDK', async () => {
    b2bMock.mockResolvedValue({ id: 't-99', receiverInfoUrl: null });
    const { stellar_off_ramp } = await import('../src/handlers.js');
    await stellar_off_ramp(
      {
        action: 'b2b_payout',
        chain: 'stellar-testnet',
        amount: '50',
        country: 'US',
        receiver_id: 'rcv-1',
        quote_id: 'q-1',
        receiver_fields: { first_name: 'Alice' },
      },
      ctx,
    );
    expect(b2bMock).toHaveBeenCalledWith({
      amount: '50',
      asset: 'USDC',
      fiat: 'USD',
      country: 'US',
      receiverId: 'rcv-1',
      quoteId: 'q-1',
      fields: { first_name: 'Alice' },
    });
  });
});

// ─── Stellar MPP payment channels ────────────────────────────────────────────
describe('stellar_session — schema', () => {
  const tool = TOOL_BY_NAME.stellar_session!;

  it('is registered exactly once', () => {
    expect(tool).toBeDefined();
    expect(TOOL_NAMES.filter((n) => n === 'stellar_session')).toHaveLength(1);
  });

  it('open requires provider (G-address) + budget_micros', () => {
    expect(tool.schema.safeParse({ action: 'open' }).success).toBe(false);
    expect(tool.schema.safeParse({ action: 'open', provider: 'GA'.padEnd(56, 'A'), budget_micros: 1_000_000 }).success).toBe(true);
    // non-Stellar provider is rejected
    expect(tool.schema.safeParse({ action: 'open', provider: '0xdeadbeef', budget_micros: 1_000_000 }).success).toBe(false);
  });

  it('commit requires session_id + amount_micros', () => {
    expect(tool.schema.safeParse({ action: 'commit' }).success).toBe(false);
    expect(tool.schema.safeParse({ action: 'commit', session_id: 's-1', amount_micros: 1000 }).success).toBe(true);
  });

  it('close / status require only session_id', () => {
    expect(tool.schema.safeParse({ action: 'close' }).success).toBe(false);
    expect(tool.schema.safeParse({ action: 'close', session_id: 's-1' }).success).toBe(true);
    expect(tool.schema.safeParse({ action: 'status', session_id: 's-1' }).success).toBe(true);
  });
});

describe('stellar_session — statelessness (no module-level Map)', () => {
  const ctx = {
    walletName: 'test-wallet',
    defaultChain: 'stellar-testnet' as const,
    testnetMode: true,
    env: {} as NodeJS.ProcessEnv,
  };

  const openMock = vi.fn();
  const commitMock = vi.fn();
  const closeMock = vi.fn();
  const sessionsMock = { open: openMock, commit: commitMock, close: closeMock, status: vi.fn() };
  const createStellarSessionMock = vi.fn(() => sessionsMock);
  const clientMock = { createStellarSession: createStellarSessionMock };
  const createPaymentClientMock = vi.fn(() => clientMock);

  beforeEach(async () => {
    const np = await import('n-payment');
    (np.createPaymentClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(createPaymentClientMock);
    createPaymentClientMock.mockClear();
    createStellarSessionMock.mockClear();
    openMock.mockReset();
    commitMock.mockReset();
    closeMock.mockReset();
  });

  it('commit forwards caller-supplied session_id + prev_commitment (stateless)', async () => {
    commitMock.mockResolvedValue({ commitment: '0xdead', cumulative: 1000 });
    const { stellar_session } = await import('../src/handlers.js');
    const r = await stellar_session(
      {
        action: 'commit',
        chain: 'stellar-testnet',
        session_id: 'sess-abc',
        amount_micros: 1000,
        prev_commitment: '0xbeef',
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(commitMock).toHaveBeenCalledWith({
      sessionId: 'sess-abc',
      amountMicros: 1000,
      prevCommitment: '0xbeef',
    });
  });

  it('source file contains ZERO module-level Map instances inside stellar_session (anti-mistake invariant)', async () => {
    // Read handlers.ts and assert the stellar_session block does not
    // create a module-level Map — a repeat of the stellar_escrow mistake
    // would cause memory leaks + break multi-tenant MCP HTTP hosts.
    const src = readFileSync(
      new URL('../src/handlers.ts', import.meta.url),
      'utf8',
    );
    const idx = src.indexOf('export const stellar_session');
    expect(idx).toBeGreaterThan(0);
    // Look at everything from the export up to the next top-level export.
    const nextExport = src.indexOf('\nexport const ', idx + 1);
    const block = src.slice(idx, nextExport > 0 ? nextExport : src.length);
    expect(block).not.toMatch(/new Map\s*[<(]/);
    expect(block).not.toMatch(/^\s*const _sess\w* = new Map/m);
  });

  it('open on mainnet + testnetMode=true short-circuits to MAINNET_GUARD', async () => {
    const { stellar_session } = await import('../src/handlers.js');
    const r = await stellar_session(
      {
        action: 'open',
        chain: 'stellar-mainnet',
        provider: 'G' + 'A'.repeat(55),
        budget_micros: 1_000_000,
      },
      { ...ctx, testnetMode: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('MAINNET_GUARD');
    expect(createPaymentClientMock).not.toHaveBeenCalled();
  });
});

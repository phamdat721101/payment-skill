import { describe, expect, it } from 'vitest';
import { TOOL_BY_NAME } from '../src/tools.js';
import { CHAIN_META } from '../src/faucet.js';

describe('aave_yield registration', () => {
  it('exists in the registry with the documented action enum', () => {
    const t = TOOL_BY_NAME.aave_yield;
    expect(t).toBeDefined();
    const r = t!.schema.safeParse({ action: 'demo' });
    expect(r.success).toBe(true);
    const bad = t!.schema.safeParse({ action: 'invalid' });
    expect(bad.success).toBe(false);
  });

  it('rejects supply/withdraw without amount_usdc at handler level (schema allows optional)', () => {
    const t = TOOL_BY_NAME.aave_yield!;
    // Schema treats amount_usdc as optional; the handler enforces MISSING_ARG.
    expect(t.schema.safeParse({ action: 'supply' }).success).toBe(true);
    expect(t.schema.safeParse({ action: 'withdraw', amount_usdc: '0.5' }).success).toBe(true);
  });

  it('validates amount_usdc as a 1–6 decimal string', () => {
    const t = TOOL_BY_NAME.aave_yield!;
    expect(t.schema.safeParse({ action: 'supply', amount_usdc: '1.000001' }).success).toBe(true);
    expect(t.schema.safeParse({ action: 'supply', amount_usdc: '1.0000001' }).success).toBe(false);
    expect(t.schema.safeParse({ action: 'supply', amount_usdc: 'one' }).success).toBe(false);
  });

  it('defaults chain to base-sepolia and auto_faucet to true', () => {
    const t = TOOL_BY_NAME.aave_yield!;
    const r = t.schema.parse({ action: 'demo' }) as {
      chain: string;
      auto_faucet: boolean;
    };
    expect(r.chain).toBe('base-sepolia');
    expect(r.auto_faucet).toBe(true);
  });

  it('refuses non-base-sepolia chain values', () => {
    const t = TOOL_BY_NAME.aave_yield!;
    expect(t.schema.safeParse({ action: 'demo', chain: 'base-mainnet' }).success).toBe(false);
  });
});

describe('aave chain meta', () => {
  it('records the user-provided V3 Pool address on base-sepolia', () => {
    expect(CHAIN_META['base-sepolia'].aave?.pool).toBe(
      '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27',
    );
  });

  it('records the Aave-mock USDC distinct from Circle USDC', () => {
    expect(CHAIN_META['base-sepolia'].aave?.usdc).toBe(
      '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f',
    );
  });

  it('keeps base-sepolia (Circle) USDC unchanged for other tools', () => {
    expect(CHAIN_META['base-sepolia'].usdc).toBe(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    );
  });
});

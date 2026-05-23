import { describe, expect, it } from 'vitest';
import { TOOLS, TOOL_BY_NAME, TOOL_NAMES, Chain, CHAIN_KEYS } from '../src/tools.js';

describe('tool registry', () => {
  it('exposes exactly 39 tools', () => {
    expect(TOOLS).toHaveLength(39);
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

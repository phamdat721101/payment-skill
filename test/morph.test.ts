// Reference-Key helpers live inline in `src/handlers.ts` (the only Morph
// surface the SDK doesn't already expose). HMAC signing, MorphX402Client, and
// MorphX402Adapter are tested upstream in `n-payment` — we don't duplicate.
//
// The unified `morph_pay` handler is exercised by `test/handlers-morph.test.ts`
// (added in the same change set).

import { describe, expect, it, vi } from 'vitest';
import {
  attachReferenceKey,
  morph_pay,
  queryReferenceKey,
} from '../src/handlers.js';
import type { ToolContext } from '../src/tools.js';

const ctx = (env: Record<string, string> = {}): ToolContext => ({
  walletName: 'test',
  defaultChain: 'base-sepolia',
  testnetMode: true,
  env: { ...process.env, ...env },
});

describe('attachReferenceKey', () => {
  it('encodes UTF-8 bytes as 0x-prefixed hex', () => {
    expect(attachReferenceKey('ORD-1')).toBe('0x4f52442d31');
  });

  it('caps at 32 bytes (one event topic)', () => {
    const long = 'A'.repeat(64);
    const out = attachReferenceKey(long);
    expect(out).toHaveLength(2 + 32 * 2); // '0x' + 32 hex bytes
  });

  it('throws on empty input — caller bug, fail loud', () => {
    expect(() => attachReferenceKey('')).toThrow(/non-empty/);
  });
});

describe('queryReferenceKey', () => {
  const REF = 'ORD-2026-001';

  it('returns parsed JSON on 200', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reference: REF, txHash: '0xabc' }),
    });
    const out = await queryReferenceKey(REF, fetchFn as never);
    expect(out).toEqual({ reference: REF, txHash: '0xabc' });
    expect(fetchFn).toHaveBeenCalledWith(
      `https://morph-rails.morph.network/v1/reference-keys/${REF}`,
    );
  });

  it('throws REFERENCE_KEY_NOT_FOUND on 404 with a stable code', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(
      queryReferenceKey(REF, fetchFn as never),
    ).rejects.toMatchObject({ code: 'REFERENCE_KEY_NOT_FOUND' });
  });

  it('bubbles other failures with the upstream status code', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(queryReferenceKey(REF, fetchFn as never)).rejects.toThrow(
      /503/,
    );
  });

  it('URL-encodes references with reserved characters', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    await queryReferenceKey('ORD/2026?001', fetchFn as never);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://morph-rails.morph.network/v1/reference-keys/ORD%2F2026%3F001',
    );
  });
});


describe('morph_pay handler — routing', () => {
  it('mode="reference-attach" returns hex calldata', async () => {
    const res = await morph_pay({ mode: 'reference-attach', reference: 'ORD-1' }, ctx());
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { calldata: string }).calldata).toBe('0x4f52442d31');
  });

  it('mode="reference-attach" without reference fails BAD_INPUT', async () => {
    const res = await morph_pay({ mode: 'reference-attach' }, ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BAD_INPUT');
  });

  it('mode="passkey" returns the stable not-implemented code', async () => {
    const res = await morph_pay({ mode: 'passkey' }, ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MORPH_PASSKEY_NOT_IMPLEMENTED');
  });

  it('mode="altfee" returns the stable not-implemented code', async () => {
    const res = await morph_pay(
      { mode: 'altfee', url: 'https://example.com', facilitator_url: 'http://localhost:4040/x402' },
      ctx(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MORPH_ALTFEE_NOT_IMPLEMENTED');
  });

  it('mode="x402" on Hoodi without facilitator URL returns actionable hint', async () => {
    const res = await morph_pay(
      { mode: 'x402', url: 'https://example.com', chain: 'morph-hoodi-testnet' },
      ctx(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('MORPH_HOODI_FACILITATOR_MISSING');
  });

  it('mode="x402" without url fails BAD_INPUT', async () => {
    const res = await morph_pay({ mode: 'x402' }, ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BAD_INPUT');
  });
});

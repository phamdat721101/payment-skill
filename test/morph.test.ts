import { describe, expect, it, vi } from 'vitest';
import {
  attachReferenceKey,
  MorphFacilitatorError,
  MorphX402Client,
  queryReferenceKey,
  ReferenceKeyNotFound,
  sign,
  sortObject,
} from '../src/morph.js';

const CREDS = { accessKey: 'morph_ak_test', secretKey: 'morph_sk_test' };

describe('sortObject', () => {
  it('sorts keys recursively in nested objects', () => {
    const out = sortObject({ z: 1, a: { y: 2, b: { d: 4, c: 3 } } });
    expect(JSON.stringify(out)).toBe('{"a":{"b":{"c":3,"d":4},"y":2},"z":1}');
  });

  it('preserves array order, sorts inside array elements', () => {
    const out = sortObject([{ b: 1, a: 2 }, { d: 3, c: 4 }]);
    expect(JSON.stringify(out)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });
});

describe('sign', () => {
  it('produces a deterministic base64 HMAC-SHA256 string of length 44', () => {
    const out = sign({
      ...CREDS,
      timestamp: '1738056600000',
      method: 'POST',
      path: '/x402/v2/settle',
      rawBody: '{"x402Version":2}',
    });
    expect(out).toHaveLength(44);
    expect(out).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('is deterministic — same inputs ⇒ same signature', () => {
    const args = {
      ...CREDS,
      timestamp: '1738056600000',
      method: 'POST',
      path: '/x402/v2/verify',
      rawBody: '{"x402Version":2,"paymentPayload":{"a":1}}',
    };
    expect(sign(args)).toBe(sign(args));
  });

  it('changes when the body changes', () => {
    const a = sign({ ...CREDS, timestamp: '1', method: 'POST', path: '/x', rawBody: '{"a":1}' });
    const b = sign({ ...CREDS, timestamp: '1', method: 'POST', path: '/x', rawBody: '{"a":2}' });
    expect(a).not.toBe(b);
  });
});

describe('MorphX402Client', () => {
  const FAC = 'https://morph-rails.morph.network/x402';

  it('settle() POSTs to /v2/settle with all three HMAC headers', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, transaction: '0xdeadbeef' }),
    });
    const client = new MorphX402Client({ ...CREDS, fetchFn: fetchFn as never });
    const res = await client.settle({ payer: '0x1' }, { network: 'eip155:2818' });
    expect((res as { transaction: string }).transaction).toBe('0xdeadbeef');

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${FAC}/v2/settle`);
    expect(init.method).toBe('POST');
    expect(init.headers['MORPH-ACCESS-KEY']).toBe(CREDS.accessKey);
    expect(init.headers['MORPH-ACCESS-TIMESTAMP']).toMatch(/^\d{13}$/);
    expect(init.headers['MORPH-ACCESS-SIGN']).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('verify() POSTs to /v2/verify and returns parsed JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ isValid: true, payer: '0x1' }),
    });
    const client = new MorphX402Client({ ...CREDS, fetchFn: fetchFn as never });
    const res = await client.verify({}, {});
    expect((res as { isValid: boolean }).isValid).toBe(true);
    expect(fetchFn.mock.calls[0]![0]).toBe(`${FAC}/v2/verify`);
  });

  it('supported() does not send auth headers', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kinds: [] }),
    });
    const client = new MorphX402Client({ ...CREDS, fetchFn: fetchFn as never });
    await client.supported();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${FAC}/v2/supported`);
    expect(init).toBeUndefined();
  });

  it('throws MorphFacilitatorError with MORPH_AUTH on 401', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid signature',
    });
    const client = new MorphX402Client({ ...CREDS, fetchFn: fetchFn as never });
    await expect(client.settle({}, {})).rejects.toMatchObject({
      code: 'MORPH_AUTH',
      status: 401,
    });
  });

  it('throws MorphFacilitatorError with MORPH_RATE_LIMITED on 429', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limit exceeded',
    });
    const client = new MorphX402Client({ ...CREDS, fetchFn: fetchFn as never });
    const err = await client.settle({}, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MorphFacilitatorError);
    expect((err as MorphFacilitatorError).code).toBe('MORPH_RATE_LIMITED');
  });
});

describe('attachReferenceKey', () => {
  it('encodes the reference as 0x-prefixed UTF-8 hex', () => {
    expect(attachReferenceKey('ORD-2026-001')).toBe('0x4f52442d323032362d303031');
  });

  it('truncates to 32 bytes', () => {
    const long = 'A'.repeat(64);
    const out = attachReferenceKey(long);
    // 0x + 32 bytes * 2 hex chars
    expect(out).toHaveLength(2 + 64);
  });

  it('rejects an empty reference', () => {
    expect(() => attachReferenceKey('')).toThrow(/non-empty/);
  });
});

describe('queryReferenceKey', () => {
  it('returns the parsed record on 200', async () => {
    const record = { reference: 'ORD-2026-001', tx: '0xabc' };
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => record,
    });
    const out = await queryReferenceKey('ORD-2026-001', fetchFn as never);
    expect(out).toEqual(record);
    expect(fetchFn.mock.calls[0]![0]).toContain('/v1/reference-keys/ORD-2026-001');
  });

  it('throws ReferenceKeyNotFound on 404', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const err = await queryReferenceKey('missing', fetchFn as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReferenceKeyNotFound);
    expect((err as ReferenceKeyNotFound).code).toBe('REFERENCE_KEY_NOT_FOUND');
  });
});

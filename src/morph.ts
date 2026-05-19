// Morph Network adapter: HMAC signing, x402 Facilitator client, Reference Key
// helpers, and STUB tracking URLs for not-yet-shipped tools.
//
// All Morph-specific logic lives in this single module so the rest of the
// skill stays chain-agnostic. Pure helpers are exported for direct testing;
// stateful logic is encapsulated in MorphX402Client.

import { createHmac } from 'node:crypto';

// ─── Public constants ────────────────────────────────────────────────────────
export const MORPH_X402_BASE_URL = 'https://morph-rails.morph.network/x402';
export const MORPH_RAILS_BASE_URL = 'https://morph-rails.morph.network';

/** Tracks upstream n-payment SDK support for Morph AltFee Type-0x7F txns. */
export const MORPH_ALTFEE_TRACKING_URL =
  'https://github.com/phamdat721101/n-payment/issues?q=morph+altfee';

/** Tracks upstream n-payment SDK support for Morph Passkey payments. */
export const MORPH_PASSKEY_TRACKING_URL =
  'https://github.com/phamdat721101/n-payment/issues?q=morph+passkey';

// ─── HMAC signing (pure) ─────────────────────────────────────────────────────
/** Recursively sort object keys so JSON.stringify produces a deterministic blob. */
export function sortObject<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(sortObject) as unknown as T;
  if (obj && typeof obj === 'object') {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortObject((obj as Record<string, unknown>)[k]);
        return acc;
      }, {}) as unknown as T;
  }
  return obj;
}

interface SignArgs {
  accessKey: string;
  secretKey: string;
  timestamp: string;
  method: string;
  path: string;
  rawQuery?: string;
  rawBody?: string;
}

/**
 * Build the deterministic sign content per Morph spec, then HMAC-SHA256 it
 * with the secret key and base64-encode. See:
 * https://docs.morph.network/docs/morph-rails/agentic-payment/x402-facilitator
 */
export function sign(args: SignArgs): string {
  const map: Record<string, unknown> = {
    'MORPH-ACCESS-KEY': args.accessKey,
    'MORPH-ACCESS-TIMESTAMP': args.timestamp,
    'MORPH-ACCESS-METHOD': args.method.toUpperCase(),
    'MORPH-ACCESS-PATH': args.path,
  };
  if (args.rawQuery) {
    for (const [k, v] of new URLSearchParams(args.rawQuery)) {
      const cur = map[k] as string[] | undefined;
      map[k] = cur ? [...cur, v] : [v];
    }
  }
  if (args.rawBody) {
    map['MORPH-ACCESS-BODY'] = JSON.parse(args.rawBody);
  }
  const content = JSON.stringify(sortObject(map));
  return createHmac('sha256', args.secretKey).update(content).digest('base64');
}

// ─── x402 Facilitator client ─────────────────────────────────────────────────
export interface MorphCreds {
  accessKey: string;
  secretKey: string;
}

export interface MorphX402ClientOptions extends MorphCreds {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Thin client over Morph's x402 Facilitator. One responsibility: sign + POST
 * verify/settle with the three required HMAC headers.
 */
export class MorphX402Client {
  readonly #creds: MorphCreds;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: MorphX402ClientOptions) {
    this.#creds = { accessKey: opts.accessKey, secretKey: opts.secretKey };
    this.#baseUrl = opts.baseUrl ?? MORPH_X402_BASE_URL;
    this.#fetch = opts.fetchFn ?? fetch;
  }

  verify(payload: unknown, requirements: unknown): Promise<unknown> {
    return this.#post('/v2/verify', { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
  }

  settle(payload: unknown, requirements: unknown): Promise<unknown> {
    return this.#post('/v2/settle', { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
  }

  /** Public endpoint, no auth. */
  async supported(): Promise<unknown> {
    const url = `${this.#baseUrl}/v2/supported`;
    const res = await this.#fetch(url);
    if (!res.ok) throw new MorphFacilitatorError(`/v2/supported returned ${res.status}`, res.status);
    return res.json();
  }

  async #post(endpoint: string, body: unknown): Promise<unknown> {
    const path = new URL(this.#baseUrl).pathname.replace(/\/$/, '') + endpoint;
    const url = `${this.#baseUrl}${endpoint}`;
    const rawBody = JSON.stringify(body);
    const timestamp = Date.now().toString();
    const signature = sign({
      ...this.#creds,
      timestamp,
      method: 'POST',
      path,
      rawBody,
    });
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MORPH-ACCESS-KEY': this.#creds.accessKey,
        'MORPH-ACCESS-TIMESTAMP': timestamp,
        'MORPH-ACCESS-SIGN': signature,
      },
      body: rawBody,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new MorphFacilitatorError(`${endpoint} returned ${res.status}: ${detail}`, res.status);
    }
    return res.json();
  }
}

export class MorphFacilitatorError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.code =
      status === 401 ? 'MORPH_AUTH'
      : status === 403 ? 'MORPH_AUTH'
      : status === 429 ? 'MORPH_RATE_LIMITED'
      : 'MORPH_FACILITATOR_ERROR';
  }
}

// ─── Reference Key (functional) ──────────────────────────────────────────────
/**
 * Encode a reference key as a calldata suffix the merchant can append to the
 * data field of any tx. UTF-8 bytes, capped at 32 to fit a typical event
 * topic. Returns 0x-prefixed hex with no padding.
 */
export function attachReferenceKey(reference: string): string {
  if (!reference) throw new Error('reference must be non-empty');
  const bytes = Buffer.from(reference, 'utf8').subarray(0, 32);
  return '0x' + bytes.toString('hex');
}

/**
 * Look up a reference key via the Morph Rails REST API. Returns the parsed
 * payload on 200, throws ReferenceKeyNotFound on 404 (so callers can surface
 * REFERENCE_KEY_NOT_FOUND) and bubbles other failures.
 */
export async function queryReferenceKey(
  reference: string,
  fetchFn: typeof fetch = fetch,
  baseUrl: string = MORPH_RAILS_BASE_URL,
): Promise<unknown> {
  const url = `${baseUrl}/v1/reference-keys/${encodeURIComponent(reference)}`;
  const res = await fetchFn(url);
  if (res.status === 404) throw new ReferenceKeyNotFound(reference);
  if (!res.ok) throw new Error(`Morph Rails returned ${res.status} for ${reference}`);
  return res.json();
}

export class ReferenceKeyNotFound extends Error {
  readonly reference: string;
  readonly code = 'REFERENCE_KEY_NOT_FOUND';
  constructor(reference: string) {
    super(`Reference key not found: ${reference}`);
    this.reference = reference;
  }
}

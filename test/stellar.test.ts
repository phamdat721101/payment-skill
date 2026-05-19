import { describe, expect, it, vi } from 'vitest';
import {
  base32Encode,
  buildStellarPaymentUri,
  crc16,
  deriveStellarKeypair,
  fetchStellarBalance,
  isStellarConfigError,
  pickStellarConfig,
} from '../src/stellar.js';

const SAMPLE_PRIV =
  '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describe('base32Encode', () => {
  it('encodes RFC 4648 vectors without padding', () => {
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
  });
});

describe('crc16 (XMODEM-CCITT)', () => {
  it('matches the canonical test vector for "123456789"', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x31c3);
  });
});

describe('deriveStellarKeypair', () => {
  it('returns a valid G-public + S-secret strkey pair', () => {
    const kp = deriveStellarKeypair(SAMPLE_PRIV);
    expect(kp.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(kp.secretKey).toMatch(/^S[A-Z2-7]{55}$/);
  });

  it('is deterministic for the same seed', () => {
    expect(deriveStellarKeypair(SAMPLE_PRIV)).toEqual(deriveStellarKeypair(SAMPLE_PRIV));
  });

  it('produces different addresses for different seeds', () => {
    const a = deriveStellarKeypair(SAMPLE_PRIV);
    const b = deriveStellarKeypair('0x' + 'aa'.repeat(32));
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('rejects too-short seeds', () => {
    expect(() => deriveStellarKeypair('0x1234')).toThrow(/at least 32/);
  });
});

describe('pickStellarConfig', () => {
  const baseEnv = {} as NodeJS.ProcessEnv;

  it('derives secret + public from wallet when env var absent (testnet)', () => {
    const cfg = pickStellarConfig(baseEnv, SAMPLE_PRIV, 'stellar-testnet');
    expect(isStellarConfigError(cfg)).toBe(false);
    if (!isStellarConfigError(cfg)) {
      expect(cfg.secretKey).toMatch(/^S[A-Z2-7]{55}$/);
      expect(cfg.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
      expect(cfg.channelsApiKey).toBeUndefined();
    }
  });

  it('prefers STELLAR_SECRET_KEY env var when present and valid', () => {
    const env = {
      STELLAR_SECRET_KEY: 'S' + 'A'.repeat(55),
    } as NodeJS.ProcessEnv;
    const cfg = pickStellarConfig(env, SAMPLE_PRIV, 'stellar-testnet');
    if (!isStellarConfigError(cfg)) {
      expect(cfg.secretKey).toBe('S' + 'A'.repeat(55));
    }
  });

  it('returns STELLAR_OZ_KEY_MISSING on mainnet without OZ key', () => {
    const cfg = pickStellarConfig(baseEnv, SAMPLE_PRIV, 'stellar-mainnet');
    expect(isStellarConfigError(cfg)).toBe(true);
    if (isStellarConfigError(cfg)) {
      expect(cfg.code).toBe('STELLAR_OZ_KEY_MISSING');
    }
  });

  it('passes through STELLAR_OZ_API_KEY on mainnet', () => {
    const env = { STELLAR_OZ_API_KEY: 'oz_test_123' } as NodeJS.ProcessEnv;
    const cfg = pickStellarConfig(env, SAMPLE_PRIV, 'stellar-mainnet');
    if (!isStellarConfigError(cfg)) {
      expect(cfg.channelsApiKey).toBe('oz_test_123');
    }
  });
});

describe('fetchStellarBalance', () => {
  const ACCOUNT = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  it('parses native + USDC balance from Horizon JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            balance: '12.3456789',
          },
          { asset_type: 'native', balance: '100.0000000' },
        ],
      }),
    });
    const r = await fetchStellarBalance(ACCOUNT, 'stellar-mainnet', fetchFn as never);
    expect(r.native).toBe('100.0000000');
    expect(r.usdc).toBe('12.3456789');
    expect(fetchFn.mock.calls[0]![0]).toBe(`https://horizon.stellar.org/accounts/${ACCOUNT}`);
  });

  it('graceful-degrades to zero on 404 (un-funded account)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const r = await fetchStellarBalance(ACCOUNT, 'stellar-testnet', fetchFn as never);
    expect(r).toEqual({ native: '0', usdc: '0' });
  });

  it('throws on a non-Stellar chain', async () => {
    await expect(fetchStellarBalance(ACCOUNT, 'base-mainnet', vi.fn() as never)).rejects.toThrow(
      /not a Stellar/,
    );
  });
});

describe('buildStellarPaymentUri (SEP-7)', () => {
  const G = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  it('emits a web+stellar:pay URI with destination + amount', () => {
    const uri = buildStellarPaymentUri({ destination: G, amount: '5.00' });
    expect(uri).toBe(`web+stellar:pay?destination=${G}&amount=5.00`);
  });

  it('includes asset + memo when supplied', () => {
    const uri = buildStellarPaymentUri({
      destination: G,
      amount: '0.01',
      assetCode: 'USDC',
      assetIssuer: G,
      memo: 'ORD-2026-001',
    });
    expect(uri).toContain('asset_code=USDC');
    expect(uri).toContain(`asset_issuer=${G}`);
    expect(uri).toContain('memo=ORD-2026-001');
    expect(uri).toContain('memo_type=MEMO_TEXT');
  });

  it('rejects a non-Stellar destination', () => {
    expect(() =>
      buildStellarPaymentUri({ destination: '0xdeadbeef', amount: '1' }),
    ).toThrow(/G-address/);
  });
});

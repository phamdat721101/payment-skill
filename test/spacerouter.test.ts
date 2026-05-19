import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_BY_NAME } from '../src/tools.js';
import {
  CREDITCOIN_CHAIN_ID,
  formatSpaceWei,
  getSpaceRouterWallet,
  parseSpaceWei,
  pickSpaceRouterConfig,
  SR_GATEWAY_MGMT_URL,
  SR_GATEWAY_URL,
  SPACE_DECIMALS,
  SPACE_TOKEN_ADDRESS,
  SpaceRouterClient,
  SpaceRouterError,
  TOKEN_PAYMENT_ESCROW_ABI,
  TOKEN_PAYMENT_ESCROW_ADDRESS,
} from '../src/spacerouter.js';

// ─── Pure decimal helpers ────────────────────────────────────────────────────
describe('parseSpaceWei / formatSpaceWei', () => {
  it('round-trips integers and fractional SPACE amounts', () => {
    expect(parseSpaceWei('1')).toBe(10n ** 18n);
    expect(parseSpaceWei('0.5')).toBe(5n * 10n ** 17n);
    expect(formatSpaceWei(10n ** 18n)).toBe('1');
    expect(formatSpaceWei(5n * 10n ** 17n)).toBe('0.5');
  });

  it('SPACE uses 18 decimals (matches Creditcoin docs)', () => {
    expect(SPACE_DECIMALS).toBe(18);
  });
});

// ─── Wallet auto-create ──────────────────────────────────────────────────────
describe('getSpaceRouterWallet', () => {
  it('creates a dedicated wallet file at $HOME/.n-payment/wallets/spacerouter.json on first call', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sr-wallet-'));
    const w = await getSpaceRouterWallet(home);
    expect(w.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(w.privateKey).toMatch(/^0x[a-fA-F0-9]{64}$/);
    const file = join(home, '.n-payment', 'wallets', 'spacerouter.json');
    expect(existsSync(file)).toBe(true);
    // POSIX systems only — chmod 0600 expected.
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });

  it('is idempotent — second call returns the same wallet record', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sr-wallet-'));
    const a = await getSpaceRouterWallet(home);
    const b = await getSpaceRouterWallet(home);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it('does NOT touch the default agent wallet (isolation)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sr-wallet-'));
    await getSpaceRouterWallet(home);
    const defaultFile = join(home, '.n-payment', 'wallets', 'default.json');
    expect(existsSync(defaultFile)).toBe(false);
    const file = join(home, '.n-payment', 'wallets', 'spacerouter.json');
    const r = JSON.parse(readFileSync(file, 'utf8'));
    expect(r.name).toBe('spacerouter');
  });
});

// ─── Config picker precedence ────────────────────────────────────────────────
describe('pickSpaceRouterConfig', () => {
  const PK = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

  it('falls back to defaults when env is empty', () => {
    const cfg = pickSpaceRouterConfig({}, PK);
    expect(cfg.gatewayUrl).toBe(SR_GATEWAY_URL);
    expect(cfg.gatewayMgmtUrl).toBe(SR_GATEWAY_MGMT_URL);
    expect(cfg.escrowAddress).toBe(TOKEN_PAYMENT_ESCROW_ADDRESS);
    expect(cfg.escrowPrivateKey).toBe(PK);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.region).toBeUndefined();
    expect(cfg.ipType).toBeUndefined();
  });

  it('respects env overrides for every supported variable', () => {
    const env = {
      SR_GATEWAY_URL: 'https://gw.example/proxy',
      SR_GATEWAY_MANAGEMENT_URL: 'https://gw.example:8081',
      SR_ESCROW_CONTRACT_ADDRESS: '0x' + '11'.repeat(20),
      SR_ESCROW_PRIVATE_KEY: '0x' + 'cd'.repeat(32),
      SR_ESCROW_CHAIN_RPC: 'https://rpc.example',
      SR_REGION: 'KR',
      SR_IP_TYPE: 'mobile',
      SR_ADMIN_URL: 'http://localhost:8000',
    } as NodeJS.ProcessEnv;
    const cfg = pickSpaceRouterConfig(env, PK);
    expect(cfg.gatewayUrl).toBe('https://gw.example/proxy');
    expect(cfg.gatewayMgmtUrl).toBe('https://gw.example:8081');
    expect(cfg.escrowAddress).toBe('0x' + '11'.repeat(20));
    expect(cfg.escrowPrivateKey).toBe('0x' + 'cd'.repeat(32));
    expect(cfg.rpcUrl).toBe('https://rpc.example');
    expect(cfg.region).toBe('KR');
    expect(cfg.ipType).toBe('mobile');
    expect(cfg.adminUrl).toBe('http://localhost:8000');
  });

  it('lets explicit opts override env for routing knobs', () => {
    const cfg = pickSpaceRouterConfig(
      { SR_REGION: 'US', SR_IP_TYPE: 'residential' },
      PK,
      { region: 'JP', ipType: 'business', dryRun: true },
    );
    expect(cfg.region).toBe('JP');
    expect(cfg.ipType).toBe('business');
    expect(cfg.dryRun).toBe(true);
  });
});

// ─── Dry-run client behaviour (no live network) ──────────────────────────────
describe('SpaceRouterClient (dry-run)', () => {
  const PK = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  const cfg = pickSpaceRouterConfig({}, PK, { dryRun: true });
  const client = new SpaceRouterClient(cfg, {});

  it('depositToEscrow returns a synthetic 0xdry… tx hash', async () => {
    const r = await client.depositToEscrow(parseSpaceWei('10'));
    expect(r.txHash.startsWith('0xdry')).toBe(true);
    expect(r.amountWei).toBe((10n ** 18n * 10n).toString());
  });

  it('initiate / execute / cancel withdrawal all return synthetic tx hashes', async () => {
    const a = await client.initiateWithdrawal(parseSpaceWei('1'));
    const b = await client.executeWithdrawal();
    const c = await client.cancelWithdrawal();
    for (const r of [a, b, c]) expect(r.txHash.startsWith('0xdry')).toBe(true);
  });

  it('getEscrowBalance returns 0n in dry-run (no chain hit)', async () => {
    expect(await client.getEscrowBalance(SPACE_TOKEN_ADDRESS)).toBe(0n);
  });

  it('getStatus returns a zero-shape with no pending withdrawal', async () => {
    const s = await client.getStatus(SPACE_TOKEN_ADDRESS);
    expect(s).toEqual({
      deposited_wei: '0',
      pending_wei: '0',
      unlock_at_iso: null,
    });
  });

  it('syncReceipts returns the empty result without calling the SDK', async () => {
    expect(await client.syncReceipts()).toEqual({
      accepted: [],
      rejected: [],
      pending_count: 0,
    });
  });
});

// ─── Error class ─────────────────────────────────────────────────────────────
describe('SpaceRouterError', () => {
  it('carries a code and an optional hint', () => {
    const e = new SpaceRouterError('boom', 'SPACEROUTER_NO_NODES', 'try later');
    expect(e.code).toBe('SPACEROUTER_NO_NODES');
    expect(e.hint).toBe('try later');
    expect(e instanceof Error).toBe(true);
  });
});

// ─── Constants sanity ────────────────────────────────────────────────────────
describe('SpaceCoin constants', () => {
  it('Creditcoin chainId is 102030 (SpaceCoin docs)', () => {
    expect(CREDITCOIN_CHAIN_ID).toBe(102030);
  });

  it('SPACE token address matches the mainnet token', () => {
    expect(SPACE_TOKEN_ADDRESS).toBe('0x7ab7C6A935Ab2D1437398790C9C0660af62A80b9');
  });

  it('TokenPaymentEscrow address matches the v1.5 deployment', () => {
    expect(TOKEN_PAYMENT_ESCROW_ADDRESS).toBe(
      '0xC130F5D76f0b4Ce8FE2ceA0D2C2b8f53A39a5cd0',
    );
  });

  it('Escrow ABI exposes the methods we call from handlers', () => {
    const names = TOKEN_PAYMENT_ESCROW_ABI.map((f) => f.name);
    for (const n of [
      'deposit',
      'balanceOf',
      'initiateWithdrawal',
      'executeWithdrawal',
      'cancelWithdrawal',
      'pendingWithdrawal',
    ]) {
      expect(names).toContain(n);
    }
  });
});

// ─── Tool schema validation ──────────────────────────────────────────────────
describe('spacerouter_* tool schemas', () => {
  it('spacerouter_pay accepts a happy-path payload', () => {
    const r = TOOL_BY_NAME.spacerouter_pay!.schema.safeParse({
      url: 'https://httpbin.org/ip',
      region: 'KR',
      ip_type: 'residential',
      dry_run: true,
    });
    expect(r.success).toBe(true);
  });

  it('spacerouter_pay rejects a lower-case region', () => {
    const r = TOOL_BY_NAME.spacerouter_pay!.schema.safeParse({
      url: 'https://httpbin.org/ip',
      region: 'kr',
    });
    expect(r.success).toBe(false);
  });

  it('spacerouter_pay rejects an unknown ip_type', () => {
    const r = TOOL_BY_NAME.spacerouter_pay!.schema.safeParse({
      url: 'https://httpbin.org/ip',
      ip_type: 'satellite',
    });
    expect(r.success).toBe(false);
  });

  it('spacerouter_escrow accepts every action enum value', () => {
    for (const action of [
      'deposit',
      'balance',
      'initiate-withdrawal',
      'execute-withdrawal',
      'cancel-withdrawal',
      'status',
    ] as const) {
      const r = TOOL_BY_NAME.spacerouter_escrow!.schema.safeParse({ action });
      expect(r.success).toBe(true);
    }
  });

  it('spacerouter_escrow rejects an unknown action', () => {
    const r = TOOL_BY_NAME.spacerouter_escrow!.schema.safeParse({
      action: 'stake',
    });
    expect(r.success).toBe(false);
  });

  it('spacerouter_sync_receipts accepts an empty payload', () => {
    const r = TOOL_BY_NAME.spacerouter_sync_receipts!.schema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('spacerouter_admin requires a known action', () => {
    expect(
      TOOL_BY_NAME.spacerouter_admin!.schema.safeParse({ action: 'create' })
        .success,
    ).toBe(true);
    expect(
      TOOL_BY_NAME.spacerouter_admin!.schema.safeParse({ action: 'rotate' })
        .success,
    ).toBe(false);
  });
});

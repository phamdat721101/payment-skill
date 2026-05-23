import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTest,
  __setClientForTest,
  encodeCollateralReservationReference,
  FLARE_CONTRACT_REGISTRY,
  getAgentVaults,
  getFxrpBalance,
  getMasterAccountControllerAddress,
  getOperatorXrplAddresses,
  getPersonalAccountAddress,
} from '../src/flare.ts';
import { TOOL_BY_NAME } from '../src/tools.ts';
import { xrpl_to_fxrp_bridge } from '../src/handlers.ts';
import type { ToolContext } from '../src/tools.ts';

// ── Encoder ─────────────────────────────────────────────────────────────────

describe('encodeCollateralReservationReference', () => {
  it('produces 32 bytes (0x + 64 hex chars)', () => {
    const ref = encodeCollateralReservationReference({
      agentVaultId: 1n,
      lots: 1n,
    });
    expect(ref).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('byte 0 is the FXRP collateralReservation instruction code 0x00', () => {
    const ref = encodeCollateralReservationReference({
      agentVaultId: 1n,
      lots: 1n,
    });
    expect(ref.slice(2, 4)).toBe('00');
  });

  it('byte 1 is the wallet identifier (default 0)', () => {
    const a = encodeCollateralReservationReference({ agentVaultId: 1n, lots: 1n });
    expect(a.slice(4, 6)).toBe('00');
    const b = encodeCollateralReservationReference({
      agentVaultId: 1n,
      lots: 1n,
      walletId: 0xab,
    });
    expect(b.slice(4, 6)).toBe('ab');
  });

  it('encodes agentVaultId at bytes 2..17 and lots at 18..31 (big-endian)', () => {
    const ref = encodeCollateralReservationReference({
      agentVaultId: 0x1234n,
      lots: 0x5678n,
    });
    // hex string layout: '0x' + byte0(2) + byte1(2) + agentVaultId(32) + lots(28)
    // → indices 6..38 = 32 chars of agentVaultId (uint128, big-endian)
    expect(ref.slice(6, 38)).toBe('00000000000000000000000000001234');
    // → indices 38..66 = 28 chars of lots (uint112, big-endian)
    expect(ref.slice(38, 66)).toBe('0000000000000000000000005678');
  });

  it('rejects out-of-range params', () => {
    expect(() =>
      encodeCollateralReservationReference({ agentVaultId: -1n, lots: 1n }),
    ).toThrow();
    expect(() =>
      encodeCollateralReservationReference({ agentVaultId: 1n, lots: 0n }),
    ).toThrow();
    expect(() =>
      encodeCollateralReservationReference({
        agentVaultId: 1n,
        lots: 1n,
        walletId: 0x100,
      }),
    ).toThrow();
  });
});

// ── State lookups (mocked publicClient) ─────────────────────────────────────

afterEach(() => __resetForTest());

const MAC: `0x${string}` = '0x1111111111111111111111111111111111111111';
const FXRP: `0x${string}` = '0x2222222222222222222222222222222222222222';
const ASSET_MGR: `0x${string}` = '0x3333333333333333333333333333333333333333';

function fakeClient(impl: (call: {
  address: string;
  functionName: string;
  args?: readonly unknown[];
}) => unknown) {
  return {
    readContract: vi.fn(async (call: never) => impl(call as never)),
  } as never;
}

describe('flare state lookup (mocked)', () => {
  it('resolves MasterAccountController via FlareContractRegistry and memoizes', async () => {
    const calls: string[] = [];
    __setClientForTest(
      'flare-coston2',
      fakeClient((c) => {
        calls.push(c.functionName);
        if (
          c.functionName === 'getContractAddressByName' &&
          c.address === FLARE_CONTRACT_REGISTRY &&
          c.args?.[0] === 'MasterAccountController'
        ) {
          return MAC;
        }
        throw new Error(`unexpected call: ${c.functionName}`);
      }),
    );
    const a = await getMasterAccountControllerAddress('flare-coston2');
    const b = await getMasterAccountControllerAddress('flare-coston2');
    expect(a).toBe(MAC);
    expect(b).toBe(MAC);
    expect(calls.filter((n) => n === 'getContractAddressByName')).toHaveLength(1);
  });

  it('throws FLARE_NOT_CONFIGURED when registry returns 0x0', async () => {
    __setClientForTest(
      'flare-coston2',
      fakeClient(() => '0x0000000000000000000000000000000000000000'),
    );
    await expect(
      getMasterAccountControllerAddress('flare-coston2'),
    ).rejects.toMatchObject({ code: 'FLARE_NOT_CONFIGURED' });
  });

  it('returns operator XRPL addresses', async () => {
    __setClientForTest(
      'flare-coston2',
      fakeClient((c) => {
        if (c.functionName === 'getContractAddressByName') return MAC;
        if (c.functionName === 'getXrplProviderWallets')
          return ['rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq'];
        throw new Error(`unexpected: ${c.functionName}`);
      }),
    );
    const out = await getOperatorXrplAddresses('flare-coston2');
    expect(out).toEqual(['rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq']);
  });

  it('parses getAgentVaults tuple of arrays into [{id,address}]', async () => {
    __setClientForTest(
      'flare-coston2',
      fakeClient((c) => {
        if (c.functionName === 'getContractAddressByName') return MAC;
        if (c.functionName === 'getAgentVaults') {
          return [
            [1n, 2n],
            [
              '0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC',
              '0x66c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC',
            ],
          ];
        }
        throw new Error(`unexpected: ${c.functionName}`);
      }),
    );
    const vaults = await getAgentVaults('flare-coston2');
    expect(vaults).toEqual([
      { id: 1n, address: '0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC' },
      { id: 2n, address: '0x66c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC' },
    ]);
  });

  it('returns the PersonalAccount for an XRPL address', async () => {
    const personal: `0x${string}` = '0xFd2f0eb6b9fA4FE5bb1F7B26fEE3c647ed103d9F';
    __setClientForTest(
      'flare-coston2',
      fakeClient((c) => {
        if (c.functionName === 'getContractAddressByName') return MAC;
        if (
          c.functionName === 'getPersonalAccount' &&
          c.args?.[0] === 'rUserXrplAddress'
        ) {
          return personal;
        }
        throw new Error(`unexpected: ${c.functionName}`);
      }),
    );
    const out = await getPersonalAccountAddress(
      'rUserXrplAddress',
      'flare-coston2',
    );
    expect(out).toBe(personal);
  });

  it('reads FXRP balance via AssetManager.fAsset() → ERC20.balanceOf()', async () => {
    __setClientForTest(
      'flare-coston2',
      fakeClient((c) => {
        if (c.functionName === 'getContractAddressByName') {
          return c.args?.[0] === 'AssetManagerFXRP' ? ASSET_MGR : MAC;
        }
        if (c.functionName === 'fAsset' && c.address === ASSET_MGR) return FXRP;
        if (c.functionName === 'balanceOf' && c.address === FXRP) return 1_500_000n;
        throw new Error(`unexpected: ${c.functionName}`);
      }),
    );
    const bal = await getFxrpBalance(
      '0xFd2f0eb6b9fA4FE5bb1F7B26fEE3c647ed103d9F',
      'flare-coston2',
    );
    expect(bal).toBe(1_500_000n);
  });
});

// ── Tool registration ───────────────────────────────────────────────────────

describe('xrpl_to_fxrp_bridge schema', () => {
  const t = TOOL_BY_NAME.xrpl_to_fxrp_bridge!;

  it('is registered', () => {
    expect(t).toBeDefined();
  });

  it('parses empty input with sane defaults (zero-config)', () => {
    const r = t.schema.parse({}) as Record<string, unknown>;
    expect(r.amount_xrp).toBe('10');
    expect(r.lots).toBe(1);
    expect(r.wait).toBe(true);
    expect(r.poll_interval_ms).toBe(5000);
    expect(r.timeout_ms).toBe(180_000);
    expect(r.chain).toBe('flare-coston2');
  });

  it('rejects non-decimal amount_xrp', () => {
    expect(t.schema.safeParse({ amount_xrp: 'ten' }).success).toBe(false);
  });

  it('rejects chains other than flare-coston2 / flare-mainnet', () => {
    expect(t.schema.safeParse({ chain: 'base-sepolia' }).success).toBe(false);
  });

  it('accepts custom auto-discovery overrides', () => {
    const r = t.schema.safeParse({
      amount_xrp: '5',
      lots: 2,
      agent_vault_id: '1',
      operator_xrpl: 'rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq',
      wait: false,
    });
    expect(r.success).toBe(true);
  });
});

// ── Handler guard paths (no network) ────────────────────────────────────────

const ctx = (env: NodeJS.ProcessEnv = {}, testnetMode = true): ToolContext => ({
  walletName: 'default',
  defaultChain: 'flare-coston2',
  testnetMode,
  env,
});

describe('xrpl_to_fxrp_bridge handler guards', () => {
  it('blocks flare-mainnet while testnetMode=true', async () => {
    const r = await xrpl_to_fxrp_bridge(
      {
        amount_xrp: '10',
        lots: 1,
        wait: false,
        poll_interval_ms: 5000,
        timeout_ms: 180_000,
        chain: 'flare-mainnet',
      },
      ctx({ XRPL_SEED: 'sEd' }, true),
    );
    expect(r).toMatchObject({ ok: false, code: 'MAINNET_GUARD' });
  });

  it('errors with XRPL_SEED_MISSING when XRPL_SEED is unset', async () => {
    const r = await xrpl_to_fxrp_bridge(
      {
        amount_xrp: '10',
        lots: 1,
        wait: false,
        poll_interval_ms: 5000,
        timeout_ms: 180_000,
        chain: 'flare-coston2',
      },
      ctx({}, true),
    );
    expect(r).toMatchObject({ ok: false, code: 'XRPL_SEED_MISSING' });
  });
});

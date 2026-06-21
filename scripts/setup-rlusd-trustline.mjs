// scripts/setup-rlusd-trustline.mjs
// Mirrors the v0.29.0 ensureTrustline() flow for an XRPL testnet wallet.
// 1. Resolve classic address from seed.
// 2. account_info → fund from testnet faucet if account is unfunded.
// 3. account_lines → if RLUSD trustline is missing, submit TrustSet.
// 4. account_lines re-read → confirm trustline is now present.
//
// Issuer + currency match n-payment v0.29.0 src/xrpl/utils.ts.
//   testnet RLUSD issuer: rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV
//   currency: 'RLUSD'  (auto-encoded as 40-hex 524C5553... by xrpl.js)
//   limit: 1_000_000_000

import { Client, Wallet } from 'xrpl';

const SEED = process.argv[2] ?? 'sEdTcYPTN1p8nCUF7WF24WGrYS1gMAc';
const NETWORK = 'wss://s.altnet.rippletest.net:51233';
const RLUSD_TESTNET_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
// xrpl.js v4 rejects non-3-char ASCII currency codes — must use 40-hex form.
// 'RLUSD' (5 chars) → ASCII hex padded to 20 bytes: 52 4C 55 53 44 + 15× 00
const RLUSD_CURRENCY_HEX = '524C555344000000000000000000000000000000';
const RLUSD_CURRENCY_DISPLAY = 'RLUSD';
const TRUSTLINE_LIMIT = '1000000000';

const log = (label, value) => {
  if (typeof value === 'string') console.log(`▸ ${label}: ${value}`);
  else console.log(`▸ ${label}:`, JSON.stringify(value, null, 2));
};

async function main() {
  const wallet = Wallet.fromSeed(SEED);
  log('seed', SEED);
  log('classic address', wallet.classicAddress);
  log('public key', wallet.publicKey);

  const client = new Client(NETWORK);
  await client.connect();
  log('connected to', NETWORK);

  try {
    // ─── 1. account_info — does the account exist on-ledger? ────────────────
    let accountInfo;
    try {
      accountInfo = await client.request({
        command: 'account_info',
        account: wallet.classicAddress,
        ledger_index: 'validated',
      });
    } catch (e) {
      if (e.data?.error === 'actNotFound') {
        log('account_info', 'actNotFound — account is unfunded');
      } else {
        throw e;
      }
    }

    if (!accountInfo) {
      // Fund via xrpl.js builtin testnet faucet (calls altnet.rippletest.net).
      console.log('▸ funding via testnet faucet …');
      const { wallet: funded, balance } = await client.fundWallet(wallet);
      log('faucet funded', { address: funded.classicAddress, balance });
      accountInfo = await client.request({
        command: 'account_info',
        account: wallet.classicAddress,
        ledger_index: 'validated',
      });
    }
    const xrpDrops = accountInfo.result.account_data.Balance;
    const xrp = (Number(xrpDrops) / 1_000_000).toFixed(6);
    log('xrp balance', `${xrp} XRP (${xrpDrops} drops)`);
    log('owner_count', String(accountInfo.result.account_data.OwnerCount ?? 0));

    // ─── 2. account_lines — does RLUSD trustline already exist? ────────────
    const linesResp = await client.request({
      command: 'account_lines',
      account: wallet.classicAddress,
      ledger_index: 'validated',
    });
    const existing = (linesResp.result.lines ?? []).find(
      (l) =>
        (l.currency === RLUSD_CURRENCY_HEX || l.currency === RLUSD_CURRENCY_DISPLAY) &&
        l.account === RLUSD_TESTNET_ISSUER,
    );

    if (existing) {
      log('trustline state', { ok: true, alreadyExisted: true, line: existing });
      console.log('✓ RLUSD trustline already present — nothing to do.');
      return;
    }

    // ─── 3. submit TrustSet ─────────────────────────────────────────────────
    console.log('▸ no RLUSD trustline yet — submitting TrustSet …');
    const tx = {
      TransactionType: 'TrustSet',
      Account: wallet.classicAddress,
      LimitAmount: {
        currency: RLUSD_CURRENCY_HEX,
        issuer: RLUSD_TESTNET_ISSUER,
        value: TRUSTLINE_LIMIT,
      },
    };
    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared);
    log('tx_hash (pre-submit)', signed.hash);
    const result = await client.submitAndWait(signed.tx_blob);
    const meta = result.result.meta;
    const engine =
      typeof meta === 'object' && meta !== null && 'TransactionResult' in meta
        ? meta.TransactionResult
        : 'unknown';
    log('TransactionResult', String(engine));
    log('validated', String(result.result.validated ?? false));
    log('hash', String(result.result.hash));
    if (engine !== 'tesSUCCESS') {
      throw new Error(`TrustSet did not succeed: ${engine}`);
    }

    // ─── 4. verify via account_lines ────────────────────────────────────────
    const verify = await client.request({
      command: 'account_lines',
      account: wallet.classicAddress,
      ledger_index: 'validated',
    });
    const line = (verify.result.lines ?? []).find(
      (l) =>
        (l.currency === RLUSD_CURRENCY_HEX || l.currency === RLUSD_CURRENCY_DISPLAY) &&
        l.account === RLUSD_TESTNET_ISSUER,
    );
    if (!line) throw new Error('TrustSet succeeded but account_lines does not show the line');
    log('verified line', line);

    console.log('✓ RLUSD trustline established on XRPL testnet.');
    console.log('  Address:    ' + wallet.classicAddress);
    console.log('  Issuer:     ' + RLUSD_TESTNET_ISSUER);
    console.log('  Currency:   ' + RLUSD_CURRENCY_DISPLAY + ' (' + RLUSD_CURRENCY_HEX + ')');
    console.log('  Limit:      ' + TRUSTLINE_LIMIT);
    console.log('  Tx hash:    ' + result.result.hash);
    console.log('  Explorer:   https://testnet.xrpl.org/transactions/' + result.result.hash);
    console.log('  Account:    https://testnet.xrpl.org/accounts/' + wallet.classicAddress);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error('✗ error:', e?.message ?? e);
  if (e?.data) console.error('  data:', JSON.stringify(e.data));
  process.exit(1);
});

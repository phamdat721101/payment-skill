// scripts/x402-rlusd-testnet-demo.mjs
//
// End-to-end x402 RLUSD round-trip on XRPL testnet via the T54 hosted
// facilitator. Mirrors the canonical examples/xrpl-x402-rlusd.ts in the
// n-payment repo, with these tweaks:
//
//   • Buyer    — the seed passed via XRPL_BUYER_SEED (defaults to the
//                hard-coded skill-test seed). Has 39.95 XRP, RLUSD trustline
//                already exists; uses xrpl.autoSwap to convert XRP→RLUSD on
//                the testnet AMM (~527K XRP / 325K RLUSD pool).
//   • Merchant — a freshly generated wallet, faucet-funded with 10 XRP, then
//                wired into createPaywall with `xrpl.seed` so the v0.29
//                auto-trustline path runs the merchant TrustSet on the first
//                402 — exactly the unified ensureTrustline() flow.
//   • Facilitator — defaults to xrpl-facilitator-testnet.t54.ai (T54 hosted).
//
// The wire format is v0.28 / v0.29: PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
// PAYMENT-RESPONSE headers, RLUSD as 40-hex 524C5553440000…, SourceTag
// 804681468, MemoData=hex(invoiceId), LastLedgerSequence ±20.

import express from 'express';
import { Wallet, Client } from 'xrpl';
import { createPaymentClient, createPaywall } from 'n-payment';

// ─── Tap fetch to inspect facilitator round-trips (debug helper) ────────────
const _origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('t54.ai')) {
    console.log(`\n[fetch→T54] ${init?.method ?? 'GET'} ${u}`);
    if (init?.body) {
      try {
        const body = JSON.parse(String(init.body));
        console.log('[fetch→T54] body keys:', Object.keys(body));
        console.log('[fetch→T54] body =', JSON.stringify(body, null, 2));
      } catch {
        console.log('[fetch→T54] body (raw):', String(init.body).slice(0, 500));
      }
    }
    const res = await _origFetch(url, init);
    const cloned = res.clone();
    const text = await cloned.text().catch(() => '');
    console.log(`[fetch←T54] status=${res.status}`);
    console.log('[fetch←T54] body:', text.slice(0, 800));
    return res;
  }
  return _origFetch(url, init);
};

const PORT = Number(process.env.PORT ?? 8765);
const SEED = process.env.XRPL_BUYER_SEED ?? 'sEdTcYPTN1p8nCUF7WF24WGrYS1gMAc';
const PRICE_RLUSD = process.env.PRICE_RLUSD ?? '0.01';

const log = (...args) => console.log('[demo]', ...args);

async function fundFresh(client) {
  const fresh = Wallet.generate();
  log(`generating fresh merchant wallet: ${fresh.classicAddress}`);
  const { wallet, balance } = await client.fundWallet(fresh);
  log(`merchant funded — ${balance} XRP`);
  return wallet;
}

async function lookupRlusdBalance(client, account, issuer) {
  try {
    const r = await client.request({ command: 'account_lines', account, ledger_index: 'validated' });
    const RLUSD_HEX = '524C555344000000000000000000000000000000';
    const line = (r.result.lines ?? []).find(
      (l) => (l.currency === 'RLUSD' || l.currency === RLUSD_HEX) && l.account === issuer,
    );
    return line?.balance ?? '0';
  } catch (e) {
    return `<error: ${e.message}>`;
  }
}

async function main() {
  const buyer = Wallet.fromSeed(SEED);
  log(`buyer seed   ${SEED}`);
  log(`buyer addr   ${buyer.classicAddress}`);

  // ─── Provision a fresh merchant wallet via testnet faucet ──────────────────
  const xrplClient = new Client('wss://s.altnet.rippletest.net:51233');
  await xrplClient.connect();
  const merchant = await fundFresh(xrplClient);
  log(`merchant addr ${merchant.classicAddress}`);
  log(`merchant seed ${merchant.seed}`);

  // Sanity baseline — check both wallets pre-flow.
  const ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
  const buyerInfo = await xrplClient.request({ command: 'account_info', account: buyer.classicAddress, ledger_index: 'validated' });
  const merchantInfo = await xrplClient.request({ command: 'account_info', account: merchant.classicAddress, ledger_index: 'validated' });
  log(`buyer XRP    ${(Number(buyerInfo.result.account_data.Balance)/1_000_000).toFixed(6)}`);
  log(`merchant XRP ${(Number(merchantInfo.result.account_data.Balance)/1_000_000).toFixed(6)}`);
  log(`buyer RLUSD pre  ${await lookupRlusdBalance(xrplClient, buyer.classicAddress, ISSUER)}`);
  log(`merchant RLUSD pre ${await lookupRlusdBalance(xrplClient, merchant.classicAddress, ISSUER)} (expect 0/no-line — auto-trustline runs on first 402)`);

  // ─── Stand up the paywall ──────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use(
    createPaywall({
      routes: {
        'GET /paid': {
          price: PRICE_RLUSD,
          description: 'XRPL x402 testnet demo (n-payment v0.29 unified trustline)',
          xrpl: {
            payTo: merchant.classicAddress,
            network: 'xrpl:1',
            asset: 'RLUSD',
            // facilitatorUrl omitted → defaults to xrpl-facilitator-testnet.t54.ai
          },
        },
      },
      // v0.29: merchant signer powers the auto-trustline preflight on the
      // very first 402 to GET /paid. Mirrors the buyer auto-swap pattern.
      xrpl: { seed: merchant.seed },
    }),
  );
  app.get('/paid', (_req, res) =>
    res.json({ ok: true, ts: Date.now(), msg: `Thanks for paying ${PRICE_RLUSD} RLUSD` }),
  );

  let httpServer;
  try {
    await new Promise((resolve) => {
      httpServer = app.listen(PORT, resolve);
    });
    log(`paywall listening at http://127.0.0.1:${PORT}/paid (price ${PRICE_RLUSD} RLUSD)`);

    // ─── Buyer side — fetchWithPayment auto-handles the 402 ──────────────────
    const client = createPaymentClient({
      chains: ['xrpl-testnet'],
      ows: { wallet: 'demo-buyer' }, // unused — xrpl.seed supersedes
      xrpl: { seed: SEED, autoSwap: true, maxSlippageBps: 200 },
    });

    const t0 = Date.now();
    const res = await client.fetchWithPayment(`http://127.0.0.1:${PORT}/paid`);
    const dt = Date.now() - t0;

    log(`HTTP ${res.status} in ${dt}ms`);
    if (!res.ok) {
      const body = await res.text();
      log('non-OK body:', body);
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
    log('body:', JSON.stringify(body));

    // PAYMENT-RESPONSE header carries the settled XRPL tx envelope (v0.28 spec).
    const settle = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('payment-response');
    if (settle) {
      const decoded = JSON.parse(Buffer.from(settle, 'base64').toString());
      log('PAYMENT-RESPONSE:', JSON.stringify(decoded, null, 2));
      if (decoded.transaction) {
        log(`explorer  https://testnet.xrpl.org/transactions/${decoded.transaction}`);
      }
    } else {
      log('no PAYMENT-RESPONSE header on success — that is unexpected for v0.28+');
    }

    // ─── Post-flow verification on chain ─────────────────────────────────────
    log('--- post-flow on-chain verification ---');
    log(`buyer RLUSD post    ${await lookupRlusdBalance(xrplClient, buyer.classicAddress, ISSUER)}`);
    log(`merchant RLUSD post ${await lookupRlusdBalance(xrplClient, merchant.classicAddress, ISSUER)}  (expect ≥ ${PRICE_RLUSD})`);

    // Confirm merchant trustline was auto-created (v0.29 ensureTrustline path).
    const mLines = await xrplClient.request({ command: 'account_lines', account: merchant.classicAddress, ledger_index: 'validated' });
    const RLUSD_HEX = '524C555344000000000000000000000000000000';
    const merchantLine = (mLines.result.lines ?? []).find(
      (l) => (l.currency === 'RLUSD' || l.currency === RLUSD_HEX) && l.account === ISSUER,
    );
    log('merchant trustline auto-created:', merchantLine ? JSON.stringify(merchantLine) : 'NONE');
  } finally {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    await xrplClient.disconnect();
  }
}

main().catch((e) => {
  console.error('✗ demo failed:', e?.message ?? e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});

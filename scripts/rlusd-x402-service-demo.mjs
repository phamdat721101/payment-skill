// scripts/rlusd-x402-service-demo.mjs
//
// One-file end-to-end demo of an RLUSD-paywalled x402 service on XRPL testnet,
// using the freshly-published n-payment@0.29.1 (with all three v0.29.0 wire
// fixes). Walks through every step the user can observe:
//
//   1. Spin up an Express paywall guarding GET /weather/forecast at 0.01 RLUSD
//      via createPaywall({ routes, xrpl: { seed } }) — the merchant is
//      faucet-funded and gets its RLUSD trustline auto-created on the first
//      402 by n-payment v0.29.1's unified ensureTrustline().
//   2. Issue an unauthenticated GET — observe HTTP 402 with the canonical
//      `PAYMENT-REQUIRED` envelope (base64-JSON containing payTo, amount,
//      asset 40-hex, sourceTag, invoiceId, …).
//   3. Use n-payment's createPaymentClient to fetchWithPayment(), which
//      auto-handles the 402 by signing an XRPL Payment, attaching the
//      `PAYMENT-SIGNATURE` header (with payload.invoiceId per the v0.29.1
//      fix), letting the merchant call T54's hosted facilitator
//      (xrpl-facilitator-testnet.t54.ai) for verify+settle, and finally
//      returning the resource body alongside `PAYMENT-RESPONSE`.
//   4. Confirm everything on-chain — fetch the settled tx, balances, and
//      print the explorer link.
//
// Run:   node scripts/rlusd-x402-service-demo.mjs
//
// Env:
//   XRPL_BUYER_SEED  Buyer/payer wallet (default: the demo seed already
//                    holding ~4.94 RLUSD on testnet)
//   PORT             Local paywall port (default 8765)

import express from 'express';
import { Wallet, Client } from 'xrpl';
import { createPaymentClient, createPaywall } from 'n-payment';

const SEED = process.env.XRPL_BUYER_SEED;
if (!SEED) { console.error("Error: Set XRPL_BUYER_SEED env var"); process.exit(1); }
const PORT = Number(process.env.PORT ?? 8765);
const PRICE_RLUSD = '0.01';
const ROUTE = 'GET /weather/forecast';
const ROUTE_PATH = '/weather/forecast';
const RLUSD_HEX = '524C555344000000000000000000000000000000';
const ISSUER_TESTNET = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';

const SECTION = (n, title) => console.log(`\n\x1b[1m\x1b[36m=== ${n}. ${title} ===\x1b[0m`);
const STEP = (msg, val) => {
  if (val === undefined) console.log(`  • ${msg}`);
  else if (typeof val === 'object') console.log(`  • ${msg}:\n${JSON.stringify(val, null, 4).split('\n').map((l) => '      ' + l).join('\n')}`);
  else console.log(`  • ${msg}: ${val}`);
};
const decodeHeader = (b64) => {
  try { return JSON.parse(Buffer.from(b64, 'base64').toString()); } catch { return null; }
};

async function rlusdBalance(xrpl, addr) {
  const r = await xrpl.request({ command: 'account_lines', account: addr, ledger_index: 'validated' });
  const line = (r.result.lines ?? []).find(
    (l) => (l.currency === RLUSD_HEX || l.currency === 'RLUSD') && l.account === ISSUER_TESTNET,
  );
  return line?.balance ?? null;
}

async function fundFreshMerchant(xrpl) {
  const fresh = Wallet.generate();
  const { wallet, balance } = await xrpl.fundWallet(fresh);
  STEP('faucet funded', `${balance} XRP → ${wallet.classicAddress}`);
  return wallet;
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────
  SECTION(1, 'Setup the on-chain actors');
  const buyer = Wallet.fromSeed(SEED);
  STEP('buyer seed', SEED);
  STEP('buyer addr', buyer.classicAddress);

  const xrpl = new Client('wss://s.altnet.rippletest.net:51233');
  await xrpl.connect();
  STEP('xrpl ws', 'wss://s.altnet.rippletest.net:51233 connected');

  const merchantWallet = await fundFreshMerchant(xrpl);
  STEP('merchant addr', merchantWallet.classicAddress);

  STEP('buyer  RLUSD pre', await rlusdBalance(xrpl, buyer.classicAddress));
  STEP('merchant RLUSD pre', `${await rlusdBalance(xrpl, merchantWallet.classicAddress)} (no trustline yet — auto-created on first 402)`);

  // ─────────────────────────────────────────────────────────────────────────
  SECTION(2, 'Stand up the x402 paywall service');
  const app = express();
  app.use(express.json());
  app.use(
    createPaywall({
      routes: {
        [ROUTE]: {
          price: PRICE_RLUSD,
          description: 'Hourly weather forecast (XRPL testnet RLUSD demo)',
          xrpl: {
            payTo: merchantWallet.classicAddress,
            network: 'xrpl:1',
            asset: 'RLUSD',
            // facilitatorUrl omitted → defaults to xrpl-facilitator-testnet.t54.ai
          },
        },
      },
      // v0.29 auto-trustline: the first 402 to GET /weather/forecast signs
      // a one-time TrustSet on the merchant wallet.
      xrpl: { seed: merchantWallet.seed },
    }),
  );
  app.get(ROUTE_PATH, (_req, res) =>
    res.json({
      generated_at: new Date().toISOString(),
      forecast: [
        { hour: '+0h', temp_c: 24, condition: 'partly cloudy' },
        { hour: '+1h', temp_c: 24, condition: 'partly cloudy' },
        { hour: '+2h', temp_c: 23, condition: 'light rain' },
        { hour: '+3h', temp_c: 22, condition: 'rain' },
      ],
    }),
  );

  const server = await new Promise((r) => {
    const s = app.listen(PORT, () => r(s));
  });
  const baseUrl = `http://127.0.0.1:${PORT}`;
  STEP('paywall', `${baseUrl}${ROUTE_PATH} (price ${PRICE_RLUSD} RLUSD via T54 testnet facilitator)`);

  try {
    // ───────────────────────────────────────────────────────────────────────
    SECTION(3, 'Unauthenticated GET — observe the 402 challenge');
    const challengeRes = await fetch(`${baseUrl}${ROUTE_PATH}`);
    STEP('HTTP status', challengeRes.status);
    const challengeHeader = challengeRes.headers.get('PAYMENT-REQUIRED') ?? challengeRes.headers.get('payment-required');
    STEP('PAYMENT-REQUIRED header (raw, base64)', challengeHeader?.slice(0, 70) + '…');
    const challenge = decodeHeader(challengeHeader);
    STEP('PAYMENT-REQUIRED (decoded)', challenge);
    STEP('body', await challengeRes.json());

    // ───────────────────────────────────────────────────────────────────────
    SECTION(4, 'Buyer pays via n-payment fetchWithPayment()');
    const client = createPaymentClient({
      chains: ['xrpl-testnet'],
      ows: { wallet: 'demo-buyer' },                    // unused — xrpl.seed wins
      xrpl: { seed: SEED, autoSwap: true, maxSlippageBps: 200 },
    });
    const t0 = Date.now();
    const paidRes = await client.fetchWithPayment(`${baseUrl}${ROUTE_PATH}`);
    const dt = Date.now() - t0;
    STEP('round-trip latency', `${dt} ms`);
    STEP('HTTP status', paidRes.status);
    if (!paidRes.ok) {
      const errBody = await paidRes.text();
      throw new Error(`buyer paid but server returned ${paidRes.status}: ${errBody}`);
    }
    const responseHeader = paidRes.headers.get('PAYMENT-RESPONSE') ?? paidRes.headers.get('payment-response');
    const decodedResp = decodeHeader(responseHeader);
    STEP('PAYMENT-RESPONSE (decoded)', decodedResp);
    STEP('forecast body', await paidRes.json());

    // ───────────────────────────────────────────────────────────────────────
    SECTION(5, 'On-chain confirmation');
    const txHash = decodedResp?.transaction;
    if (!txHash) throw new Error('PAYMENT-RESPONSE missing transaction hash');
    // Wait one ledger close for the validated record.
    await new Promise((r) => setTimeout(r, 4000));
    const txInfo = await xrpl.request({ command: 'tx', transaction: txHash, binary: false });
    const meta = txInfo.result.meta;
    const engine = typeof meta === 'object' && meta && 'TransactionResult' in meta ? meta.TransactionResult : null;
    STEP('on-chain validated', txInfo.result.validated);
    STEP('engine_result', engine);
    STEP('Account (payer)', txInfo.result.tx_json?.Account ?? txInfo.result.Account);
    STEP('Destination (payTo)', txInfo.result.tx_json?.Destination ?? txInfo.result.Destination);
    STEP('Amount', txInfo.result.tx_json?.Amount ?? txInfo.result.Amount);
    STEP('SendMax', txInfo.result.tx_json?.SendMax ?? txInfo.result.SendMax);
    STEP('SourceTag', txInfo.result.tx_json?.SourceTag ?? txInfo.result.SourceTag);
    STEP('Memos', txInfo.result.tx_json?.Memos ?? txInfo.result.Memos);
    STEP('explorer', `https://testnet.xrpl.org/transactions/${txHash}`);

    SECTION(6, 'Post-flow balance change');
    STEP('buyer  RLUSD post', await rlusdBalance(xrpl, buyer.classicAddress));
    STEP('merchant RLUSD post', await rlusdBalance(xrpl, merchantWallet.classicAddress));

    console.log('\n\x1b[1m\x1b[32m✓ x402 RLUSD service demo complete.\x1b[0m');
    console.log(`  service       : ${baseUrl}${ROUTE_PATH}`);
    console.log(`  price         : ${PRICE_RLUSD} RLUSD`);
    console.log(`  facilitator   : https://xrpl-facilitator-testnet.t54.ai`);
    console.log(`  payer         : ${buyer.classicAddress}`);
    console.log(`  payee         : ${merchantWallet.classicAddress}`);
    console.log(`  txhash        : ${txHash}`);
  } finally {
    await new Promise((r) => server.close(r));
    await xrpl.disconnect();
  }
}

main().catch((e) => {
  console.error('\n\x1b[1m\x1b[31m✗ demo failed:\x1b[0m', e?.message ?? e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});

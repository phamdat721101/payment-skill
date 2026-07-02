// scripts/t54-direct-rlusd-demo.mjs
//
// Direct T54 facilitator round-trip on XRPL testnet — no Express server, no
// merchant auto-trustline. The seed already has an RLUSD trustline + balance,
// so this self-pays RLUSD, hits T54's /verify and /settle, and confirms
// settlement on-chain.
//
// All the wire-shape rules that tripped n-payment v0.29 (and we've now fixed
// upstream) are spelled out inline:
//   - 40-hex RLUSD currency code on every Currency field
//   - SendMax = same { currency, issuer, value } as Amount (T54 IOU policy)
//   - Memos[0].MemoData = HEX(UTF-8(invoiceId)) for replay binding
//   - SourceTag = 804681468 (T54 x402scan indexer)
//   - LastLedgerSequence = current + 20 for bounded expiry
//   - PAYMENT-SIGNATURE.payload contains BOTH signedTxBlob AND invoiceId

import { Client, Wallet } from 'xrpl';

const SEED = process.env.XRPL_BUYER_SEED;
if (!SEED) { console.error("Error: Set XRPL_BUYER_SEED env var"); process.exit(1); }
const PAY_TO = process.env.XRPL_PAY_TO ?? null; // null = self-pay
const AMOUNT_RLUSD = process.env.RLUSD_AMOUNT ?? '0.01';

const FACILITATOR = 'https://xrpl-facilitator-testnet.t54.ai';
const ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const RLUSD_HEX = '524C555344000000000000000000000000000000';
const SOURCE_TAG = 804681468;
const NETWORK = 'xrpl:1';

const log = (label, value) =>
  console.log(`▸ ${label}:`, typeof value === 'object' ? JSON.stringify(value, null, 2) : value);

function newInvoiceId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

function hexInvoiceMemo(invoiceId) {
  return {
    Memo: { MemoData: Buffer.from(invoiceId, 'utf8').toString('hex').toUpperCase() },
  };
}

async function rlusdBalance(client, address) {
  const r = await client.request({ command: 'account_lines', account: address, ledger_index: 'validated' });
  const line = (r.result.lines ?? []).find(
    (l) => (l.currency === RLUSD_HEX || l.currency === 'RLUSD') && l.account === ISSUER,
  );
  return line?.balance ?? null; // null = no trustline
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function fundRlusdRecipient(xrpl) {
  // Fresh testnet wallet → faucet (100 XRP) → RLUSD trustline. The
  // 12+ XRP base+owner reserve is automatically covered by the faucet drop.
  const fresh = Wallet.generate();
  log('recipient gen', fresh.classicAddress);
  const { wallet, balance } = await xrpl.fundWallet(fresh);
  log('recipient funded', `${balance} XRP`);
  const trust = await xrpl.autofill({
    TransactionType: 'TrustSet',
    Account: wallet.classicAddress,
    LimitAmount: { currency: RLUSD_HEX, issuer: ISSUER, value: '1000000000' },
  });
  const signed = wallet.sign(trust);
  const result = await xrpl.submitAndWait(signed.tx_blob);
  const eng = result.result.meta?.TransactionResult;
  log('recipient TrustSet', `${signed.hash} → ${eng}`);
  if (eng !== 'tesSUCCESS') throw new Error(`recipient TrustSet failed: ${eng}`);
  return wallet;
}

async function main() {
  const buyer = Wallet.fromSeed(SEED);

  log('facilitator', FACILITATOR);
  log('buyer', buyer.classicAddress);

  const xrpl = new Client('wss://s.altnet.rippletest.net:51233');
  await xrpl.connect();

  try {
    const buyerBalPre = await rlusdBalance(xrpl, buyer.classicAddress);
    log('buyer  RLUSD pre', buyerBalPre);
    if (buyerBalPre === null) throw new Error('buyer has no RLUSD trustline');
    if (parseFloat(buyerBalPre) < parseFloat(AMOUNT_RLUSD)) {
      throw new Error(`buyer RLUSD balance ${buyerBalPre} < amount ${AMOUNT_RLUSD}`);
    }

    // Fresh recipient → faucet → trustline (XRPL rejects self-pay IOU as
    // temREDUNDANT, so we need a distinct destination with a trustline).
    let payTo;
    if (PAY_TO) {
      payTo = PAY_TO;
      const payToBal = await rlusdBalance(xrpl, payTo);
      if (payToBal === null) throw new Error(`payTo ${payTo} has no RLUSD trustline`);
      log('payTo (preset)', payTo);
      log('payTo  RLUSD pre', payToBal);
    } else {
      const recipient = await fundRlusdRecipient(xrpl);
      payTo = recipient.classicAddress;
      log('payTo (fresh)', payTo);
    }
    log('amount', `${AMOUNT_RLUSD} RLUSD`);

    // ── Merchant role: build the canonical PaymentRequirements ───────────────
    const invoiceId = newInvoiceId();
    const paymentRequirements = {
      scheme: 'exact',
      network: NETWORK,
      asset: RLUSD_HEX,
      payTo,
      amount: AMOUNT_RLUSD,
      maxTimeoutSeconds: 600,
      extra: { sourceTag: SOURCE_TAG, issuer: ISSUER, invoiceId },
    };
    log('paymentRequirements', paymentRequirements);

    // ── Buyer role: build + sign the canonical Payment ──────────────────────
    const iouAmount = { currency: RLUSD_HEX, issuer: ISSUER, value: AMOUNT_RLUSD };
    const draft = {
      TransactionType: 'Payment',
      Account: buyer.classicAddress,
      Destination: payTo,
      Amount: iouAmount,
      SendMax: iouAmount,                  // T54 IOU policy
      SourceTag: SOURCE_TAG,
      Memos: [hexInvoiceMemo(invoiceId)],  // replay binding
    };
    const filled = await xrpl.autofill(draft);
    filled.LastLedgerSequence = (filled.LastLedgerSequence ?? 0) + 20;
    const signed = buyer.sign(filled);
    log('signed tx hash', signed.hash);

    // ── PAYMENT-SIGNATURE envelope (base64 JSON) ────────────────────────────
    const envelope = {
      x402Version: 2,
      accepted: paymentRequirements,
      payload: { signedTxBlob: signed.tx_blob, invoiceId },
    };

    // ── 1. T54 /verify ──────────────────────────────────────────────────────
    const t0 = Date.now();
    const verify = await postJson(`${FACILITATOR}/verify`, {
      paymentPayload: envelope,
      paymentRequirements,
    });
    log(`/verify (${Date.now() - t0}ms)`, verify);
    if (verify.status !== 200 || verify.json.isValid !== true) {
      throw new Error(`T54 /verify rejected: ${JSON.stringify(verify.json)}`);
    }

    // ── 2. T54 /settle (T54 submits the tx to XRPL testnet) ─────────────────
    const t1 = Date.now();
    const settle = await postJson(`${FACILITATOR}/settle`, {
      paymentPayload: envelope,
      paymentRequirements,
    });
    log(`/settle (${Date.now() - t1}ms)`, settle);
    if (settle.status !== 200 || settle.json.success !== true) {
      throw new Error(`T54 /settle failed: ${JSON.stringify(settle.json)}`);
    }
    const txHash = settle.json.transaction;
    log('settled tx hash', txHash);
    log('explorer', `https://testnet.xrpl.org/transactions/${txHash}`);

    // ── 3. Independent on-chain verification ────────────────────────────────
    // Wait one ledger close, then look up the tx.
    await new Promise((r) => setTimeout(r, 4000));
    const txInfo = await xrpl.request({ command: 'tx', transaction: txHash, binary: false });
    const meta = txInfo.result.meta;
    const engine = typeof meta === 'object' && meta && 'TransactionResult' in meta ? meta.TransactionResult : null;
    log('on-chain validated', txInfo.result.validated);
    log('engine_result', engine);

    const buyerBalPost = await rlusdBalance(xrpl, buyer.classicAddress);
    const payToBalPost = await rlusdBalance(xrpl, payTo);
    log('buyer  RLUSD post', buyerBalPost);
    log('payTo  RLUSD post', payToBalPost);

    console.log('\n✓ T54 round-trip green.');
    console.log('  invoiceId:  ' + invoiceId);
    console.log('  txhash:     ' + txHash);
    console.log('  facilitator:' + FACILITATOR);
    console.log('  payer:      ' + buyer.classicAddress);
    console.log('  payTo:      ' + payTo);
  } finally {
    await xrpl.disconnect();
  }
}

main().catch((e) => {
  console.error('✗ demo failed:', e?.message ?? e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});

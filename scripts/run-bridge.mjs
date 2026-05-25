// scripts/run-bridge.mjs — one-off invocation of the xrpl_to_fxrp_bridge tool
// against the live Coston2 deployment. Reads XRPL_SEED from env (no key
// material is hard-coded). Run from the repo root after `npm run build`.
//
//   XRPL_SEED='sEd…' node scripts/run-bridge.mjs --lots 1 --amount 10.025
//
// Exits non-zero on tool failure.

import { TOOL_BY_NAME } from '../dist/tools.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const lots = Number(arg('lots', '1'));
const amount_xrp = arg('amount', '10.025');
const chain = arg('chain', 'flare-coston2');

if (!process.env.XRPL_SEED) {
  console.error('XRPL_SEED env var is required.');
  process.exit(2);
}

const tool = TOOL_BY_NAME['xrpl_to_fxrp_bridge'];
if (!tool) {
  console.error('xrpl_to_fxrp_bridge tool not found in registry.');
  process.exit(2);
}

const args = {
  amount_xrp,
  lots,
  wait: true,
  poll_interval_ms: 5000,
  timeout_ms: 180_000,
  chain,
};

const ctx = {
  walletName: 'bridge-runner', // not used by this handler, but required by ToolContext
  defaultChain: chain,
  testnetMode: true,
  env: process.env,
};

console.log('▶ invoking xrpl_to_fxrp_bridge with', args);
const result = await tool.handler(args, ctx);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

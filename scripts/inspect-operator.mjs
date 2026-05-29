// Scan recent CollateralReserved logs from AssetManagerFXRP on Coston2 to
// determine whether the operator is processing ANY users (just slow on us)
// or fully offline.
import { createPublicClient, defineChain, http, parseAbiItem } from 'viem';

const RPC = 'https://coston2-api.flare.network/ext/C/rpc';
const AM = '0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA'; // AssetManagerFXRP

const client = createPublicClient({
  chain: defineChain({
    id: 114, name: 'flare-coston2',
    nativeCurrency: { name: 'C2FLR', symbol: 'C2FLR', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  }),
  transport: http(RPC),
});

const head = await client.getBlockNumber();
console.log('head block:', head.toString());

// Coston2 RPC limits getLogs ranges; chunk in 1000-block windows over the
// last ~5000 blocks (~3-4h with ~2s block time).
const WINDOW = 1000n;
const SPAN = 5_000n;
const FROM_BASE = head - SPAN > 0n ? head - SPAN : 0n;

// Common FAssets event we expect to see fire when the operator reserves.
// Try a couple of plausible signatures; we just want activity counts.
const candidates = [
  'event CollateralReserved(address indexed agentVault, uint256 indexed collateralReservationId, address indexed minter, uint256 valueUBA, uint256 feeUBA, uint64 firstUnderlyingBlock, uint64 lastUnderlyingBlock, uint64 lastUnderlyingTimestamp, string paymentAddress, bytes32 paymentReference, address executor, uint256 executorFeeNatWei)',
  'event CollateralReserved(address indexed agentVault, uint256 indexed collateralReservationId, address indexed minter, uint256 valueUBA, uint256 feeUBA, uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp, string paymentAddress, bytes32 paymentReference)',
  'event CollateralReserved(address indexed agentVault, uint256 indexed collateralReservationId, address indexed minter)',
];

for (const sig of candidates) {
  try {
    let total = [];
    for (let from = FROM_BASE; from <= head; from += WINDOW) {
      const to = from + WINDOW - 1n > head ? head : from + WINDOW - 1n;
      const logs = await client.getLogs({
        address: AM,
        event: parseAbiItem(sig),
        fromBlock: from,
        toBlock: to,
      });
      total = total.concat(logs);
    }
    console.log(`signature: ${sig.split('(')[0]} (${sig.match(/\(([^)]*)\)/)[1].split(',').length} fields)`);
    console.log('  matches  :', total.length);
    if (total.length) {
      const last = total[total.length - 1];
      const block = await client.getBlock({ blockNumber: last.blockNumber });
      const age_s = Math.floor(Date.now() / 1000) - Number(block.timestamp);
      console.log('  most recent: block', last.blockNumber.toString(),
                  '— age', age_s, 's (~', (age_s / 60).toFixed(1), 'min)');
      console.log('  tx hash    :', last.transactionHash);
    }
  } catch (e) {
    console.log(`signature: ${sig.split('(')[0]} — error: ${e.shortMessage || e.message}`);
  }
}

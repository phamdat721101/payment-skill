// Coston2 state inspector. Run from the payment-skill repo root so viem
// resolves out of node_modules/.
import { createPublicClient, defineChain, erc20Abi, http } from 'viem';

const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';
const RPC = 'https://coston2-api.flare.network/ext/C/rpc';
const XRPL_ADDR = process.argv[2] || 'rsMV1k7p4dFxguw8o8T1u1SbaL8VtK4Fg8';

const client = createPublicClient({
  chain: defineChain({
    id: 114,
    name: 'flare-coston2',
    nativeCurrency: { name: 'C2FLR', symbol: 'C2FLR', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  }),
  transport: http(RPC),
});

const registryAbi = [{
  type: 'function', name: 'getContractAddressByName', stateMutability: 'view',
  inputs: [{ name: '_name', type: 'string' }], outputs: [{ type: 'address' }],
}];

const macAbi = [
  { type: 'function', name: 'getXrplProviderWallets', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'string[]' }] },
  { type: 'function', name: 'getAgentVaults', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256[]' }, { type: 'address[]' }] },
  { type: 'function', name: 'getPersonalAccount', stateMutability: 'view',
    inputs: [{ name: 'xrplAddress', type: 'string' }], outputs: [{ type: 'address' }] },
];

const amAbi = [{
  type: 'function', name: 'fAsset', stateMutability: 'view',
  inputs: [], outputs: [{ type: 'address' }],
}];

const [mac, am] = await Promise.all([
  client.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'getContractAddressByName', args: ['MasterAccountController'] }),
  client.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'getContractAddressByName', args: ['AssetManagerFXRP'] }),
]);

const [operators, vaults, pa, fxrp] = await Promise.all([
  client.readContract({ address: mac, abi: macAbi, functionName: 'getXrplProviderWallets' }),
  client.readContract({ address: mac, abi: macAbi, functionName: 'getAgentVaults' }),
  client.readContract({ address: mac, abi: macAbi, functionName: 'getPersonalAccount', args: [XRPL_ADDR] }),
  client.readContract({ address: am, abi: amAbi, functionName: 'fAsset' }),
]);

const bal = await client.readContract({
  address: fxrp, abi: erc20Abi, functionName: 'balanceOf', args: [pa],
});

console.log(JSON.stringify({
  master_account_controller: mac,
  asset_manager_fxrp: am,
  fxrp_token: fxrp,
  operator_xrpl_addresses: operators,
  agent_vaults: vaults[0].map((id, i) => ({ id: id.toString(), address: vaults[1][i] })),
  xrpl_address: XRPL_ADDR,
  personal_account: pa,
  fxrp_balance_raw: bal.toString(),
}, null, 2));

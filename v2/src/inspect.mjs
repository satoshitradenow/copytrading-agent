import { readVaultPublicState } from './hyperliquidRead.mjs';
const address=process.argv[2];
if (!address) { console.error('Usage: npm run inspect -- 0xYOUR_PUBLIC_VAULT_ADDRESS'); process.exit(2); }
const state=await readVaultPublicState(address);
console.log(JSON.stringify({mode:state.mode,vaultAddress:state.vaultAddress,leader:state.leader,name:state.name,accountValueUsd:state.accountValueUsd,positionCount:state.positions.length},null,2));
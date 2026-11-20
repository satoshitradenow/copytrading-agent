/** Read-only public vault inspection; never logs secrets or sends orders. */
import {verifyVaultDestination} from './vaultTarget.mjs';
const identifier=process.argv[2]??process.env.V2_VAULT_ADDRESS;
if(!identifier){
  console.error('Usage: npm run inspect -- HL:0xYOUR_PUBLIC_VAULT_ADDRESS (or V2_VAULT_ADDRESS environment variable)');
  process.exitCode=2;
}else{
  const verified=await verifyVaultDestination({identifier,
    expectedLeader:process.env.V2_EXPECTED_VAULT_LEADER??null,
    expectedName:process.env.V2_EXPECTED_VAULT_NAME??null});
  console.log(JSON.stringify(verified,null,2));
}
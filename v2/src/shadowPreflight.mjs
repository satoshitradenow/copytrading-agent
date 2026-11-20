/**
 * End-to-end READ-ONLY preflight: PUBLIC Hyperliquid info -> exact risk gate
 * -> UNSIGNED IOC preview. Never signs, cancels, funds or places any order.
 *
 * This is intentionally NOT a production execution pipeline. Network reads
 * are non-atomic; there is no durable order intent transition or signer.
 */
import {validateIntentSpec} from './intentLedger.mjs';
import {assessShadowVaultRisk} from './riskGate.mjs';
import {prepareShadowIocOrder} from './orderPlanner.mjs';
import {verifyVaultDestination} from './vaultTarget.mjs';
import {readVaultPublicState,readVaultRiskInputs,readMainPerpMetadata,readVaultAssetLeverage} from './hyperliquidRead.mjs';

export async function previewCurrentVaultIntent({intent,expectedLeader=null,expectedName=null,
  riskPolicy,executionPolicy,readers={},clock=()=>Date.now()}={}){
  const spec=validateIntentSpec(intent);
  if(!riskPolicy||!executionPolicy||!['mainnet','testnet'].includes(executionPolicy.network))
    throw Error('Explicit shadow-only execution/risk policies and network required');
  if(typeof clock!=='function')throw Error('Trusted clock required');
  const network=executionPolicy.network;
  const vault=await verifyVaultDestination({identifier:spec.vaultAddress,
    expectedLeader,expectedName,
    readState:readers.readVaultPublicState??(a=>readVaultPublicState(a,{network}))});
  // Observe the vault state, market catalog and per-asset leverage independently.
  // Every read must explicitly identify the SAME network. No stale fallback.
  const [state,meta,leverage]=await Promise.all([
    (readers.readVaultRiskInputs??(a=>readVaultRiskInputs(a,{network})))(spec.vaultAddress),
    (readers.readMainPerpMetadata??(()=>readMainPerpMetadata({network})))(),
    (readers.readVaultAssetLeverage??((a,c)=>readVaultAssetLeverage(a,c,{network})))(spec.vaultAddress,spec.coin)
  ]);
  if(!state || state.mode!=='READ_ONLY' || state.vaultAddress!==spec.vaultAddress || state.network!==network ||
     !meta || meta.mode!=='READ_ONLY' || meta.network!==network ||
     !leverage || leverage.source!=='activeAssetData' || leverage.vaultAddress!==spec.vaultAddress ||
     leverage.coin!==spec.coin || leverage.network!==network)
    throw Error('Mismatched network, vault identity or read-only market observations');
  const now=clock();
  const risk=assessShadowVaultRisk(spec,state,riskPolicy,now);
  if(!risk.allowed)throw Error('Risk policy blocked unsigned preflight: '+risk.failures.join(','));
  if(!Number.isSafeInteger(meta.observedAtMs)||now-meta.observedAtMs<0||
     now-meta.observedAtMs>executionPolicy.maxSnapshotAgeMs)
    throw Error('Perpetual metadata too old for preflight');
  const mid=state.marks?.[spec.coin];
  const preview=prepareShadowIocOrder({intent:spec,riskReceipt:risk,vaultSnapshot:state,
    riskPolicy,meta:meta.meta,metaNetwork:meta.network,markUsd:mid,
    marketObservedAtMs:state.asOfMs,nowMs:now,observedLeverage:leverage,policy:executionPolicy});
  return Object.freeze({mode:'SHADOW_ONLY',vaultVerified:{name:vault.name,
      leader:vault.leader,vaultAddress:vault.vaultAddress},riskAllowed:true,
    preview,signingAuthorityVerified:false,tradingEnabled:false,
    disclaimer:'Read-only non-atomic preflight; not permission to place an order'});
}
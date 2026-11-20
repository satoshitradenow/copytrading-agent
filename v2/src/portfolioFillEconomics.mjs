/**
 * NON-AUTHORIZING portfolio fill-path review.
 *
 * A public orderStatus + matching total size is not enough to determine what
 * happened. This module independently checks unaggregated Hyperliquid fill
 * economics and each fill's documented pre-fill startPosition against
 * snapshots and the previous confirmed *observed* position.
 *
 * Both results remain reviews, not proof of complete history, vault authority,
 * safe order retry, database settlement, or authorization to trade.
 */
import {validateStagedPortfolioPreview} from './pgPortfolioBatchRepository.mjs';
import {auditStagedPortfolioSettlement} from './settlementEvidence.mjs';
import {assessOrderStatusEvidence} from './orderEvidence.mjs';
import {summarizePerpFillEconomics} from './fillAccounting.mjs';
import {formatUnits,sizeUnits} from './ledger.mjs';

const abs=x=>x<0n?-x:x;
const safeMs=(v,label)=>{
 if(!Number.isSafeInteger(v)||v<=0)throw Error('Invalid '+label);
 return v;
};
const asOid=v=>typeof v==='string'?v:
  Number.isSafeInteger(v)&&v>=0?String(v):null;
const position=(snap,coin)=>snap?.positions?.[coin]??'0';

/**
 * Validate a *path*, not just cumulative size, for one matched exchange oid.
 * Duplicate observations must carry IDENTICAL economics (enforced separately
 * by summarizePerpFillEconomics); partials at the same millisecond are linked
 * by startPosition, NOT by assumed trade-ID sort order.
 *
 * Both current and prior snapshot identities must be checked by the caller.
 * The derived end position is a consistency observation, not a settlement.
 */
export function reviewObservedPerpFillPath({
 intent,exchangeOrderId,observedFills,positionBefore,positionAfter,
 windowStartMs,windowEndMs,feeToken='USDC'
}={}){
 if(!intent||!['buy','sell'].includes(intent.side))
  throw Error('Order intent required for fill-path review');
 const start=safeMs(windowStartMs,'pre-fill snapshot timestamp');
 const end=safeMs(windowEndMs,'post-fill snapshot timestamp');
 if(end<=start)throw Error('Post-fill snapshot must follow pre-fill snapshot');
 if(typeof positionBefore!=='string'||typeof positionAfter!=='string')
  throw Error('Explicit observed before/after position decimals required');
 const before=sizeUnits(positionBefore),after=sizeUnits(positionAfter);
 const signed=intent.side==='buy'?1n:-1n;
 const economics=summarizePerpFillEconomics({intent,exchangeOrderId,observedFills,feeToken});
 const matched=new Map();
 for(const fill of observedFills){
  if(asOid(fill.oid)!==economics.exchangeOrderId)continue;
  const id=String(fill.tid);
  // Economics validation above rejected unsafe IDs and conflicting same-tid
  // records; the first identical observation is enough for the position path.
  if(!matched.has(id))matched.set(id,fill);
 }
 if(matched.size!==economics.fillCount)
  throw Error('Fill path dedup does not agree with validated economics');
 const groups=new Map();
 for(const fill of matched.values()){
  const time=safeMs(fill.time,'matched exchange fill time');
  if(time<=start||time>end)
   throw Error('Matched exchange fill falls outside observed position window');
  if(typeof fill.startPosition!=='string')
   throw Error('Missing explicit exchange pre-fill startPosition');
  const initial=sizeUnits(fill.startPosition),sz=sizeUnits(fill.sz);
  if(sz<=0n)throw Error('Nonpositive matched fill');
  if(!groups.has(time))groups.set(time,[]);
  groups.get(time).push({tid:String(fill.tid),initial,sz});
 }
 let current=before;
 const path=[];
 for(const time of [...groups.keys()].sort((a,b)=>a-b)){
  const pending=[...groups.get(time)];
  while(pending.length){
   const compatible=pending.filter(x=>x.initial===current);
   if(compatible.length!==1)
    throw Error(compatible.length===0
     ?'Exchange startPosition discontinuity: unknown intermediate activity or missing fills'
     :'Ambiguous same-timestamp fill ordering: review required');
   const next=compatible[0];
   const idx=pending.indexOf(next);
   pending.splice(idx,1);
   const updated=current+signed*next.sz;
   if(intent.requiresReduceOnly===true &&
      (before===0n ||
       abs(updated)>abs(before) ||
       (updated!==0n && (updated>0n)!==(before>0n))))
    throw Error('Reduce-only observed fill would increase or reverse position');
   path.push(Object.freeze({time,tradeId:next.tid,
     startPosition:formatUnits(current),endPosition:formatUnits(updated),
     size:formatUnits(next.sz)}));
   current=updated;
  }
 }
 const economicDelta=sizeUnits(economics.observedFilledSize)*signed;
 if(current-before!==economicDelta)
  throw Error('Economic fill totals disagree with reconstructed position path');
 const drift=current!==after;
 return Object.freeze({mode:'READ_ONLY_FILL_POSITION_PATH',coin:intent.coin,
  exchangeOrderId:economics.exchangeOrderId,side:intent.side,
  observedPositionBefore:formatUnits(before),
  reconstructedPositionAfter:formatUnits(current),
  observedPositionAfter:formatUnits(after),
  pathMatchesObservedPosition:!drift,
  classification:drift?'POSITION_DRIFT_REQUIRES_RECONCILIATION':
   'OBSERVED_PATH_CONSISTENT_REVIEW_ONLY',
  fills:Object.freeze(path),economics,
  historyComplete:false,commitAuthorized:false,executeAuthorized:false,
  safeToResubmit:false,requiresOperatorReview:true});
}

/**
 * Combine existing conservative order-status/position settlement audit with
 * exact fill economics and a sequential position path. A corroborated result
 * STILL cannot change the DB portfolio, arm a bot, or grant any trade action.
 * Unmatched/unknown/absent leg evidence stays unresolved.
 */
export function auditPortfolioFillEconomics({
 preview,initialVaultSnapshot,legReports,nowMs,maxSnapshotAgeMs=10000
}={}){
 const batch=validateStagedPortfolioPreview(preview);
 if(preview.batchId!==batch.batchId)
  throw Error('Staged batch hash mismatch');
 const base=auditStagedPortfolioSettlement({
  preview,initialVaultSnapshot,legReports,nowMs,maxSnapshotAgeMs
 });
 const reviewed=[];
 let lastSnapshot=initialVaultSnapshot;
 for(let i=0;i<batch.legs.length;i++){
  const leg=batch.legs[i],status=base.legAudits[i],report=legReports[i];
  if(status.classification==='PRIOR_LEG_UNRESOLVED'){
   reviewed.push(Object.freeze({phase:leg.phase,classification:'PRIOR_LEG_UNRESOLVED',
    reason:'Previous reversal close is not corroborated'}));
   continue;
  }
  if(!report||!Array.isArray(report.observedFills)||!report.vaultSnapshot||
    status.exchangeStatus==='unknownOid'){
   reviewed.push(Object.freeze({phase:leg.phase,classification:'INSUFFICIENT_ECONOMIC_EVIDENCE'}));
   continue;
  }
  const before=sizeUnits(leg.netBefore),after=sizeUnits(leg.netAfter);
  const reduceOnly=before!==0n&&
    (before>0n?after>=0n:after<=0n)&&abs(after)<abs(before);
  const intended={...leg,vaultAddress:batch.vaultAddress,requiresReduceOnly:reduceOnly};
  // Validates exact order identity and reads the id, never trusts an arbitrary
  // user-supplied order ID for an unmatched client order.
  const observedStatus=assessOrderStatusEvidence(intended,report.statusResponse);
  if(!observedStatus.exchangeOrderId){
   reviewed.push(Object.freeze({phase:leg.phase,classification:'INSUFFICIENT_ECONOMIC_EVIDENCE'}));
   continue;
  }
  const path=reviewObservedPerpFillPath({
   intent:intended,exchangeOrderId:observedStatus.exchangeOrderId,
   observedFills:report.observedFills,
   positionBefore:formatUnits(sizeUnits(position(lastSnapshot,leg.coin))),
   positionAfter:formatUnits(sizeUnits(position(report.vaultSnapshot,leg.coin))),
   windowStartMs:lastSnapshot.asOfMs,
   windowEndMs:report.vaultSnapshot.asOfMs
  });
  const economicSuccess=status.classification==='CORROBORATED_REVIEW_ONLY'&&
    path.pathMatchesObservedPosition&&
    sizeUnits(path.economics.observedFilledSize)===sizeUnits(leg.size)&&
    path.reconstructedPositionAfter===formatUnits(after);
  reviewed.push(Object.freeze({phase:leg.phase,clientOrderId:leg.clientOrderId,
   classification:economicSuccess?'ECONOMIC_PATH_CORROBORATED_REVIEW_ONLY':
    'REQUIRES_RECONCILIATION',path}));
  // Only a corroborated preceding close can establish the initial
  // position/time for an opening reversal leg. For unresolved close the
  // next iteration will be blocked by base.legAudits.
  if(status.classification==='CORROBORATED_REVIEW_ONLY')lastSnapshot=report.vaultSnapshot;
 }
 const allCorroborated=base.classification==='CORROBORATED_BUT_NOT_SETTLED'&&
   reviewed.length===batch.legs.length&&reviewed.every(x=>
    x.classification==='ECONOMIC_PATH_CORROBORATED_REVIEW_ONLY');
 return Object.freeze({mode:'READ_ONLY_PORTFOLIO_FILL_ECONOMICS',
  batchId:batch.batchId,vaultAddress:batch.vaultAddress,network:batch.network,
  classification:allCorroborated?'ECONOMIC_PATH_CORROBORATED_BUT_NOT_SETTLED':
    (batch.legs.length===0?'NO_ORDER_REQUIRED_REVIEW':'REQUIRES_RECONCILIATION'),
  settlementAudit:base,economicLegAudits:Object.freeze(reviewed),
  historyComplete:false,commitAuthorized:false,executeAuthorized:false,
  safeToResubmit:false,requiresOperatorReview:true,
  caveat:'Only supplied unaggregated observed fills were checked; public history can be truncated, and no settlement or trade authority is implied'});
}

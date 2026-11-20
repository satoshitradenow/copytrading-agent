/**
 * READ-ONLY audit of a staged portfolio batch against exchange observations.
 * Never signs, submits, cancels, marks a batch settled, advances the virtual
 * ledger, or authorizes a retry. Even a corroborated report requires independent
 * human/exchange review: public account snapshots and retained fills are not
 * atomic and cannot prove a complete execution history.
 */
import {validateStagedPortfolioPreview} from './pgPortfolioBatchRepository.mjs';
import {assessOrderStatusEvidence,summarizeObservedOrderFills} from './orderEvidence.mjs';
import {validateAddress} from './hyperliquidRead.mjs';
import {sizeUnits} from './ledger.mjs';

const abs=n=>n<0n?-n:n;
function positiveMs(v,label){
  if(!Number.isSafeInteger(v)||v<=0)throw Error(`Invalid ${label}`);
  return v;
}
function checkLimit(v){
  if(!Number.isSafeInteger(v)||v<500||v>60000)throw Error('Invalid settlement snapshot age limit');
  return v;
}
function normalizedPositions(snapshot,batch,previousTime,expected,nowMs){
  if(!snapshot||snapshot.mode!=='READ_ONLY'||snapshot.network!==batch.network||
    validateAddress(snapshot.vaultAddress)!==batch.vaultAddress)
    throw Error('Settlement vault snapshot identity or network mismatch');
  const at=positiveMs(snapshot.asOfMs,'exchange snapshot time');
  if(at<previousTime||at>nowMs)throw Error('Out-of-order or future exchange snapshot');
  if(!snapshot.positions||typeof snapshot.positions!=='object'||Array.isArray(snapshot.positions))
    throw Error('Exchange positions required');
  const actual={};
  for(const [coin,amount] of Object.entries(snapshot.positions)){
    if(!/^[A-Z][A-Z0-9:_-]{0,31}$/.test(coin))throw Error('Invalid exchange market');
    actual[coin]=sizeUnits(amount);
  }
  for(const coin of new Set([...Object.keys(expected),...Object.keys(actual)])){
    const a=actual[coin]??0n,b=sizeUnits(expected[coin]??'0');
    if(a!==b)return {time:at,drift:{coin,expected:expected[coin]??'0',observed:snapshot.positions[coin]??'0'}};
  }
  return {time:at,drift:null};
}
function reduction(leg){
  const before=sizeUnits(leg.netBefore),after=sizeUnits(leg.netAfter);
  return before!==0n && (before>0n ? after>=0n : after<=0n) && abs(after)<abs(before);
}
function expectedAfterLeg(batch,leg){
  return {...batch.expectedNetBefore,[leg.coin]:leg.netAfter};
}
function auditOne(batch,leg,report,previousSnapshotTime,nowMs){
  if(!report||typeof report!=='object'||Array.isArray(report))return {
    classification:'MISSING_EVIDENCE',reasons:['MISSING_ORDER_REPORT'],nextSnapshotTime:previousSnapshotTime};
  const intended={...leg,vaultAddress:batch.vaultAddress,requiresReduceOnly:reduction(leg)};
  const result=assessOrderStatusEvidence(intended,report.statusResponse);
  if(result.exchangeStatus==='unknownOid')return {
    classification:'UNCONFIRMED',exchangeStatus:'unknownOid',reasons:['UNKNOWN_OID_NOT_NONEXECUTION'],nextSnapshotTime:previousSnapshotTime};
  if(!Array.isArray(report.observedFills))return {
    classification:'UNCONFIRMED',exchangeStatus:result.exchangeStatus,reasons:['FILL_HISTORY_MISSING'],nextSnapshotTime:previousSnapshotTime};
  const fills=summarizeObservedOrderFills({intent:intended,exchangeOrderId:result.exchangeOrderId,fills:report.observedFills});
  const reasons=[];
  if(!Number.isSafeInteger(result.statusTimestamp)||result.statusTimestamp<=0)
    reasons.push('ORDER_STATUS_TIMESTAMP_MISSING');
  else if(result.statusTimestamp<previousSnapshotTime)
    reasons.push('ORDER_STATUS_PRECEDES_PREVIOUS_SNAPSHOT');
  // Do not assume a terminal cancellation is an unfilled order; the exchange may
  // have filled a portion first, or the fill-history window may be truncated.
  if(result.exchangeStatus!=='filled')reasons.push('NOT_REPORTED_FULLY_FILLED');
  if(sizeUnits(fills.observedFilledSize)!==sizeUnits(leg.size))reasons.push('OBSERVED_SIZE_INCOMPLETE');
  for(const row of report.observedFills){
    const oid=typeof row?.oid==='string'?row.oid:Number.isSafeInteger(row?.oid)?String(row.oid):null;
    if(oid!==result.exchangeOrderId)continue;
    const time=positiveMs(row.time,'observed fill timestamp');
    if(time<previousSnapshotTime||time>nowMs)throw Error('Exchange fill time precedes previous vault snapshot or is future');
    if(Number.isSafeInteger(result.statusTimestamp) && time>result.statusTimestamp)
      reasons.push('ORDER_STATUS_PRECEDES_OBSERVED_FILL');
    if(report.vaultSnapshot && Number.isSafeInteger(report.vaultSnapshot.asOfMs) && time>report.vaultSnapshot.asOfMs)
      reasons.push('POST_ORDER_SNAPSHOT_PRECEDES_FILL');
  }
  if(!report.vaultSnapshot)reasons.push('POST_ORDER_VAULT_SNAPSHOT_MISSING');
  else {
    const snap=normalizedPositions(report.vaultSnapshot,batch,previousSnapshotTime,
      expectedAfterLeg(batch,leg),nowMs);
    if(snap.drift)reasons.push(`POST_ORDER_POSITION_DRIFT:${snap.drift.coin}`);
    if(Number.isSafeInteger(result.statusTimestamp) &&
       snap.time<result.statusTimestamp)reasons.push('SNAPSHOT_PRECEDES_ORDER_STATUS');
    return {classification:reasons.length?'RECONCILIATION_REQUIRED':'CORROBORATED_REVIEW_ONLY',
      exchangeStatus:result.exchangeStatus,observedSize:fills.observedFilledSize,
      exchangeOrderId:result.exchangeOrderId,reasons,nextSnapshotTime:snap.time};
  }
  return {classification:'RECONCILIATION_REQUIRED',exchangeStatus:result.exchangeStatus,
    observedSize:fills.observedFilledSize,exchangeOrderId:result.exchangeOrderId,
    reasons,nextSnapshotTime:previousSnapshotTime};
}
/**
 * Evidence is from externally acquired read-only order status, fill history,
 * and *historically observed* account snapshots. This result NEVER promotes a
 * source journal record, resolves a DB batch or sends a trade. Independent
 * operator adjudication plus durable exchange reconciliation remain necessary.
 */
export function auditStagedPortfolioSettlement({preview,initialVaultSnapshot,legReports,nowMs,maxSnapshotAgeMs=10000}){
  const now=positiveMs(nowMs,'audit time'),maxAge=checkLimit(maxSnapshotAgeMs);
  const batch=validateStagedPortfolioPreview(preview);
  if(preview.batchId!==batch.batchId)throw Error('Staged portfolio batch hash mismatch; fail closed');
  if(!Array.isArray(legReports)||legReports.length!==batch.legs.length)
    throw Error('Expected one explicit evidence slot per planned order leg');
  const start=normalizedPositions(initialVaultSnapshot,batch,0,batch.expectedNetBefore,now);
  if(start.drift)throw Error(`Pre-order vault position drift: ${start.drift.coin}`);
  let previousTime=start.time;
  const audited=[];
  for(let i=0;i<batch.legs.length;i++){
    const leg=batch.legs[i];
    if(i>0&&audited[i-1].classification!=='CORROBORATED_REVIEW_ONLY'){
      audited.push(Object.freeze({phase:leg.phase,clientOrderId:leg.clientOrderId,
        classification:'PRIOR_LEG_UNRESOLVED',reasons:['CLOSE_LEG_NOT_CONFIRMED'],
        nextSnapshotTime:previousTime}));
      continue;
    }
    const result=auditOne(batch,leg,legReports[i],previousTime,now);
    previousTime=result.nextSnapshotTime;
    audited.push(Object.freeze({phase:leg.phase,clientOrderId:leg.clientOrderId,...result}));
  }
  const last=batch.legs.length ? audited.at(-1) : null;
  const lastSnapshotTime=batch.legs.length?last.nextSnapshotTime:start.time;
  const reasons=[];
  if(batch.legs.length===0){
    if(now-start.time>maxAge)reasons.push('LAST_VAULT_SNAPSHOT_STALE');
  }else{
    if(!last||last.classification!=='CORROBORATED_REVIEW_ONLY')reasons.push('LEG_EVIDENCE_UNRESOLVED');
    if(now-lastSnapshotTime>maxAge)reasons.push('LAST_VAULT_SNAPSHOT_STALE');
  }
  return Object.freeze({mode:'READ_ONLY_SETTLEMENT_AUDIT',batchId:batch.batchId,
    vaultAddress:batch.vaultAddress,network:batch.network,
    classification:reasons.length?'REQUIRES_RECONCILIATION':
      (batch.legs.length?'CORROBORATED_BUT_NOT_SETTLED':'NO_ORDER_REQUIRED_REVIEW'),
    legAudits:Object.freeze(audited),reasons,
    safeToResubmit:false,executeAuthorized:false,commitAuthorized:false,
    historyComplete:false,requiresOperatorReview:true,
    caveat:'Retained public order/fill/position observations are not an atomic proof of complete exchange settlement'});
}
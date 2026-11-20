/**
 * SOURCE EVENT -> MULTI-TRADER VAULT NETTING PREVIEW (SHADOW ONLY).
 *
 * Purely hypothetical: no exchange client, signer, order sender, database
 * write, or vault mutation. Critically, the desired virtual net book is NOT
 * assumed to have settled on Hyperliquid. Every preview checks it against a
 * new public vault account snapshot, and fails closed on any drift.
 *
 * Production requires a single DB transaction joining the source event,
 * virtual allocation journal, order intents and confirmed exchange outcomes.
 * The contemporaneous equity observation is an approximation, NOT exact
 * historical equity; missing source transfers or further fills are blockers.
 */
import {createHash} from 'node:crypto';
import {ShadowLedger,MemoryJournal,sizeUnits,formatUnits,moneyUnits} from './ledger.mjs';
import {validateAddress} from './hyperliquidRead.mjs';
import {validateIntentSpec} from './intentLedger.mjs';

const abs=n=>n<0n?-n:n;
function checkTime(value,name){
  if(!Number.isSafeInteger(value)||value<=0)throw Error(`Invalid ${name}`);
  return value;
}
function validateNetwork(network){
  if(!['mainnet','testnet'].includes(network))throw Error('Explicit mainnet/testnet network required');
  return network;
}
function portfolioSnapshot(ledger){return ledger.snapshot();}
function assertObservedVault({vaultAddress,network,vaultSnapshot,expected,nowMs,maxAgeMs}){
  if(!vaultSnapshot||vaultSnapshot.mode!=='READ_ONLY'||validateAddress(vaultSnapshot.vaultAddress)!==vaultAddress)
    throw Error('Vault identity mismatch or missing READ_ONLY account snapshot');
  if(vaultSnapshot.network!==network)throw Error('Vault observation from wrong network');
  const asOf=checkTime(vaultSnapshot.asOfMs,'vault snapshot time');
  if(asOf>nowMs||nowMs-asOf>maxAgeMs)throw Error('Stale or future vault account snapshot');
  if(!vaultSnapshot.positions||typeof vaultSnapshot.positions!=='object'||Array.isArray(vaultSnapshot.positions))
    throw Error('Invalid observed vault position map');
  const observed=vaultSnapshot.positions;
  const coins=new Set([...Object.keys(expected),...Object.keys(observed)]);
  for(const coin of coins){
    if(!/^[A-Z][A-Z0-9:_-]{0,31}$/.test(coin))throw Error('Unrecognized exchange market in vault state');
    const expectedUnits=sizeUnits(expected[coin]??'0');
    const actualUnits=sizeUnits(observed[coin]??'0');
    if(actualUnits!==expectedUnits)throw Error(`VAULT_POSITION_DRIFT:${coin}: expected ${formatUnits(expectedUnits)}, observed ${formatUnits(actualUnits)}; require exchange reconciliation`);
  }
}
function verifiedObservation(fill,network,observation,nowMs,maxAgeMs){
  const trader=validateAddress(fill?.trader);
  const eventMs=checkTime(fill?.timeMs,'source fill time');
  if(eventMs>nowMs)throw Error('Source fill appears to come from future');
  if(fill.sourceStartPosition===undefined)throw Error('Source startPosition required for safe copy');
  const first=sizeUnits(fill.sourceStartPosition);
  if(!['buy','sell'].includes(fill.side))throw Error('Invalid source trade direction');
  const size=sizeUnits(fill.size);
  if(size<=0n)throw Error('Positive source fill size required');
  if(!observation||observation.mode!=='READ_ONLY'||validateAddress(observation.trader)!==trader||observation.network!==network)
    throw Error('Source equity observation identity/network mismatch');
  const start=checkTime(observation.observedAtStartMs,'source observation start');
  const end=checkTime(observation.observedAtEndMs,'source observation end');
  if(start>end||end>nowMs||end<eventMs||end-eventMs>maxAgeMs||nowMs-end>maxAgeMs)
    throw Error('Stale, missing, or non-contemporaneous source equity evidence');
  const equity=moneyUnits(observation.accountValueUsd);
  if(equity<=0n)throw Error('Source equity observation must be positive');
  if(fill.sourceEquityUsd!==undefined && moneyUnits(fill.sourceEquityUsd)!==equity)
    throw Error('Supplied source equity disagrees with observed equity');
  if(!Array.isArray(observation.positions))throw Error('Source positions missing from observation');
  const seen=new Set();let afterObserved=0n;
  for(const row of observation.positions){
    const pos=row?.position;
    if(typeof pos?.coin!=='string'||typeof pos?.szi!=='string'||seen.has(pos.coin))
      throw Error('Malformed or duplicate source account positions');
    seen.add(pos.coin);
    if(pos.coin===fill.coin)afterObserved=sizeUnits(pos.szi);
  }
  const expectedAfter=first+(fill.side==='buy'?size:-size);
  if(afterObserved!==expectedAfter)
    throw Error('Source post-fill position disagrees with contemporaneous account snapshot');
  return {trader,fill:{...fill,sourceEquityUsd:formatUnits(equity,1_000_000n)},
    observationLagMs:end-eventMs,sourcePositionAfter:formatUnits(expectedAfter)};
}
function deterministicFillLeg(fillKey,phase){
  const digest=createHash('sha256').update(`hl-vault-v2-source-fill\n${fillKey}\n${phase}`).digest('hex');
  return `source:${digest}:${phase}`;
}
function proposal({vaultAddress,coin,sourceFillKey,phase,from,to}){
  const before=sizeUnits(from),after=sizeUnits(to),delta=after-before;
  if(delta===0n)throw Error('Zero-size portfolio leg forbidden');
  return Object.freeze({...validateIntentSpec({
    mode:'SHADOW_ONLY',vaultAddress,fillKey:deterministicFillLeg(sourceFillKey,phase),
    coin,side:delta>0n?'buy':'sell',size:formatUnits(abs(delta)),
    netBefore:formatUnits(before),netAfter:formatUnits(after)
  }),phase,requiresPriorLegConfirmation:phase==='open-after-close'});
}
function splitCrossingIntent({vaultAddress,sourceFillKey,coin,before,after}){
  const a=sizeUnits(before),b=sizeUnits(after);
  if(a===b)return [];
  if(a!==0n&&b!==0n&&(a>0n)!==(b>0n)){
    return [
      proposal({vaultAddress,coin,sourceFillKey,phase:'close-first',from:before,to:'0'}),
      proposal({vaultAddress,coin,sourceFillKey,phase:'open-after-close',from:'0',to:after})
    ];
  }
  return [proposal({vaultAddress,coin,sourceFillKey,phase:'net',from:before,to:after})];
}

/**
 * Immutable preview from an explicit externally reconciled source+vault state.
 * A preview does not advance source capture, update virtual exposures, or put
 * anything in an exchange submission queue.
 */
export class ShadowPortfolioNetting {
  constructor({vaultAddress,network='mainnet',traders,allowedCoins,journal=new MemoryJournal(),maxObservationAgeMs=2000}){
    this.vaultAddress=validateAddress(vaultAddress);
    this.network=validateNetwork(network);
    if(!Number.isSafeInteger(maxObservationAgeMs)||maxObservationAgeMs<100||maxObservationAgeMs>5000)
      throw Error('Invalid maximum observation age');
    if(!journal||typeof journal.readAll!=='function')throw Error('Read-only virtual journal required');
    this.maxObservationAgeMs=maxObservationAgeMs;
    this.journal=journal;this.traders=traders;this.allowedCoins=allowedCoins;
    new ShadowLedger({traders,allowedCoins,journal}); // Validate parameters and persisted records now.
  }

  preview({fill,sourceObservation,vaultSnapshot,unresolvedIntents,nowMs}){
    const now=checkTime(nowMs,'current time');
    // An undefined pending-intent set is NOT proof that no orders are in flight.
    if(!Array.isArray(unresolvedIntents))throw Error('Verified unresolved-intent list required');
    if(unresolvedIntents.length!==0)throw Error('Unresolved exchange order blocks new leader event');
    const ledger=new ShadowLedger({traders:this.traders,allowedCoins:this.allowedCoins,journal:new MemoryJournal(this.journal.readAll())});
    const before=portfolioSnapshot(ledger);
    assertObservedVault({vaultAddress:this.vaultAddress,network:this.network,
      vaultSnapshot,expected:before.net,nowMs:now,maxAgeMs:this.maxObservationAgeMs});
    const attested=verifiedObservation(fill,this.network,sourceObservation,now,this.maxObservationAgeMs);
    const result=ledger.applyFill(attested.fill);
    if(result.status==='duplicate')return Object.freeze({mode:'SHADOW_ONLY',status:'DUPLICATE',intents:[],
      sourceFillKey:result.fillKey,virtualLedgerUnchanged:true});
    const after=ledger.snapshot();
    const journalRows=ledger.journal.readAll();
    const sourceJournalRecord=journalRows[journalRows.length-1];
    if(sourceJournalRecord?.fillKey!==result.fillKey ||
       !/^[a-f0-9]{64}$/.test(sourceJournalRecord.fillDigest||''))
      throw Error('Missing immutable source journal fingerprint in preview');
    const coin=fill.coin.toUpperCase();
    const intents=splitCrossingIntent({vaultAddress:this.vaultAddress,sourceFillKey:result.fillKey,
      coin,before:before.net[coin]??'0',after:after.net[coin]??'0'});
    return Object.freeze({mode:'SHADOW_ONLY',status:'PREVIEW_ONLY',vaultAddress:this.vaultAddress,
      network:this.network,sourceFillKey:result.fillKey,sourceObservationLagMs:attested.observationLagMs,
      sourceEquityQuality:'RECENT_SNAPSHOT_NOT_HISTORICAL_PROOF',
      requiresSequentialSettlement:intents.length>1,intents:Object.freeze(intents),
      expectedNetBefore:Object.freeze({...before.net}),desiredNetAfter:Object.freeze({...after.net}),
      projectedVirtual:Object.freeze({...after.virtual}),
      proposedSourceJournalRecord:Object.freeze({...sourceJournalRecord}),
      // Source acceptance and the actual exchange fill must be committed
      // transactionally with intent state; this preview grants no authority.
      commitAuthorized:false,executeAuthorized:false,
    });
  }
}
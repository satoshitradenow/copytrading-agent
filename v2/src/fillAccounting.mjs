/**
 * Pure SHADOW-ONLY accounting of INDIVIDUALLY observed Hyperliquid perpetual
 * fills. No exchange calls, portfolio settlement, order authorization or
 * assumed history completeness. The caller must source raw, unaggregated
 * userFillsByTime data (aggregateByTime:false) and independently verify the
 * account, order status and vault positions.
 *
 * All arithmetic uses BigInt fixed-point decimals; never JS floats.
 * Fees are counted only in an explicitly specified single denomination.
 * Hyperliquid documents 'fee' as inclusive of any optional builderFee;
 * builderFee is reported separately for attribution, NEVER added a second time.
 */
import {sizeUnits,moneyUnits,formatUnits} from './ledger.mjs';

const MONEY=1000000n,SIZE=100000000n,NOTIONAL=MONEY*SIZE;
const MAX_U64=(1n<<64n)-1n;
const COIN=/^[A-Z][A-Z0-9:_-]{0,31}$/;
function oid(value,label){
 const v=typeof value==='string'?value:(Number.isSafeInteger(value)&&value>=0?String(value):null);
 if(v===null||! /^(0|[1-9][0-9]*)$/.test(v)||BigInt(v)>MAX_U64)
  throw Error('Unsafe or missing '+label);
 return v;
}
function exactMoney(v,label,{positive=false}={}){
 if(typeof v!=='string')throw Error(label+' must be an exact decimal string');
 const n=moneyUnits(v);
 if(positive&&n<=0n)throw Error(label+' must be positive');
 return n;
}
function exactSize(v,label){
 if(typeof v!=='string')throw Error(label+' must be a decimal string');
 const n=sizeUnits(v);
 if(n<=0n)throw Error(label+' must be positive');
 return n;
}
function optionalMoney(fill,key){
 return fill[key]===undefined||fill[key]===null?null:exactMoney(fill[key],key);
}
function optionalPosition(fill){
 if(fill.startPosition===undefined||fill.startPosition===null)return null;
 if(typeof fill.startPosition!=='string')throw Error('startPosition must be a decimal string');
 return formatUnits(sizeUnits(fill.startPosition));
}
function fillRecord(fill,{intent,exchangeOrderId,feeToken}){
 const tradeId=oid(fill.tid,'trade ID');
 if(fill.coin!==intent.coin||fill.side!==(intent.side==='buy'?'B':'A'))
  throw Error('Fill market or side disagrees with the intended order');
 const size=exactSize(fill.sz,'fill size');
 const price=exactMoney(fill.px,'fill price',{positive:true});
 if(fill.feeToken!==feeToken)
  throw Error('Unexpected/missing fee token; never combine denominations');
 const fee=exactMoney(fill.fee,'fill fee');
 const pnl=exactMoney(fill.closedPnl,'closed PnL');
 const builder=optionalMoney(fill,'builderFee');
 if(!Number.isSafeInteger(fill.time)||fill.time<=0)
  throw Error('Invalid exchange fill timestamp');
 if(fill.hash!==undefined&&(typeof fill.hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(fill.hash)))
  throw Error('Invalid exchange transaction hash');
 if(fill.crossed!==undefined&&typeof fill.crossed!=='boolean')
  throw Error('Invalid crossed flag');
 if(fill.dir!==undefined&&(typeof fill.dir!=='string'||fill.dir.length>80))
  throw Error('Invalid trade direction');
 const base={exchangeOrderId,tradeId,coin:fill.coin,side:fill.side,
  size:formatUnits(size),price:formatUnits(price,MONEY),
  fee:formatUnits(fee,MONEY),closedPnl:formatUnits(pnl,MONEY),
  builderFee:builder===null?null:formatUnits(builder,MONEY),
  time:fill.time,startPosition:optionalPosition(fill),
  transactionHash:fill.hash?.toLowerCase()??null,
  crossed:fill.crossed??null,dir:fill.dir??null};
 return {base,size,price,fee,pnl,builder};
}
export function summarizePerpFillEconomics({intent,exchangeOrderId,observedFills,feeToken='USDC'}={}){
 if(!intent||typeof intent!=='object'||!COIN.test(intent.coin||'')||
  !['buy','sell'].includes(intent.side))throw Error('Validated order intent required');
 const expected=exactSize(intent.size,'intended order size');
 const orderId=oid(exchangeOrderId,'exchange order ID');
 if(feeToken!=='USDC')throw Error('Only explicitly USDC-denominated perpetual fees supported');
 if(!Array.isArray(observedFills)||observedFills.length>20000)
  throw Error('Bounded unaggregated fill history array required');
 const unique=new Map();
 for(const fill of observedFills){
  if(!fill||typeof fill!=='object'||Array.isArray(fill))
   throw Error('Malformed exchange fill');
  const foundOid=oid(fill.oid,'observed order ID');
  if(foundOid!==orderId)continue; // OTHER account orders must be audited separately.
  const found=fillRecord(fill,{intent,exchangeOrderId:orderId,feeToken});
  const old=unique.get(found.base.tradeId);
  if(old){
   if(JSON.stringify(old.base)!==JSON.stringify(found.base))
    throw Error('Conflicting economic fields for the same exchange trade ID');
   continue;
  }
  unique.set(found.base.tradeId,found);
 }
 let filled=0n,notional=0n,fees=0n,pnl=0n,builder=0n;
 for(const f of unique.values()){
  filled+=f.size;
  notional+=f.size*f.price;  // 14-decimal USD exact notional, no per-fill rounding.
  fees+=f.fee;
  pnl+=f.pnl;
  if(f.builder!==null)builder+=f.builder;
 }
 if(filled>expected)throw Error('Observed individual fills exceed intended order size');
 return Object.freeze({mode:'READ_ONLY_FILL_ECONOMICS',exchangeOrderId:orderId,
  coin:intent.coin,side:intent.side,feeToken,fillCount:unique.size,
  observedFilledSize:formatUnits(filled),
  remainingUnverifiedSize:formatUnits(expected-filled),
  observedGrossNotionalUsd:formatUnits(notional,NOTIONAL),
  observedFeeUsd:formatUnits(fees,MONEY),
  observedClosedPnlUsd:formatUnits(pnl,MONEY),
  observedBuilderFeeUsdSeparate:formatUnits(builder,MONEY),
  builderFeeIncludedInFeeTotal:'YES_PER_HYPERLIQUID_API_DOCS',
  feeIncludesBuilderFee:true,
  observedClosedPnlNetOfFillFeesUsd:formatUnits(pnl-fees,MONEY),
  historyComplete:false,commitAuthorized:false,executeAuthorized:false,
  safeToResubmit:false,requiresOperatorReview:true,
  caveat:'Totals cover only matched, uniquely observed fills; no funding, unobserved fills, margin movements, or full PnL assurance'});
}

/**
 * Return the exact canonical per-trade economics used by the read-only
 * summary. Allows an independently indexed review to detect the same
 * exchange TID being attributed to multiple source events or mutated after
 * a crash/restart. The summary validation also rejects missing/inexact fees,
 * overfills and duplicate trade IDs with conflicting economics.
 */
export function listValidatedPerpOrderFills(args={}){
 const summary=summarizePerpFillEconomics(args);
 const {intent,observedFills,feeToken='USDC'}=args;
 const unique=new Map();
 for(const raw of observedFills){
  if(oid(raw.oid,'observed order ID')!==summary.exchangeOrderId)continue;
  const found=fillRecord(raw,{intent,exchangeOrderId:summary.exchangeOrderId,feeToken});
  const key=found.base.tradeId,prev=unique.get(key);
  if(prev!==undefined && JSON.stringify(prev)!==JSON.stringify(found.base))
   throw Error('Conflicting economics for replayed exchange TID');
  unique.set(key,found.base);
 }
 if(unique.size!==summary.fillCount)throw Error('Fill registry disagrees with validated order size');
 return Object.freeze([...unique.values()]
   .sort((a,b)=>BigInt(a.tradeId)<BigInt(b.tradeId)?-1:BigInt(a.tradeId)>BigInt(b.tradeId)?1:0)
   .map(f=>Object.freeze({...f})));
}

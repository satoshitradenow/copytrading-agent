/**
 * Pure, fail-closed vault-level SHADOW risk assessment.
 * No signer, no trading API and no place-order function.
 * Actual execution requires an independent on-exchange confirmation pipeline.
 */
import {validateAddress} from './hyperliquidRead.mjs';
import {validateIntentSpec} from './intentLedger.mjs';
import {sizeUnits,moneyUnits,formatUnits} from './ledger.mjs';

const SIZE_SCALE=100000000n, MONEY_SCALE=1000000n;
const POSITIVE_INT=v=>Number.isSafeInteger(v)&&v>0;
const abs=n=>n<0n?-n:n;
function usdNotional(size,mark) {return abs(size)*mark/SIZE_SCALE;}
function parsePositions(positions,marks) {
  if (!positions || typeof positions!=='object' || Array.isArray(positions))throw Error('Normalized vault position map required');
  const result=new Map();
  for(const [coin,value] of Object.entries(positions)){
    if(!/^[A-Z0-9:_-]{1,32}$/.test(coin))throw Error('Invalid vault market');
    const pos=sizeUnits(value);
    if(pos!==0n && !Object.hasOwn(marks,coin)) throw Error('Unpriced vault exposure; fail closed');
    result.set(coin,pos);
  }
  return result;
}
function parsePolicy(policy) {
  if(!policy || typeof policy!=='object')throw Error('Explicit risk policy required');
  const required=['maxGrossLeverageBps','maxMarketNotionalBps','maxOrderNotionalUsd','maxSnapshotAgeMs'];
  for(const k of required)if(!(k in policy))throw Error(`Missing risk control ${k}`);
  if(!POSITIVE_INT(policy.maxGrossLeverageBps)||policy.maxGrossLeverageBps>50000)throw Error('Invalid gross leverage cap');
  if(!POSITIVE_INT(policy.maxMarketNotionalBps)||policy.maxMarketNotionalBps>30000)throw Error('Invalid per-market cap');
  if(!POSITIVE_INT(policy.maxSnapshotAgeMs)||policy.maxSnapshotAgeMs>60000)throw Error('Invalid max age');
  const maxOrder=moneyUnits(policy.maxOrderNotionalUsd);
  if(maxOrder<=0n)throw Error('Invalid max order cap');
  return {gross:BigInt(policy.maxGrossLeverageBps),market:BigInt(policy.maxMarketNotionalBps),maxOrder,maxAge:policy.maxSnapshotAgeMs};
}

/**
 * @param {{ mode:'SHADOW_ONLY',coin:string,side:string,size:string,netBefore:string,netAfter:string }} intent
 * @param {{vaultAddress:string,accountValueUsd:string,asOfMs:number,positions:Record<string,string>,marks:Record<string,string>}} snapshot
 * @param {{maxGrossLeverageBps:number,maxMarketNotionalBps:number,maxOrderNotionalUsd:string,maxSnapshotAgeMs:number}} policy
 * @param {number} nowMs - explicit clock to make safety checks deterministic
 */
export function assessShadowVaultRisk(intent,snapshot,policy,nowMs){
  if(!intent || intent.mode!=='SHADOW_ONLY')throw Error('Only SHADOW_ONLY intents supported');
  const spec=validateIntentSpec(intent);
  if(!snapshot || typeof snapshot!=='object')throw Error('Vault state required');
  validateAddress(snapshot.vaultAddress);
  if(!POSITIVE_INT(nowMs)||!POSITIVE_INT(snapshot.asOfMs)||snapshot.asOfMs>nowMs)throw Error('Invalid snapshot clock');
  const limits=parsePolicy(policy);
  if(typeof intent.coin!=='string'||!/^[A-Z0-9:_-]{1,32}$/.test(intent.coin))throw Error('Invalid proposed market');
  if(!snapshot.marks || typeof snapshot.marks!=='object')throw Error('Trusted mark-price map required');
  if(!Object.hasOwn(snapshot.marks,intent.coin))throw Error('Market missing trusted price');
  // allMids includes unrelated spot and HIP-3 identifiers such as @1;
  // never reject a permitted vault trade because an unused price key is
  // formatted differently. Validate *only* the target plus open positions.
  const positions=parsePositions(snapshot.positions,snapshot.marks);
  const requiredMarkets=new Set([intent.coin,...[...positions].filter(([,size])=>size!==0n).map(([coin])=>coin)]);
  const marks=new Map();
  for(const coin of requiredMarkets){
    if(!Object.hasOwn(snapshot.marks,coin))throw Error('Missing required market mark');
    const px=moneyUnits(snapshot.marks[coin]);
    if(px<=0n)throw Error('Invalid required market mark');
    marks.set(coin,px);
  }
  const equity=moneyUnits(snapshot.accountValueUsd);
  if(equity<=0n)throw Error('Vault account equity must be positive');
  const before=sizeUnits(intent.netBefore),after=sizeUnits(intent.netAfter),quantity=sizeUnits(intent.size);
  if(quantity<=0n)throw Error('Order intent must be positive sized delta');
  const signed=intent.side==='buy'?quantity:intent.side==='sell'?-quantity:null;
  if(signed===null||after-before!==signed)throw Error('Intent size, side and post-state inconsistent');
  const observed=positions.get(intent.coin)??0n;
  const failures=[];
  if(validateAddress(snapshot.vaultAddress)!==spec.vaultAddress) failures.push('VAULT_ADDRESS_MISMATCH');
  if(observed!==before)failures.push('VAULT_POSITION_MISMATCH');
  if(nowMs-snapshot.asOfMs>limits.maxAge)failures.push('STALE_VAULT_SNAPSHOT');
  const mark=marks.get(intent.coin);
  const orderNotional=usdNotional(quantity,mark);
  const oldMarketNotional=usdNotional(observed,mark);
  const newMarketNotional=usdNotional(after,mark);
  let priorGross=0n,nextGross=0n;
  for(const [coin,pos] of positions){
    const px=marks.get(coin);
    if(pos!==0n && !px)throw Error('Existing vault position without mark; fail closed');
    if(px)priorGross+=usdNotional(pos,px);
  }
  nextGross=priorGross-oldMarketNotional+newMarketNotional;
  const isPureReduction=observed!==0n &&
    (observed>0n ? after>=0n : after<=0n) &&
    abs(after)<abs(observed) && nextGross<=priorGross;
  if(!isPureReduction){
    if(orderNotional>limits.maxOrder)failures.push('MAX_ORDER_NOTIONAL');
    if(newMarketNotional*10000n>equity*limits.market)failures.push('MARKET_CONCENTRATION');
    if(nextGross*10000n>equity*limits.gross)failures.push('GROSS_LEVERAGE');
  }
  return Object.freeze({mode:'SHADOW_ONLY',allowed:failures.length===0,failures,requiresReduceOnly:isPureReduction,intentId:spec.intentId,
    vaultAddress:validateAddress(snapshot.vaultAddress),coin:intent.coin,
    orderNotionalUsd:formatUnits(orderNotional,MONEY_SCALE),
    grossBeforeUsd:formatUnits(priorGross,MONEY_SCALE),
    grossAfterUsd:formatUnits(nextGross,MONEY_SCALE),
    vaultEquityUsd:formatUnits(equity,MONEY_SCALE),
  });
}

/** Convert Hyperliquid clearinghouse assetPositions into signed sizes without guessing. */
export function normalizeVaultPositions(assetPositions){
  if(!Array.isArray(assetPositions))throw Error('Missing exchange vault position array');
  const map={};
  for(const item of assetPositions){
    const position=item?.position;
    if(!position||typeof position.coin!=='string'||typeof position.szi!=='string')throw Error('Malformed Hyperliquid vault position');
    if(Object.hasOwn(map,position.coin))throw Error('Duplicate market in exchange state');
    sizeUnits(position.szi); // reject unsupported precision or exponent notation
    map[position.coin]=position.szi;
  }
  return map;
}
/**
 * SHADOW-ONLY estimated execution cost / trade-frequency guard.
 * Never signs or submits. A future live pipeline MUST read the complete,
 * durable exchange-attempt history transactionally under the vault writer
 * lease before applying these limits. The estimate is a stress bound, NOT
 * actual fees, profit, available liquidity, or alpha.
 */
import {validateIntentSpec} from './intentLedger.mjs';
import {sizeUnits,moneyUnits,formatUnits} from './ledger.mjs';
const SIZE=100000000n,USD=1000000n,BPS=10000n;
const HOUR=3600000,DAY=86400000;
function integer(value,name,min,max){
  if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(`Invalid ${name}`);
  return value;
}
function ceilDiv(a,b){return (a+b-1n)/b;}
/** Throttles increasing positions but deliberately does not strand urgent
 * reduce-only orders just because their per-day cost quota is exhausted. */
export function assessShadowTradeEconomics({intent,orderPreview,history,policy,nowMs}){
  const spec=validateIntentSpec(intent);
  if(!orderPreview || orderPreview.mode!=='SHADOW_ONLY'||orderPreview.sendAllowed!==false ||
    orderPreview.signingAllowed!==false ||orderPreview.intentId!==spec.intentId||
    orderPreview.vaultAddress!==spec.vaultAddress ||orderPreview.coin!==spec.coin||
    orderPreview.orderSize!==spec.size ||orderPreview.wireOrderPreview?.c!==spec.clientOrderId ||
    orderPreview.wireOrderPreview?.b!==(spec.side==='buy') ||
    orderPreview.wireOrderPreview?.r!==orderPreview.requiresReduceOnly ||
    orderPreview.wireOrderPreview?.s!==spec.size ||
    orderPreview.wireOrderPreview?.p!==orderPreview.limitPx ||
    orderPreview.wireOrderPreview?.t?.limit?.tif!=='Ioc' ||
    !Number.isSafeInteger(orderPreview.assetIndex) ||orderPreview.assetIndex<0 ||
    orderPreview.wireOrderPreview?.a!==orderPreview.assetIndex ||
    !['mainnet','testnet'].includes(orderPreview.network))
      throw Error('Unsigned order preview does not match intended portfolio delta');
  const now=integer(nowMs,'current time',1,Number.MAX_SAFE_INTEGER);
  if(!policy||typeof policy!=='object')throw Error('Explicit execution economics policy required');
  integer(orderPreview.maxSlippageBps,'IOC maximum slippage',0,500);
  const feeBps=integer(policy.assumedTakerFeeBps,'assumed fee basis points',0,100);
  const slipBps=integer(policy.assumedSlippageBps,'assumed slippage basis points',0,500);
  const maxOrderCost=moneyUnits(policy.maxPerOrderEstimatedCostUsd);
  const dailyBudget=moneyUnits(policy.maxDailyEstimatedCostUsd);
  const minEconomic=moneyUnits(policy.minEconomicNotionalUsd);
  const cooldown=integer(policy.marketCooldownMs,'market cooldown',0,86400000);
  const hourly=integer(policy.maxOrdersPerHour,'hourly order limit',1,100);
  const daily=integer(policy.maxOrdersPerDay,'daily order limit',1,1000);
  if(maxOrderCost<=0n||dailyBudget<=0n||minEconomic<=0n)
    throw Error('Explicit positive order-cost, daily-cost and minimum-notional limits required');
  if(!history||history.mode!=='DURABLE_ATTEMPT_LOG'||!Array.isArray(history.orders)||
    !Number.isSafeInteger(history.coveredFromMs)||history.coveredFromMs>now-DAY ||
    !Number.isSafeInteger(history.asOfMs)||history.asOfMs>now || now-history.asOfMs>1000 ||
    history.vaultAddress!==spec.vaultAddress ||history.network!==orderPreview.network)
    throw Error('Incomplete, stale or wrong-account durable trading-cost history');
  if(orderPreview.maxSlippageBps < slipBps)throw Error('Assumed slippage exceeds order preview protection');
  const notional=sizeUnits(spec.size)*moneyUnits(orderPreview.limitPx)/SIZE;
  if(notional<=0n)throw Error('Order notional must be positive');
  const cost=ceilDiv(notional*BigInt(feeBps+slipBps),BPS);
  let dailySpent=0n,ordersHour=0,ordersDay=0,lastForMarket=-Infinity;
  const seen=new Set();
  for(const order of history.orders){
    if(typeof order?.clientOrderId!=='string'||!/^0x[0-9a-f]{32}$/.test(order.clientOrderId)||seen.has(order.clientOrderId))
      throw Error('Duplicate or invalid prior exchange attempt ID');
    seen.add(order.clientOrderId);
    const at=integer(order.atMs,'prior attempt time',1,Number.MAX_SAFE_INTEGER);
    if(at>now)throw Error('Exchange attempt timestamp in future');
    if(!['SUBMITTED','FILLED','PARTIAL','REJECTED','CANCELED','UNKNOWN'].includes(order.status))
      throw Error('Unknown historical exchange attempt status');
    if(order.status==='UNKNOWN'||order.status==='PARTIAL'||order.status==='SUBMITTED')
      throw Error('Outstanding or uncertain order prevents another source execution');
    const priorCost=moneyUnits(order.estimatedMaxCostUsd);
    if(priorCost<0n)throw Error('Negative prior estimated execution cost');
    if(at>now-DAY){
      ordersDay++;dailySpent+=priorCost;
      if(at>now-HOUR)ordersHour++;
      if(order.coin===spec.coin&&at>lastForMarket)lastForMarket=at;
    }
  }
  const before=sizeUnits(spec.netBefore),after=sizeUnits(spec.netAfter);
  const isReduction=before!==0n && (after===0n ||
    (after!==0n && (before>0n)===(after>0n) &&
     (after<0n?-after:after)<(before<0n?-before:before)));
  if(orderPreview.requiresReduceOnly!==isReduction)
    throw Error('Reduce-only preview disagrees with the actual intended position reduction');
  const reasons=[];
  if(!isReduction){
    if(notional<minEconomic)reasons.push('BELOW_MIN_ECONOMIC_NOTIONAL');
    if(cost>maxOrderCost)reasons.push('MAX_ESTIMATED_ORDER_COST');
    if(cost+dailySpent>dailyBudget)reasons.push('DAILY_ESTIMATED_COST_BUDGET');
    if(ordersHour>=hourly)reasons.push('HOURLY_ORDER_LIMIT');
    if(ordersDay>=daily)reasons.push('DAILY_ORDER_LIMIT');
    if(lastForMarket!==-Infinity && now-lastForMarket<cooldown)reasons.push('MARKET_COOLDOWN');
  }
  return Object.freeze({mode:'SHADOW_ONLY',intentId:spec.intentId,vaultAddress:spec.vaultAddress,
    estimatedOneWayNotionalUsd:formatUnits(notional,USD),
    estimatedMaxOneWayCostUsd:formatUnits(cost,USD),
    estimatedSpentLast24hUsd:formatUnits(dailySpent,USD),
    ordersLastHour:ordersHour,ordersLast24h:ordersDay,
    reductionExemptFromEconomicLimits:isReduction,allowed:reasons.length===0,
    reasons:Object.freeze(reasons),signingAllowed:false,sendAllowed:false,
    limitation:'Fee, fill, slippage and forecast profit are estimates; not an execution or profitability guarantee'});
}
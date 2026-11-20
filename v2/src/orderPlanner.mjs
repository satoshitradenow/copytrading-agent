/**
 * SHADOW-ONLY, deterministic Hyperliquid perpetual IOC order preflight.
 * There is NO signer, fetch, exchange client, nonce, network request or trade API.
 * A successful preview does not grant permission to submit an order.
 *
 * Verified rules: sizes respect meta.universe[].szDecimals; perp limit prices
 * use at most five significant figures and (6 - szDecimals) decimals. IOC
 * leaves nothing resting after an exchange acknowledgement, but an unknown
 * exchange response would STILL require independent exchange reconciliation.
 */
import { validateIntentSpec } from './intentLedger.mjs';
import { assessShadowVaultRisk } from './riskGate.mjs';
import { sizeUnits, moneyUnits, formatUnits } from './ledger.mjs';

const MONEY = 1_000_000n;
const SIZE = 100_000_000n;
const BPS = 10_000n;
const abs = n => n < 0n ? -n : n;
const integer = (n, name, min, max) => {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`${name} out of bounds`);
  return n;
};
const ceilDiv = (n, d) => (n + d - 1n) / d; // positive only
const decimalsOfInteger = n => n.toString().length;

/** Force a strict mainnet validator-perp listing. Never infer asset ids from a coin ticker. */
export function selectMainPerp(meta, coin) {
  if (!meta || !Array.isArray(meta.universe) || !meta.universe.length || meta.universe.length > 2000)
    throw Error('Hyperliquid perpetual metadata universe required');
  if (typeof coin !== 'string' || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(coin))
    throw Error('Supported main perpetual market required');
  const matches = [];
  for (let i=0; i<meta.universe.length; i++) {
    const a=meta.universe[i];
    if (!a || typeof a.name !== 'string' || !Number.isSafeInteger(a.szDecimals) ||
        a.szDecimals < 0 || a.szDecimals > 6 ||
        !Number.isSafeInteger(a.maxLeverage) || a.maxLeverage < 1 || a.maxLeverage > 100)
      throw Error('Invalid perpetual metadata; fail closed');
    if (a.name === coin) matches.push({asset:i, ...a});
  }
  if (matches.length !== 1) throw Error('Perpetual asset missing or duplicated in metadata');
  const a=matches[0];
  if (a.isDelisted === true) throw Error('Delisted perpetual market');
  if (a.onlyIsolated === true || a.marginMode === 'strictIsolated' || a.marginMode === 'noCross')
    throw Error('Unsupported isolated-only perpetual market');
  return Object.freeze({assetIndex:a.asset,coin,szDecimals:a.szDecimals,maxLeverage:a.maxLeverage});
}

/** Return a legal limit price that never exceeds the configured slippage band. */
export function boundedPerpPrice({markUsd,szDecimals,side,maxSlippageBps}) {
  const mid = moneyUnits(markUsd);
  if (mid <= 0n) throw Error('Positive market midprice required');
  integer(szDecimals,'szDecimals',0,6);
  const slip=BigInt(integer(maxSlippageBps,'maxSlippageBps',0,500));
  if (side !== 'buy' && side !== 'sell') throw Error('Invalid order side');
  // Smallest legal perp price step: at most 5 significant figures, and at
  // most (6 - szDecimals) decimal places. Price precision changes with size.
  const scalePow=Math.max(szDecimals,decimalsOfInteger(mid)-5);
  // Hyperliquid explicitly permits *any integer price* even when its integer
  // part has more than 5 significant figures. Use the tighter $1 step there.
  const decimalStep=10n ** BigInt(scalePow);
  const step=mid>=100_000n*MONEY && decimalStep>MONEY ? MONEY : decimalStep;
  const px=side==='buy'
    ? ((mid*(BPS+slip)/BPS)/step)*step // floor to keep buy below max permitted price
    : ceilDiv(ceilDiv(mid*(BPS-slip),BPS),step)*step; // ceil to stay above min sell
  if (px <= 0n) throw Error('No valid positive order limit price');
  if (side==='buy' && px < mid || side==='sell' && px > mid)
    throw Error('Slippage band too narrow for a marketable legal limit price');
  // Re-evaluate legal decimal places after rounding across a digit boundary.
  const legalStep = 10n ** BigInt(Math.max(szDecimals,decimalsOfInteger(px)-5));
  if (px % MONEY !== 0n && px % legalStep !== 0n)
    throw Error('Perp price crosses a precision boundary; require fresh quote');
  return formatUnits(px,MONEY);
}

/** Pure, unsigned order preview. No submission method exists in v2. */
export function prepareShadowIocOrder({intent,riskReceipt,vaultSnapshot,riskPolicy,meta,metaNetwork,markUsd,marketObservedAtMs,nowMs,
  observedLeverage,policy}) {
  const spec=validateIntentSpec(intent);
  if (!riskReceipt || riskReceipt.mode !== 'SHADOW_ONLY' || riskReceipt.allowed !== true ||
      riskReceipt.intentId !== spec.intentId || riskReceipt.vaultAddress !== spec.vaultAddress ||
      riskReceipt.coin !== spec.coin || typeof riskReceipt.requiresReduceOnly !== 'boolean')
    throw Error('Missing or mismatched exact-intent shadow risk approval');
  if (!policy || typeof policy !== 'object') throw Error('Explicit execution preflight policy required');
  const slip=integer(policy.maxSlippageBps,'maxSlippageBps',0,500);
  const maxAge=integer(policy.maxSnapshotAgeMs,'maxSnapshotAgeMs',1,10000);
  const expectedLeverage=integer(policy.expectedLeverage,'expectedLeverage',1,25);
  const network=policy.network;
  if (network!=='mainnet' && network!=='testnet')throw Error('Explicit supported network required');
  if(metaNetwork!==network || vaultSnapshot?.network!==network || observedLeverage?.network!==network)
    throw Error('Read-only market, vault and leverage observations must match the intended network');
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(marketObservedAtMs) ||
      nowMs<marketObservedAtMs || nowMs-marketObservedAtMs>maxAge)
    throw Error('Stale or future market/metadata snapshot');
  // Recompute risk from an actual vault account/position snapshot; a previously
  // approved receipt cannot authorize a later order with new market conditions.
  const freshRisk=assessShadowVaultRisk(spec,vaultSnapshot,riskPolicy,nowMs);
  if(!freshRisk.allowed)throw Error('Fresh vault risk check blocked order: '+freshRisk.failures.join(','));
  if(freshRisk.intentId!==riskReceipt.intentId ||
     freshRisk.requiresReduceOnly!==riskReceipt.requiresReduceOnly ||
     freshRisk.vaultEquityUsd!==riskReceipt.vaultEquityUsd ||
     freshRisk.orderNotionalUsd!==riskReceipt.orderNotionalUsd)
    throw Error('Risk approval no longer matches current vault risk snapshot');
  if(moneyUnits(vaultSnapshot.marks?.[spec.coin])!==moneyUnits(markUsd))
    throw Error('Quote and risk-check mark price mismatch');
  const market=selectMainPerp(meta,spec.coin);
  if (expectedLeverage>market.maxLeverage)throw Error('Desired leverage exceeds market maximum');
  if (!observedLeverage || observedLeverage.mode !== 'cross' ||
      observedLeverage.value !== expectedLeverage ||
      !Number.isSafeInteger(observedLeverage.asOfMs) ||
      observedLeverage.asOfMs>nowMs || nowMs-observedLeverage.asOfMs>maxAge)
    throw Error('Vault leverage or margin mode changed; explicit review required');
  const before=sizeUnits(spec.netBefore),after=sizeUnits(spec.netAfter),sz=sizeUnits(spec.size);
  const lot=10n**BigInt(8-market.szDecimals);
  if (sz<=0n || sz%lot!==0n)throw Error('Intent not exactly representable in exchange lot size; no silent rounding');

  // activeAssetData advertises current buy/sell maximum size for this vault.
  // These decimals may have more than eight fractional places. Floor capacity
  // toward zero to our local 1e-8 size units; NEVER round the trade up.
  const caps=observedLeverage.maxTradeSzs;
  if(!Array.isArray(caps)||caps.length!==2)throw Error('Missing exchange-side buy/sell capacity limits');
  const capacityUnits=value=>{
    if(typeof value!=='string'||value.length>60||! /^(?:0|[1-9]\d*)(?:\.\d{1,24})?$/.test(value))
      throw Error('Invalid exchange trade capacity');
    const [whole,fraction='']=value.split('.');
    return BigInt(whole)*SIZE+BigInt(fraction.slice(0,8).padEnd(8,'0')||'0');
  };
  const cap=capacityUnits(caps[spec.side==='buy'?0:1]);
  if(sz>cap)throw Error('Order exceeds live vault per-side trade capacity');
  // Hyperliquid has one net position per market: a flip is two separate
  // exchange actions. We NEVER disguise a flip as one reduce-only order.
  if (before!==0n && after!==0n && (before>0n)!==(after>0n))
    throw Error('Position flip requires explicit separately approved close and open intents');
  const reduceOnly=before!==0n && after!==0n && (before>0n)===(after>0n) && abs(after)<abs(before) || before!==0n && after===0n;
  if (reduceOnly!==riskReceipt.requiresReduceOnly)throw Error('Risk receipt disagrees with reduce-only classification');
  const px=boundedPerpPrice({markUsd,szDecimals:market.szDecimals,side:spec.side,maxSlippageBps:slip});
  const price=moneyUnits(px);
  const minNotional=moneyUnits(policy.minNotionalUsd);
  if (minNotional<=0n)throw Error('Positive minimum notional required');
  if (sz*price/SIZE<minNotional)throw Error('Exchange minimum notional unmet; no dust order');
  // Construct exact documented action fields, but explicitly mark UNSIGNED.
  const wireOrderPreview=Object.freeze({a:market.assetIndex,b:spec.side==='buy',p:px,s:spec.size,
    r:reduceOnly,t:{limit:{tif:'Ioc'}},c:spec.clientOrderId});
  return Object.freeze({mode:'SHADOW_ONLY',network,vaultAddress:spec.vaultAddress,
    intentId:spec.intentId,coin:spec.coin,limitPx:px,orderSize:spec.size,
    maxSlippageBps:slip,marketObservedAtMs,assetIndex:market.assetIndex,
    requiresReduceOnly:reduceOnly,observedCrossLeverage:expectedLeverage,
    wireOrderPreview,signingAllowed:false,sendAllowed:false,
    disclaimer:'UNSIGNED PREVIEW ONLY: no exchange submission, freshness or authorization guarantee'});
}
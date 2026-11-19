/** Public Hyperliquid /info queries only. No wallet, private key or /exchange action. */
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const API = { mainnet: 'https://api.hyperliquid.xyz/info', testnet: 'https://api.hyperliquid-testnet.xyz/info' };

export function validateAddress(a) {
  if (!WALLET_RE.test(a || '')) throw new Error('Expected a 42-character 0x wallet/vault address');
  return a.toLowerCase();
}

async function info(body, { fetchImpl = fetch, network = 'mainnet' } = {}) {
  const url = API[network];
  if (!url) throw new Error('Unsupported Hyperliquid network');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Hyperliquid read-only info request failed (${response.status})`);
  return response.json();
}

export async function readVaultPublicState(vaultAddress, options = {}) {
  const address = validateAddress(vaultAddress);
  const [details, state] = await Promise.all([
    info({ type: 'vaultDetails', vaultAddress: address }, options),
    info({ type: 'clearinghouseState', user: address }, options),
  ]);
  if (!details || !state || validateAddress(details.vaultAddress) !== address) {
    throw new Error('Vault response missing or address mismatch (fail closed)');
  }
  const leader = validateAddress(details.leader);
  const equity = state.marginSummary?.accountValue;
  if (typeof equity !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(equity)) {
    throw new Error('Missing or malformed vault account equity (fail closed)');
  }
  if (!Array.isArray(state.assetPositions)) throw new Error('Missing vault positions (fail closed)');
  return {
    mode: 'READ_ONLY',
    vaultAddress: address,
    leader,
    name: details.name || null,
    accountValueUsd: equity,
    positions: state.assetPositions,
    // Source-of-truth public read. Never infer signer or vault authority from this.
  };
}

/** Raw recent source fills. Caller must create a verified baseline and determine
 * source-equity at fill time; NEVER silently substitute current equity for history. */
export async function readRecentSourceFills(traderAddress, options = {}) {
  const trader = validateAddress(traderAddress);
  const rows = await info({ type: 'userFills', user: trader, aggregateByTime: false }, options);
  if (!Array.isArray(rows)) throw new Error('Malformed userFills response');
  return rows;
}

/** Fetch a bounded raw history interval, without assuming pagination is complete.
 * The caller MUST detect the 2,000-fill cap and recursively split ranges. */
export async function readSourceFillsByTime(traderAddress, startTime, endTime, options = {}) {
  const trader = validateAddress(traderAddress);
  if (!Number.isSafeInteger(startTime) || startTime < 0 || !Number.isSafeInteger(endTime) || endTime < startTime) {
    throw new Error('Invalid historical fill time range');
  }
  const rows = await info({type:'userFillsByTime',user:trader,startTime,endTime,aggregateByTime:false},options);
  if (!Array.isArray(rows)) throw new Error('Malformed userFillsByTime response');
  return rows;
}

/** Read-only inputs for the pure v2 risk gate. The state/price reads are not
 * atomic on the exchange; future execution must revalidate before submission. */
export async function readVaultRiskInputs(vaultAddress, options={}) {
  const address=validateAddress(vaultAddress);
  const observedAtStart=Date.now();
  const [state,mids]=await Promise.all([
    info({type:'clearinghouseState',user:address},options),
    info({type:'allMids'},options),
  ]);
  const observedAtEnd=Date.now();
  if(observedAtEnd-observedAtStart>10000)throw new Error('Vault risk snapshot fetched too slowly; fail closed');
  if(!state || !Array.isArray(state.assetPositions)||!state.marginSummary || !mids || typeof mids!=='object'||Array.isArray(mids)) {
    throw new Error('Malformed live vault state/price response');
  }
  const positions={};
  for(const row of state.assetPositions) {
    const p=row?.position;
    if(typeof p?.coin!=='string'||typeof p?.szi!=='string'||Object.hasOwn(positions,p.coin)) {
      throw new Error('Malformed or duplicate live vault position');
    }
    positions[p.coin]=p.szi;
  }
  if(typeof state.marginSummary.accountValue!=='string')throw new Error('Missing live vault equity');
  return {
    vaultAddress:address,
    accountValueUsd:state.marginSummary.accountValue,
    positions,
    marks:mids,
    asOfMs:observedAtEnd,
    mode:'READ_ONLY',
    disclaimer:'Non-atomic public account/price snapshot; independent execution verification required',
  };
}

/** Contemporaneous public source equity observation, NOT fill-time equity proof.
 * Never stamp historical fills with this value or claim exact leverage matching. */
export async function readSourceEquityObservation(traderAddress,options={}) {
  const trader=validateAddress(traderAddress);
  const observedAtStartMs=Date.now();
  const state=await info({type:'clearinghouseState',user:trader},options);
  const observedAtEndMs=Date.now();
  if(observedAtEndMs-observedAtStartMs>10000)throw Error('Source equity observation too slow');
  const equity=state?.marginSummary?.accountValue;
  if(typeof equity!=='string'||! /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(equity)||
     !Array.isArray(state.assetPositions))throw Error('Malformed source equity observation');
  return {mode:'READ_ONLY',trader,accountValueUsd:equity,
    observedAtStartMs,observedAtEndMs,positions:state.assetPositions,
    limitation:'Snapshot is not historical fill-time equity; cannot authorize an order on its own'};
}

/**
 * Read-only order status lookup against the VAULT account, not the API agent.
 * A response of `unknownOid` is NOT evidence that a previous send had no
 * effect; exchange propagation, retention and network errors may intervene.
 */
export async function readVaultOrderStatus(vaultAddress,clientOrderId,options={}) {
  const vault=validateAddress(vaultAddress);
  if(typeof clientOrderId!=='string'||!/^0x[0-9a-fA-F]{32}$/.test(clientOrderId))
    throw Error('16-byte Hyperliquid client order ID required');
  const result=await info({type:'orderStatus',user:vault,oid:clientOrderId.toLowerCase()},options);
  if(!result || typeof result!=='object' || Array.isArray(result) ||
     !['order','unknownOid'].includes(result.status))throw Error('Malformed Hyperliquid order status; fail closed');
  return result;
}
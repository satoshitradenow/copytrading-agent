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
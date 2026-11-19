/**
 * Vault copy engine v2: deterministic SHADOW-ONLY event accounting.
 * NO exchange writes, NO wallet access, NO live order submission.
 * This is a foundation for a reviewed persistent production worker, not a trading bot.
 */

const SCALE = 100_000_000n;
const MONEY_SCALE = 1_000_000n;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const COIN_RE = /^[A-Za-z0-9:_-]{1,32}$/;

function integerDecimal(value, scale, name, { positive = false } = {}) {
  const str = String(value);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(str)) {
    throw new Error(`${name} must be a plain decimal string`);
  }
  const neg = str.startsWith('-');
  const [whole, fraction = ''] = (neg ? str.slice(1) : str).split('.');
  const digits = String(scale).length - 1;
  if (fraction.length > digits) throw new Error(`${name} exceeds ${digits} decimal places`);
  const units = (BigInt(whole) * scale + BigInt(fraction.padEnd(digits, '0') || '0')) * (neg ? -1n : 1n);
  if (positive && units <= 0n) throw new Error(`${name} must be positive`);
  return units;
}

export const sizeUnits = (value) => integerDecimal(value, SCALE, 'size');
export const moneyUnits = (value) => integerDecimal(value, MONEY_SCALE, 'USD');

export function formatUnits(units, scale = SCALE) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const fractional = (abs % scale).toString().padStart(String(scale).length - 1, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / scale}${fractional ? '.' + fractional : ''}`;
}

function addr(value) {
  if (!WALLET_RE.test(value || '')) throw new Error('Invalid trader wallet address');
  return value.toLowerCase();
}
function abs(v) { return v < 0n ? -v : v; }
function positionKey(trader, coin) { return `${trader}|${coin}`; }

export class MemoryJournal {
  constructor(entries = []) { this.entries = [...entries]; }
  readAll() { return [...this.entries]; }
  append(record) { this.entries.push(structuredClone(record)); }
}

/**
 * Ledger records virtual per-strategy fills, and produces SHADOW intents for
 * the *net* vault position. It intentionally contains NO execution adapter.
 */
export class ShadowLedger {
  constructor({ traders, allowedCoins, journal = new MemoryJournal() }) {
    if (!Array.isArray(traders) || traders.length === 0 || traders.length > 5) {
      throw new Error('Configure 1–5 traders explicitly');
    }
    if (!Array.isArray(allowedCoins) || !allowedCoins.length) {
      throw new Error('Explicit allowlist of validator-operated perpetuals required');
    }
    this.allowedCoins = new Set(allowedCoins.map(x => x.toUpperCase()));
    this.traders = new Map();
    for (const t of traders) {
      const id = addr(t.address);
      if (this.traders.has(id)) throw new Error('Duplicate trader');
      const allocation = integerDecimal(t.allocationUsd, MONEY_SCALE, 'allocationUsd', { positive: true });
      const maxLeverage = Number(t.maxVirtualLeverage ?? 2);
      if (!Number.isInteger(maxLeverage) || maxLeverage < 1 || maxLeverage > 10) {
        throw new Error('maxVirtualLeverage must be an integer between 1 and 10');
      }
      this.traders.set(id, { allocation, maxLeverage, enabled: t.enabled === true });
    }
    this.journal = journal;
    this.seen = new Set();
    this.virtual = new Map();
    this.sourcePositions = new Map();
    this.net = new Map();
    this.lastIntents = [];
    for (const record of journal.readAll()) this.#restore(record);
  }

  #restore(rec) {
    if (rec.version !== 1 || typeof rec.fillKey !== 'string' || !this.traders.has(rec.trader)) {
      throw new Error('Journal contains invalid record (fail closed)');
    }
    if (!this.allowedCoins.has(rec.coin) || this.seen.has(rec.fillKey) || !/^-?\d+$/.test(rec.deltaUnits) || !/^-?\d+$/.test(rec.sourceDeltaUnits)) {
      throw new Error('Journal contains incompatible, duplicate or malformed record (fail closed)');
    }
    const delta = BigInt(rec.deltaUnits);
    const sourceDelta = BigInt(rec.sourceDeltaUnits);
    const k = positionKey(rec.trader, rec.coin);
    const prev = this.virtual.get(k) ?? 0n;
    const prevSource = this.sourcePositions.get(k) ?? 0n;
    const netPrev = this.net.get(rec.coin) ?? 0n;
    this.virtual.set(k, prev + delta);
    this.sourcePositions.set(k, prevSource + sourceDelta);
    this.net.set(rec.coin, netPrev + delta);
    this.seen.add(rec.fillKey);
  }

  applyFill(fill) {
    const trader = addr(fill.trader);
    const cfg = this.traders.get(trader);
    if (!cfg?.enabled) throw new Error('Unapproved or disabled source trader');
    if (!COIN_RE.test(fill.coin || '')) throw new Error('Invalid coin');
    const coin = fill.coin.toUpperCase();
    if (!this.allowedCoins.has(coin)) throw new Error('Market not approved for this vault');
    if (typeof fill.fillId !== 'string' || !/^[a-zA-Z0-9:_./-]{1,150}$/.test(fill.fillId)) {
      throw new Error('Missing or invalid unique exchange fill identifier');
    }
    const fillKey = `${trader}:${fill.fillId}`;
    if (this.seen.has(fillKey)) return { status: 'duplicate', fillKey, intent: null };
    if (fill.side !== 'buy' && fill.side !== 'sell') throw new Error('side must be buy or sell');
    // Source equity must be captured and independently reconciled at event time.
    // No guessed equity and no copying 1:1 source contract quantities.
    const sourceEquity = integerDecimal(fill.sourceEquityUsd, MONEY_SCALE, 'sourceEquityUsd', { positive: true });
    const price = integerDecimal(fill.priceUsd, MONEY_SCALE, 'priceUsd', { positive: true });
    const sourceSize = integerDecimal(fill.size, SCALE, 'source fill size', { positive: true });
    const signedSourceSize = fill.side === 'buy' ? sourceSize : -sourceSize;
    const k = positionKey(trader, coin);
    const prev = this.virtual.get(k) ?? 0n;
    const prevSource = this.sourcePositions.get(k) ?? 0n;
    // Hyperliquid supplies the original position BEFORE a fill. If present,
    // require it to agree with the journaled leader exposure. This prevents
    // an inherited source position from masquerading as a newly opened trade.
    // Do not silently seed from a nonzero exchange position at subscription.
    if (fill.sourceStartPosition !== undefined) {
      const claimedStart = integerDecimal(fill.sourceStartPosition, SCALE, 'sourceStartPosition');
      if (claimedStart !== prevSource) {
        throw new Error('Source pre-fill position mismatches journal baseline; do not copy inherited positions');
      }
    }
    // Adds/new entries scale by the source's contemporaneous equity.
    // Reductions are proportional to the follower's ALREADY-OPEN position;
    // otherwise an equity change between entry and exit leaves stranded size.
    let virtualDelta;
    if (prevSource === 0n || (prevSource > 0n) === (signedSourceSize > 0n)) {
      virtualDelta = signedSourceSize * cfg.allocation / sourceEquity;
    } else {
      const closeSize = abs(signedSourceSize) < abs(prevSource) ? abs(signedSourceSize) : abs(prevSource);
      const closeDelta = -(prev * closeSize / abs(prevSource));
      const openSize = abs(signedSourceSize) - closeSize;
      const openDelta = (signedSourceSize > 0n ? openSize : -openSize) * cfg.allocation / sourceEquity;
      virtualDelta = closeDelta + openDelta;
    }
    const next = prev + virtualDelta;
    const oldNotional = abs(prev) * price / SCALE;
    const newNotional = abs(next) * price / SCALE;
    const maxNotional = cfg.allocation * BigInt(cfg.maxLeverage);
    if (abs(next) > abs(prev) && newNotional > maxNotional) {
      throw new Error('Virtual per-trader notional cap exceeded; event rejected and requires review');
    }
    // A close is allowed even if mark-price changes have placed an existing
    // position above its opening cap. Global vault margin is a separate gate.
    const netBefore = this.net.get(coin) ?? 0n;
    const record = { version: 1, fillKey, trader, coin, sourceDeltaUnits: String(signedSourceSize), deltaUnits: String(virtualDelta) };
    // Journal first. If durable append fails, do not change account state.
    this.journal.append(record);
    this.#restore(record);
    const netAfter = this.net.get(coin);
    const intent = virtualDelta === 0n ? null : {
      mode: 'SHADOW_ONLY',
      fillKey,
      coin,
      side: virtualDelta > 0n ? 'buy' : 'sell',
      size: formatUnits(abs(virtualDelta)),
      netBefore: formatUnits(netBefore),
      netAfter: formatUnits(netAfter),
      // This is a proposed delta, not an order and not confirmation of any fill.
    };
    if (intent) this.lastIntents.push(intent);
    return { status: virtualDelta === 0n ? 'below_precision' : 'accepted', fillKey, intent, oldNotionalUsd: formatUnits(oldNotional, MONEY_SCALE) };
  }

  snapshot() {
    return {
      mode: 'SHADOW_ONLY',
      journaledFills: this.seen.size,
      net: Object.fromEntries([...this.net].map(([k,v]) => [k, formatUnits(v)]).sort()),
      virtual: Object.fromEntries([...this.virtual].map(([k,v]) => [k, formatUnits(v)]).sort()),
      sourcePositions: Object.fromEntries([...this.sourcePositions].map(([k,v]) => [k, formatUnits(v)]).sort()),
      // No mark-to-market or equity-driven rebalance method exists.
    };
  }
}
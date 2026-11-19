/** One-shot READ-ONLY fill capture, requiring an explicitly enabled source and start time. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CapturedSource} from './sourceCapture.mjs';
import {JsonlJournal} from './jsonlJournal.mjs';
import {readSourceFillsByTime, validateAddress} from './hyperliquidRead.mjs';

const [configFile, sourceAddress, startEpochMs, captureJournal] = process.argv.slice(2);
if (!configFile || !sourceAddress || !startEpochMs || !captureJournal) {
  console.error('Usage: npm run capture -- config/traders.json 0xAPPROVED_SOURCE START_EPOCH_MS ./local-state/source.jsonl');
  process.exit(2);
}
const config = JSON.parse(readFileSync(configFile,'utf8'));
if (config.mode !== 'SHADOW_ONLY') throw new Error('Only SHADOW_ONLY configuration supported');
const trader = validateAddress(sourceAddress);
if (!(config.traders||[]).some(t=>t.enabled===true && validateAddress(t.address)===trader)) {
  throw new Error('Source not explicitly enabled in config');
}
const fromTimeMs = Number(startEpochMs);
if (!Number.isSafeInteger(fromTimeMs) || fromTimeMs <= 0) throw new Error('Explicit START_EPOCH_MS must be a valid positive millisecond timestamp');
const endTimeMs = Date.now() - 10_000; // avoid edge-of-indexer lag; repeated poll overlaps by 2 minutes
if (endTimeMs < fromTimeMs) throw new Error('Baseline is in the future');
const source = new CapturedSource({source:{trader,fromTimeMs},journal:new JsonlJournal(resolve(captureJournal))});
const result=await source.captureUntil({
  throughTimeMs: endTimeMs,
  readPage:(address,startTime,endTime)=>readSourceFillsByTime(address,startTime,endTime,{network:'mainnet'}),
});
console.log(JSON.stringify(result,null,2));
console.log('Captured raw historical fills ONLY; no source-equity reconstruction, virtual accounting, or trading');
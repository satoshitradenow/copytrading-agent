/** Read-only deterministic replay of normalized fill data. No Hyperliquid client. */
import { readFileSync } from 'node:fs';
import { ShadowLedger } from './ledger.mjs';
import { JsonlJournal } from './jsonlJournal.mjs';

const [configPath, eventsPath, journalPath] = process.argv.slice(2);
if (!configPath || !eventsPath || !journalPath) {
  console.error('Usage: npm run shadow -- config/traders.json examples/fills.jsonl ./local-state/journal.jsonl');
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.mode !== 'SHADOW_ONLY') throw new Error('Live mode is unsupported');
const ledger = new ShadowLedger({
  traders: config.traders,
  allowedCoins: config.allowedCoins,
  journal: new JsonlJournal(journalPath),
});
const raw = readFileSync(eventsPath, 'utf8');
for (const line of raw.split('\n').filter(Boolean)) {
  try { console.log(JSON.stringify(ledger.applyFill(JSON.parse(line)))); }
  catch (err) { console.error(`REJECTED: ${err.message}`); process.exitCode = 1; }
}
console.log(JSON.stringify(ledger.snapshot(), null, 2));
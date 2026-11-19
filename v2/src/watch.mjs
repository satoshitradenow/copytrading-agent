/** Explicit opt-in, read-only monitoring of 1–5 approved public traders. */
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CapturedSource} from './sourceCapture.mjs';
import {JsonlJournal} from './jsonlJournal.mjs';
import {ReadOnlyFillMonitor} from './readOnlyMonitor.mjs';
import {readSourceFillsByTime,validateAddress} from './hyperliquidRead.mjs';
const [configPath,startStr,outputDir]=process.argv.slice(2);
if(!configPath||!startStr||!outputDir){
 console.error('Usage: npm run watch -- config/traders.json START_EPOCH_MS ./local-state');process.exit(2);
}
const config=JSON.parse(readFileSync(configPath,'utf8'));
if(config.mode!=='SHADOW_ONLY')throw Error('Only SHADOW_ONLY supported');
const startMs=Number(startStr),now=Date.now();
if(!Number.isSafeInteger(startMs)||startMs<=0||startMs>now-10000){
 throw Error('Specify a valid capture start at least 10 seconds before now');
}
const enabled=(config.traders||[]).filter(t=>t.enabled===true);
if(enabled.length<1||enabled.length>5)throw Error('Explicitly enable 1–5 public source traders');
const dir=resolve(outputDir);mkdirSync(dir,{recursive:true,mode:0o700});
const monitors=[];
const seenTraders=new Set();
function shutdown(){for(const m of monitors)m.stop();}
for(const sourceConfig of enabled){
 const trader=validateAddress(sourceConfig.address);
 if(seenTraders.has(trader))throw Error('Duplicate source address; only one journal writer per trader');
 seenTraders.add(trader);
 const path=join(dir,`${trader.slice(2)}.jsonl`);
 if(!existsSync(path)&&now-startMs>570000){
   throw Error('New source baseline must start within the last 9.5 minutes; do not silently backfill old history');
 }
 const capture=new CapturedSource({source:{trader,fromTimeMs:startMs},
   journal:new JsonlJournal(path)});
 const monitor=new ReadOnlyFillMonitor({trader,capture,
   readPage:(address,from,to)=>readSourceFillsByTime(address,from,to),
   onReport:r=>console.log(JSON.stringify({type:'capture',...r})),
   onError:e=>{console.error(`HALTED read-only monitor ${trader}: ${e.message}`);process.exitCode=1;shutdown();},
 });
 monitors.push(monitor);
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
try {await Promise.all(monitors.map(m=>m.start()));}
catch(e){shutdown();throw e;}
console.log('READ_ONLY monitoring active; no order signing or execution capabilities.');
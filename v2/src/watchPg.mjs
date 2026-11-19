/** READ-ONLY postgres monitor for the isolated v2 worker (NO /exchange). */
import { readFileSync } from 'node:fs';
import { PgCapturedSource } from './pgSourceCapture.mjs';
import { ReadOnlyFillMonitor } from './readOnlyMonitor.mjs';
import { readSourceFillsByTime, validateAddress } from './hyperliquidRead.mjs';

const [configPath, startStr] = process.argv.slice(2);
if (!configPath || !startStr) {
  console.error('Usage: npm run watch:pg -- ./config/traders.json START_EPOCH_MS (requires DATABASE_URL)');
  process.exitCode = 2;
} else {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  if (cfg.mode !== 'SHADOW_ONLY') throw Error('Refuse to run anything except SHADOW_ONLY');
  const startMs=Number(startStr),now=Date.now();
  if (!Number.isSafeInteger(startMs)||startMs<=0||startMs>now-10_000)throw Error('Invalid capture baseline');
  if (!process.env.DATABASE_URL)throw Error('DATABASE_URL must reference an isolated v2 PostgreSQL database');
  const enabled=(cfg.traders||[]).filter(x=>x.enabled===true);
  if (!enabled.length||enabled.length>5)throw Error('Explicitly enable between one and five verified source addresses');
  const traders=enabled.map(x=>validateAddress(x.address));
  if (new Set(traders).size!==traders.length)throw Error('Duplicate source configuration');
  // The pg package is dynamically loaded so offline shadow tests need no DB or credentials.
  const { Pool }=await import('pg');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5,ssl:{rejectUnauthorized:true},
    connectionTimeoutMillis:10_000,idleTimeoutMillis:30_000});
  let shuttingDown=false;
  const monitors=[];
  async function shutdown(){
    if(shuttingDown)return;shuttingDown=true;
    for(const m of monitors)m.stop();
    await pool.end();
  }
  process.once('SIGINT',()=>{void shutdown();});
  process.once('SIGTERM',()=>{void shutdown();});
  try {
    const network=cfg.network??'mainnet';
    if(!['mainnet','testnet'].includes(network))throw Error('Explicit supported Hyperliquid network required');
    // Don't start a network listener until every baseline has been verified.
    for(const trader of traders){
      const capture=new PgCapturedSource({pool,trader,fromTimeMs:startMs,network});
      await capture.initialize();
      if(capture.snapshot().throughTimeMs===null && now-startMs>570_000){
        throw Error('Old fresh baseline lacks a checkpoint; operator must verify exchange retention');
      }
      const monitor=new ReadOnlyFillMonitor({trader,capture,network,
        readPage:(address,from,to)=>readSourceFillsByTime(address,from,to,{network}),
        onReport:r=>console.log(JSON.stringify({type:'read_only_capture',...r})),
        onError:e=>{console.error(`Read-only monitor halted for ${trader}: ${e.message}`);
          process.exitCode=1;void shutdown();},
      });
      monitors.push(monitor);
    }
    await Promise.all(monitors.map(m=>m.start()));
    console.log('Read-only PostgreSQL capture is running. NO signer, no /exchange, no live trade execution.');
  } catch(e){await shutdown();throw e;}
}
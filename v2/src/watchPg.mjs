/** READ-ONLY PostgreSQL source monitor. No signer or /exchange calls. */
import {readFileSync} from 'node:fs';
import {PgCapturedSource} from './pgSourceCapture.mjs';
import {ReadOnlyFillMonitor} from './readOnlyMonitor.mjs';
import {readSourceFillsByTime} from './hyperliquidRead.mjs';
import {resolveShadowLaunchConfig,configFromEnvironment} from './shadowLaunchConfig.mjs';

const [configPath,startStr]=process.argv.slice(2);
if(configPath!=='--env'&&(!configPath||!startStr)){
 console.error('Usage: npm run watch:pg -- ./config/traders.json START_EPOCH_MS');
 console.error('   or: npm run watch:pg:env (VAULT_SHADOW_MODE, VAULT_NETWORK, VAULT_SOURCE_ADDRESSES, VAULT_BASELINE_MS, DATABASE_URL)');
 process.exitCode=2;
}else{
 const candidate=configPath==='--env'
  ?configFromEnvironment(process.env)
  :{...JSON.parse(readFileSync(configPath,'utf8')),fromTimeMs:Number(startStr)};
 const cfg=resolveShadowLaunchConfig({config:candidate,env:process.env,nowMs:Date.now()});
 // Require explicit source identities, baseline and a database separate from
 // every existing production project. No signing secret is accepted.
 const {Pool}=await import('pg');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,
  max:Math.min(cfg.addresses.length+1,6),ssl:{rejectUnauthorized:true},
  connectionTimeoutMillis:10_000,idleTimeoutMillis:30_000});
 let shuttingDown=false;const monitors=[];
 async function shutdown(){
  if(shuttingDown)return;shuttingDown=true;
  for(const monitor of monitors)monitor.stop();
  await pool.end();
 }
 process.once('SIGINT',()=>{void shutdown();});
 process.once('SIGTERM',()=>{void shutdown();});
 try{
  // No migrations here. Operator must explicitly provision the isolated
  // 001_shadow_ingestion.sql schema before any capture is allowed.
  const db=await pool.query(`SELECT current_database() AS name,
   to_regclass('v2_source_baselines')::text AS baselines,
   to_regclass('v2_source_cursors')::text AS cursors,
   to_regclass('v2_source_fills')::text AS fills`);
  if(db.rows.length!==1||db.rows[0].name!==cfg.dbName||
    !db.rows[0].baselines||!db.rows[0].cursors||!db.rows[0].fills)
   throw Error('Dedicated shadow PostgreSQL schema missing or unexpected database; no capture started');
  const now=Date.now();
  for(const trader of cfg.addresses){
   const capture=new PgCapturedSource({
    pool,trader,fromTimeMs:cfg.fromTimeMs,network:cfg.network
   });
   await capture.initialize();
   if(capture.snapshot().throughTimeMs===null &&
     now-cfg.fromTimeMs>570_000)
    throw Error('Old fresh baseline lacks a checkpoint; operator must verify exchange retention');
   const monitor=new ReadOnlyFillMonitor({
    trader,capture,network:cfg.network,
    readPage:(address,from,to)=>readSourceFillsByTime(address,from,to,{network:cfg.network}),
    onReport:r=>console.log(JSON.stringify({type:'read_only_capture',...r})),
    onError:e=>{
     console.error('Read-only monitor halted: '+e.message);
     process.exitCode=1;void shutdown();
    }
   });
   monitors.push(monitor);
  }
  await Promise.all(monitors.map(m=>m.start()));
  console.log(JSON.stringify({type:'read_only_shadow_active',network:cfg.network,
   sources:cfg.addresses.length,signerPresent:false,exchangeWrites:false}));
 }catch(e){await shutdown();throw e;}
}

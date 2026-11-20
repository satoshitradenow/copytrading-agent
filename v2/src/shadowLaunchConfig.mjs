/**
 * Fail-closed configuration for a separable, read-only Render worker.
 * No wallet keys or ExchangeClient are used by this configuration.
 */
import {validateAddress} from './hyperliquidRead.mjs';
const SECRET_NAMES=['FOLLOWER_PRIVATE_KEY','HL_SECRET_KEY','EXCHANGE_PRIVATE_KEY','API_PRIVATE_KEY'];
export function resolveShadowLaunchConfig({config,env={},nowMs=Date.now()}={}){
 if(config?.mode!=='SHADOW_ONLY')throw Error('Shadow-only launch mode is required');
 if(!Number.isSafeInteger(nowMs)||nowMs<=0)throw Error('Invalid launch clock');
 for(const key of SECRET_NAMES)if(env[key])throw Error('Refuse private signing keys in read-only worker environment');
 const network=config.network;
 if(!['mainnet','testnet'].includes(network))throw Error('Explicit Hyperliquid network required');
 const fromTimeMs=config.fromTimeMs;
 if(!Number.isSafeInteger(fromTimeMs)||fromTimeMs<=0||fromTimeMs>nowMs-10_000)
  throw Error('Recent integer shadow baseline timestamp required');
 const enabled=(config.traders??[]).filter(x=>x?.enabled===true);
 if(enabled.length<1||enabled.length>5)throw Error('Enable 1–5 verified source traders');
 const addresses=enabled.map(x=>validateAddress(x.address));
 if(new Set(addresses).size!==addresses.length)throw Error('Duplicate source trader address');
 if(!env.DATABASE_URL)throw Error('Isolated shadow-only PostgreSQL DATABASE_URL is required');
 const db=new URL(env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(db.protocol)||!db.pathname||db.pathname==='/'||
   db.pathname==='/%2F' || db.hostname==='')throw Error('Invalid PostgreSQL URL');
 if(decodeURIComponent(db.pathname)==='/postgres')
  throw Error('Default database is not an isolated shadow database');
 // Reject known other-product DB names and require an explicit, distinguishable DB.
 const dbName=decodeURIComponent(db.pathname.slice(1));
 if(!/^[A-Za-z0-9_\-]{1,64}$/.test(dbName)||
    !/(vault|copy|shadow)/i.test(dbName))
  throw Error('Dedicated vault/copy/shadow database name required');
 return Object.freeze({mode:'SHADOW_ONLY',network,
  fromTimeMs,addresses:Object.freeze(addresses),
  dbName,canTrade:false,hasSigner:false});
}
/** For Render: no config file or secret address list in Git required. */
export function configFromEnvironment(env=process.env){
 if(env.VAULT_SHADOW_MODE!=='SHADOW_ONLY')throw Error('VAULT_SHADOW_MODE=SHADOW_ONLY required');
 const list=(env.VAULT_SOURCE_ADDRESSES??'').split(',').map(x=>x.trim()).filter(Boolean);
 const fromTimeMs=Number(env.VAULT_BASELINE_MS);
 return {mode:'SHADOW_ONLY',network:env.VAULT_NETWORK,
  fromTimeMs,traders:list.map(address=>({address,enabled:true}))};
}

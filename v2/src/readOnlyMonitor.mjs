/**
 * Read-only Hyperliquid fill-stream notifier + REST backfill loop.
 * WebSocket events only wake REST capture. They NEVER apply leader orders and
 * never transmit a signing key. Historical capture is written before cursor.
 *
 * This is a development monitor, not the production persistent worker.
 */
import {validateAddress} from './hyperliquidRead.mjs';
const WS_URL='wss://api.hyperliquid.xyz/ws';

export class ReadOnlyFillMonitor {
  constructor({trader,capture,readPage,wsFactory=url=>new WebSocket(url),clock=()=>Date.now(),
    intervalMs=15_000,backfillDelayMs=10_000,reconnectMs=2_000,maxBackfillGapMs=600_000,onReport=()=>{},onError=()=>{}}){
    this.trader=validateAddress(trader);
    if(!capture || typeof capture.captureUntil!=='function')throw Error('Source capture required');
    if(typeof readPage!=='function'||typeof wsFactory!=='function')throw Error('Read-only adapters required');
    if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw Error('Invalid poll interval');
    if(!Number.isSafeInteger(backfillDelayMs)||backfillDelayMs<1000)throw Error('Invalid backfill delay');
    if(!Number.isSafeInteger(reconnectMs)||reconnectMs<1000)throw Error('Invalid reconnect delay');
    if(!Number.isSafeInteger(maxBackfillGapMs)||maxBackfillGapMs<60000)throw Error('Invalid capture gap limit');
    this.capture=capture;this.readPage=readPage;this.wsFactory=wsFactory;this.clock=clock;
    this.intervalMs=intervalMs;this.backfillDelayMs=backfillDelayMs;this.reconnectMs=reconnectMs;this.maxBackfillGapMs=maxBackfillGapMs;
    this.onReport=onReport;this.onError=onError;
    this.started=false;this.halted=false;this.inFlight=null;this.pending=false;
    this.ws=null;this.reconnectTimer=null;this.intervalTimer=null;this.lastError=null;
  }

  async start(){
    if(this.started||this.halted)throw Error('Monitor already started or halted; explicit recovery required');
    this.started=true;
    // A WS failure does not prevent polling; historical REST remains canonical.
    this.#openWebSocket();
    this.intervalTimer=setInterval(()=>{void this.pollNow().catch(e=>this.#halt(e));},this.intervalMs);
    await this.pollNow();
  }

  #openWebSocket(){
    if(!this.started||this.halted)return;
    let ws;
    try{ws=this.wsFactory(WS_URL);}catch(e){this.#scheduleReconnect();return;}
    this.ws=ws;
    ws.addEventListener('open',()=>{
      if(!this.started||this.halted)return;
      try{ws.send(JSON.stringify({method:'subscribe',subscription:{type:'userFills',user:this.trader}}));}
      catch(e){this.#halt(e);return;}
      void this.pollNow().catch(e=>this.#halt(e));
    });
    ws.addEventListener('message',(event)=>{
      if(!this.started||this.halted)return;
      try{
        const message=JSON.parse(String(event.data));
        if(message?.channel==='userFills'){
          const user=message.data?.user;
          if(user && validateAddress(user)!==this.trader)throw Error('Unexpected source trader in WS response');
          // Ignore the first WS snapshot as an executable event: it is only
          // a trigger for REST reconciliation with durable deduplication.
          void this.pollNow().catch(e=>this.#halt(e));
        }
      }catch(e){this.#halt(e);}
    });
    ws.addEventListener('close',()=>{if(this.ws===ws)this.ws=null;this.#scheduleReconnect();});
    ws.addEventListener('error',()=>{try{ws.close();}catch{this.#scheduleReconnect();}});
  }

  #scheduleReconnect(){
    if(!this.started||this.halted||this.reconnectTimer)return;
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null;this.#openWebSocket();
    },this.reconnectMs);
  }

  async pollNow(){
    if(!this.started||this.halted)throw Error('Monitor is not active');
    if(this.inFlight){this.pending=true;return this.inFlight;}
    this.inFlight=(async()=>{
      do {
        this.pending=false;
        const now=this.clock();
        if(!Number.isSafeInteger(now)||now<=this.backfillDelayMs)throw Error('Invalid monotonic capture clock');
        const until=now-this.backfillDelayMs;
        const status=this.capture.snapshot?.();
        const last=status?.throughTimeMs ?? status?.fromTimeMs;
        if(last!==null && last!==undefined && until-last>this.maxBackfillGapMs){
          throw Error('Capture gap too large for verified API retention; operator review required');
        }
        const result=await this.capture.captureUntil({
          throughTimeMs:until,
          readPage:this.readPage,
        });
        this.onReport(result);
      }while(this.pending && this.started && !this.halted);
    })();
    try {return await this.inFlight;}
    catch(e){this.#halt(e);throw e;}
    finally {this.inFlight=null;}
  }

  #halt(err){
    if(this.halted)return;
    this.halted=true;this.lastError=err;
    this.stop();
    try{this.onError(err);}catch{};
  }

  stop(){
    this.started=false;
    if(this.intervalTimer){clearInterval(this.intervalTimer);this.intervalTimer=null;}
    if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=null;}
    const old=this.ws;this.ws=null;
    try{old?.close();}catch{};
  }

  status(){return {mode:'READ_ONLY',trader:this.trader,started:this.started,halted:this.halted,lastError:this.lastError?.message??null};}
}
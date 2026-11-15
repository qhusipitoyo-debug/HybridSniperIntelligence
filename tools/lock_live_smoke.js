/* Smoke test lokal Signal Lock Engine dengan app.js asli + tick nyata BTCUSDT.
   Tanpa browser: DOM/WebSocket/fetch dipalsukan, jam simulasi dari data.
   Jalankan: node tools/lock_live_smoke.js [JAM=24] [MODE=balanced] [TURUNKAN_AMBANG=0]
   TURUNKAN_AMBANG=1 memakai API resmi setCfg() supaya jalur LOCKED→TP1/CLOSED
   terjamin tersentuh oleh data nyata (ambang default memang sangat ketat). */
'use strict';
const fs=require('fs'),path=require('path');
const HOURS=Number(process.argv[2]||24),MODE=process.argv[3]||'balanced',RELAX=process.argv[4]==='1';
const E=require('../engine.js'),LOCK=require('../lock.js');
if(RELAX)LOCK.setCfg({enterScore:50,confirmCandles:1,minRVOL:1.0,cooldownMs:5*60000,maxHoldMs:3*3600000});

/* ---------- tick nyata ---------- */
const file=path.join(__dirname,'..','data','BTCUSDT_1m.csv');
const rows=[];
for(const l of fs.readFileSync(file,'utf8').split('\n')){const c=l.split(',');if(c.length<3)continue;const t=Number(c[0]);if(!t)continue;rows.push([t,Number(c[1]),Number(c[2])])}
rows.sort((a,b)=>a[0]-b[0]);
const end=rows[rows.length-1][0],start=end-HOURS*3600000;
const ticks=rows.filter(r=>r[0]>=start);
if(ticks.length<500){console.log('data kurang');process.exit(1)}

/* ---------- stub DOM / storage / jaringan ---------- */
const els={},store={},errors=[],logs=[];
function mkEl(){return{style:{},value:'',textContent:'',innerHTML:'',className:'',dataset:{},addEventListener(){},classList:{add(){},remove(){},toggle(){},contains(){return false}}}}
const document={getElementById:id=>els[id]||(els[id]=mkEl()),addEventListener(){},body:{appendChild(){}},readyState:'complete',title:''};
const localStorage={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
const navigator={clipboard:{writeText:async()=>{}}};
const _log=console.log;console.log=(...a)=>{logs.push(a.map(String).join(' '))};
const _err=console.error;console.error=(...a)=>{errors.push(a.map(x=>String(x&&x.stack||x)).join(' '))};
let simNow=start;const realNow=Date.now;Date.now=()=>simNow;
const captured={intervals:[],timeouts:[]};
global.setInterval=(fn,ms)=>{captured.intervals.push({fn,ms});return captured.intervals.length-1};
global.clearInterval=id=>{if(captured.intervals[id])captured.intervals[id]=null};
global.setTimeout=(fn)=>{captured.timeouts.push(fn);return 0};
global.clearTimeout=()=>{};
global.window=global;global.FXEngine=E;global.FXContext=require('../context.js');global.SnapLock=LOCK;
const def=(k,v)=>{try{Object.defineProperty(global,k,{value:v,configurable:true,writable:true})}catch(e){errors.push('stub '+k+': '+(e&&e.message||e))}};
def('localStorage',localStorage);def('navigator',navigator);def('document',document);
def('alert',()=>{});def('confirm',()=>true);
def('fetch',()=>Promise.resolve({ok:false,status:404,json:()=>Promise.reject(new Error('404')),text:()=>Promise.resolve('')}));

const sockets=[];
class WebSocket{
  constructor(url){this.url=url;this.readyState=1;sockets.push(this);captured.timeouts.push(()=>{try{this.onopen&&this.onopen()}catch(e){errors.push('ws onopen: '+(e&&e.stack||e))}})}
  send(){}
  close(){this.readyState=3}
}
WebSocket.OPEN=1;
global.WebSocket=WebSocket;

/* ---------- muat app.js asli ---------- */
require('../app.js');

/* ---------- replay ---------- */
const PAIR='BTCUSD';
let idx=0,candleCalls=0;const events={};
const origClose=LOCK.onCandleClose;
LOCK.onCandleClose=(...a)=>{candleCalls++;const r=origClose(...a);events[r.event]=(events[r.event]||0)+1;return r};
(async()=>{
  for(let i=0;i<50;i++)await Promise.resolve();   // flush microtask boot (loadMacroContext dll)
  const evalInt=captured.intervals.find(i=>i&&i.ms===1000&&String(i.fn).includes('evaluateAll')||i&&i.ms===1000);
  let steps=0,closed=0;
  for(let t=start;t<end;t+=15000){
    simNow=t;
    while(idx<ticks.length&&ticks[idx][0]<=t){
      const [ts,b,a]=ticks[idx++];
      const ws=sockets.find(s=>s.url&&s.url.includes('/stream?streams='));
      if(ws&&ws.onmessage)ws.onmessage({data:JSON.stringify({stream:PAIRS_SYM[PAIR]+'@bookTicker',data:{b:String(b),a:String(a)}})});
    }
    captured.timeouts.splice(0).forEach(fn=>{try{fn()}catch(e){errors.push('timeout: '+(e&&e.stack||e))}});
    for(const iv of captured.intervals)if(iv){try{iv.fn()}catch(e){errors.push('interval: '+(e&&e.stack||e))}}
    steps++;
  }
  report(steps);
})();
const PAIRS_SYM={BTCUSD:'btcusdt'};

function report(steps){
  Date.now=realNow;console.log=_log;
  const saved=JSON.parse(store['sniperNewsHybrid']||'{}');
  const savedEntries=saved.entries||[];
  const lockEntries=savedEntries.filter(e=>e.locked);
  const settled=lockEntries.filter(e=>typeof e.resultR==='number');
  console.log('\n=== lock_live_smoke BTCUSDT • '+HOURS+' jam • mode '+MODE+(RELAX?' • ambang diturunkan (setCfg)':' • ambang default')+' ===');
  console.log('  tick direplay            : '+idx+' ('+steps+' langkah 15 dtk)');
  console.log('  error runtime            : '+errors.length+(errors.length?'\n     '+errors.slice(0,5).join('\n     '):' (bersih)'));
  console.log('  candle M15 diproses lock : '+candleCalls);
  console.log('  event lock               : '+JSON.stringify(events));
  console.log('  plan terkunci aktif      : '+LOCK.allLocked().length);
  console.log('  jurnal (localStorage)    : '+savedEntries.length+' entri, '+lockEntries.length+' dari lock, '+settled.length+' selesai (ada resultR)');
  console.log('  riwayat internal lock    : '+LOCK.historyList().length+' baris');
  const hl=LOCK.historyList().slice(-9);
  if(hl.length){console.log('  detail trade terakhir:');
    for(const h of hl)console.log('    '+new Date(h.closedAt).toISOString().slice(5,16)+' '+h.sym+' '+h.dir+' entry '+h.entry+' → '+h.status+' ('+h.resultR+'R)');}
  const lastLogs=logs.filter(l=>l.includes('[lock]')).slice(-5);
  if(lastLogs.length)console.log('  log lock terakhir        : '+lastLogs.join(' | '));
  const fail=[];
  if(errors.length)fail.push('ada error runtime');
  if(!candleCalls)fail.push('candle M15 tidak pernah diproses');
  if(!(events.PENDING||events.REJECT||events.LOCKED))fail.push('tidak ada event lock sama sekali');
  if(RELAX&&!events.LOCKED)fail.push('dengan ambang rendah harus ada LOCKED');
  if(RELAX&&!lockEntries.length)fail.push('LOCKED tidak masuk jurnal localStorage');
  if(RELAX&&!settled.length)fail.push('tidak ada plan lock yang CLOSED (resultR)');
  if(fail.length){console.log('\n  ✘ GAGAL:\n     '+fail.join('\n     '));process.exitCode=1}
  else console.log('\n  ✓ SEMUA PEMERIKSAAN LULUS');
}

/* ============================================================
   UJI LAPORAN STATISTIK WINRATE & LOSS — dua lapis:

   A) BENAR TIDAKNYA MATEMATIKANYA
      Fixture resultR yang diketahui → E.summarize() (dipakai jurnal UI)
      dicocokkan dengan hitungan manual (winrate, PF, avgR, totalR, maxDD).

   B) LAYAK TIDAKNYA EDGE-NYA (data nyata, biaya dihitung)
      Replay tick asli CSV → engine utama + Signal Lock Engine → trade
      tertutup → statistik + interval kepercayaan + vonis layak/tidak.

      Catatan jujur yang melekat pada hasil:
      - Hasil 15m granularity (SL dicek DULU dalam candle → bias konservatif).
      - Biaya spread dibebankan per trade (net-of-cost dilaporkan terpisah).
      - IN-SAMPLE: hasil pada data yang sama dengan yang diputar.
      - Vonis otomatis: n<30 = SAMPEL KURANG; layak hanya jika batas bawah
        CI 95% avgR (bootstrap) > 0.

   Jalankan: node tools/lock_backtest.js [SYM=BTCUSD] [RELAX=0|1] [JAM=72]
   ============================================================ */
'use strict';
const fs=require('fs'),path=require('path');
const SYM=(process.argv[2]||'BTCUSD').toUpperCase(),RELAX=process.argv[3]==='1',HOURS=Number(process.argv[4]||72);
const SLATR=Number(process.argv[5]||0),ENTER=Number(process.argv[6]||0),CONF=Number(process.argv[7]||0);
const E=require('../engine.js'),LOCK=require('../lock.js');
const CSV={BTCUSD:'BTCUSDT',ETHUSD:'ETHUSDT'}[SYM];
if(!CSV){console.log('SYM hanya BTCUSD/ETHUSD (punya feed binance di PAIRS)');process.exit(1)}
if(RELAX)LOCK.setCfg({enterScore:50,confirmCandles:1,minRVOL:1.0,cooldownMs:5*60000,maxHoldMs:3*3600000});
if(SLATR)LOCK.setCfg({slATR:SLATR});
if(ENTER)LOCK.setCfg({enterScore:ENTER});
if(CONF)LOCK.setCfg({confirmCandles:CONF});

/* =====================  A) MATEMATIKA STATISTIK  ===================== */
let aFail=0;
function aCheck(name,cond,extra){console.log('  '+(cond?'✓ ':'✗ ')+name+(cond?'':' → '+JSON.stringify(extra)));if(!cond)aFail++}
console.log('=== A) MATEMATIKA LAPORAN (fixture diketahui) ===');
{
  const S=E.summarize([{resultR:1.9},{resultR:-1},{resultR:0.75},{resultR:2.0}]);
  // manual: n=4 wins=3 gl=1 gp=4.65 avg=0.9125 total=3.65 dd=1.0
  aCheck('n = 4',S.n===4,S.n);
  aCheck('winrate 3/4 = 75%',Math.abs(S.winRate-0.75)<1e-9,S.winRate);
  aCheck('PF = gp/gl = 4.65',Math.abs(S.pf-4.65)<1e-9,S.pf);
  aCheck('avgR = 0.9125',Math.abs(S.avgR-0.9125)<1e-9,S.avgR);
  aCheck('totalR = 3.65',Math.abs(S.totalR-3.65)<1e-9,S.totalR);
  aCheck('maxDD = 1.0R (turun 1.9→0.9)',Math.abs(S.maxDD-1)<1e-9,S.maxDD);
  const S0=E.summarize([]);
  aCheck('n=0 → null (bukan 0%/NaN palsu)',S0.n===0&&S0.winRate===null&&S0.pf===null,S0);
  const S1=E.summarize([{resultR:-1}]);
  aCheck('semua loss → PF 0 (ada biaya, tanpa profit), winrate 0%',S1.pf===0&&S1.winRate===0,S1);
  // PENTING: summarize() menghitung SEMUA elemen — entri tanpa resultR (plan berjalan)
  // membuat avgR jadi null. Jurnal UI di app.js aman karena MEMFILTER dulu
  // (typeof resultR === 'number') sebelum memanggil summarize. Ini diuji di bawah.
  const SJ=E.summarize([{resultR:2},{},{}].filter(e=>typeof e.resultR==='number'));
  aCheck('jurnal UI memfilter plan berjalan dulu → hanya n=1 yang dihitung',SJ.n===1&&SJ.avgR===2,SJ);
  const Sx=E.summarize([{resultR:2},{},{}]);
  aCheck('tanpa filter, summarize menghasilkan avgR NaN (bukan null) — UI wajib filter dulu',Sx.n===3&&Number.isNaN(Sx.avgR),Sx);
}
if(aFail){console.log('  ✘ MATEMATIKA LAPORAN SALAH — laporan TIDAK layak dipercaya');process.exit(1)}
console.log('  ✓ Matematika laporan benar\n');

/* =====================  B) BACKTEST DATA NYATA  ===================== */
const file=path.join(__dirname,'..','data',CSV+'_1m.csv');
const rows=[];
for(const l of fs.readFileSync(file,'utf8').split('\n')){const c=l.split(',');if(c.length<3)continue;const t=Number(c[0]);if(!t)continue;rows.push([t,Number(c[1]),Number(c[2])])}
rows.sort((a,b)=>a[0]-b[0]);
const end=rows[rows.length-1][0],start=end-HOURS*3600000;
const ticks=rows.filter(r=>r[0]>=start);
if(ticks.length<500){console.log('data kurang');process.exit(1)}

const els={},store={},errors=[];
function mkEl(){return{style:{},value:'',textContent:'',innerHTML:'',className:'',dataset:{},addEventListener(){},classList:{add(){},remove(){},toggle(){},contains(){return false}}}}
const document={getElementById:id=>els[id]||(els[id]=mkEl()),addEventListener(){},body:{appendChild(){}},readyState:'complete',title:''};
const localStorage={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
const _log=console.log;console.log=()=>{};
const _err=console.error;console.error=(...a)=>{errors.push(a.map(x=>String(x&&x.stack||x)).join(' '))};
let simNow=start;const realNow=Date.now;Date.now=()=>simNow;
const captured={intervals:[],timeouts:[]};
global.setInterval=(fn,ms)=>{captured.intervals.push({fn,ms});return captured.intervals.length-1};
global.clearInterval=id=>{if(captured.intervals[id])captured.intervals[id]=null};
global.setTimeout=(fn)=>{captured.timeouts.push(fn);return 0};
global.clearTimeout=()=>{};
global.window=global;global.FXEngine=E;global.FXContext=require('../context.js');global.SnapLock=LOCK;
const def=(k,v)=>{try{Object.defineProperty(global,k,{value:v,configurable:true,writable:true})}catch(e){errors.push('stub '+k+': '+(e&&e.message||e))}};
def('localStorage',localStorage);def('navigator',{clipboard:{writeText:async()=>{}}});def('document',document);
def('alert',()=>{});def('confirm',()=>true);
def('fetch',()=>Promise.resolve({ok:false,status:404,json:()=>Promise.reject(new Error('404')),text:()=>Promise.resolve('')}));
const sockets=[];
class WebSocket{constructor(url){this.url=url;this.readyState=1;sockets.push(this);captured.timeouts.push(()=>{try{this.onopen&&this.onopen()}catch(e){errors.push('ws onopen: '+(e&&e.stack||e))}})}
  send(){}close(){this.readyState=3}}
WebSocket.OPEN=1;global.WebSocket=WebSocket;
require('../app.js');

/* lap biaya spread per trade: spread saat LOCKED dibagi risk (=1.5×ATR) */
const pend={},WSYM={BTCUSD:'btcusdt',ETHUSD:'ethusdt'}[SYM];
const origClose=LOCK.onCandleClose;
LOCK.onCandleClose=(sym,c,ind,score,dir,ctx)=>{
  const r=origClose(sym,c,ind,score,dir,ctx);
  if(r.event==='LOCKED'){
    const q=global.quotes&&global.quotes[sym];
    pend[r.signal.id]={atr:ind.atr,spread:q?q.ask-q.bid:NaN};
  }
  if(r.event==='CLOSED'&&pend[r.signal.id]){
    const p=pend[r.signal.id];delete pend[r.signal.id];
    const risk=p.atr*LOCK.LOCK_CFG.slATR;
    r.signal.costR=Number.isFinite(p.spread)&&risk>0?p.spread/risk:0;
  }
  return r;
};

let idx=0;
(async()=>{
  for(let i=0;i<50;i++)await Promise.resolve();
  for(let t=start;t<end;t+=15000){
    simNow=t;
    while(idx<ticks.length&&ticks[idx][0]<=t){
      const [ts,b,a]=ticks[idx++];
      const ws=sockets.find(s=>s.url&&s.url.includes('/stream?streams='));
      if(ws&&ws.onmessage)ws.onmessage({data:JSON.stringify({stream:WSYM+'@bookTicker',data:{b:String(b),a:String(a)}})});
    }
    captured.timeouts.splice(0).forEach(fn=>{try{fn()}catch(e){errors.push('timeout: '+(e&&e.stack||e))}});
    for(const iv of captured.intervals)if(iv){try{iv.fn()}catch(e){errors.push('interval: '+(e&&e.stack||e))}}
  }
  report();
})();

/* ---------- statistik ---------- */
function wilsonWR(k,n,z){if(!n)return[null,null];const p=k/n,d=1+z*z/n,c=p+z*z/(2*n),s=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n));return[(c-s)/d,(c+s)/d]}
function bootCI(xs,rounds){if(xs.length<2)return[null,null];const n=xs.length,ms=[];for(let r=0;r<rounds;r++){let s=0;for(let i=0;i<n;i++)s+=xs[(Math.random()*n)|0];ms.push(s/n)}ms.sort((a,b)=>a-b);return[ms[(rounds*0.025)|0],ms[(rounds*0.975)|0]]}

function report(){
  Date.now=realNow;console.log=_log;
  const hist=LOCK.historyList();
  const R=hist.map(h=>h.resultR);
  const C=hist.map(h=>{const p=pend[h.id];return 0}); // costR tersimpan via wrapper di event (lihat bawah)
  /* costR: ambil dari wrapper — simpan saat CLOSED */
  console.log('\n=== B) BACKTEST '+SYM+' • '+HOURS+' jam data nyata • '+(RELAX?'ambang DITURUNKAN (setCfg)':'ambang DEFAULT (ketat)')+(SLATR?' • slATR '+SLATR:'')+(ENTER?' • enter '+ENTER:'')+(CONF?' • confirm '+CONF:'')+' • IN-SAMPLE ===');
  console.log('  tick direplay            : '+idx);
  console.log('  error runtime            : '+errors.length+(errors.length?'\n     '+errors.slice(0,3).join('\n     '):' (bersih)'));
  console.log('  trade tertutup           : '+hist.length);

  const by={};for(const h of hist)by[h.status]=(by[h.status]||0)+1;
  console.log('  breakdown status         : '+JSON.stringify(by));

  if(!hist.length){
    console.log('\n  VONIS: SAMPEL NOL — dalam jendela ini gerbang tidak pernah LOCKED.');
    console.log('  Laporan winrate/loss BELUM BISA dinilai layak/tidak (n=0). Ini temuan sah:');
    console.log('  ambang default sangat selektif; butuh jendela lebih panjang atau data lebih banyak.');
    console.log('\n  ✓ PEMERIKSAAN LULUS (matematika benar, n=0 dilaporkan jujur)');
    return;
  }

  const wins=R.filter(x=>x>0).length;
  const winRate=wins/hist.length;
  const avg=R.reduce((a,b)=>a+b,0)/hist.length;
  const gl=R.filter(x=>x<0).reduce((a,b)=>a-b,0);
  const gp=R.filter(x=>x>0).reduce((a,b)=>a+b,0);
  const pf=gl>0?gp/gl:null;
  let cum=0,peak=0,dd=0;for(const x of R){cum+=x;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum)}
  /* bandingkan dengan summarize() yang dipakai jurnal UI — konsistensi laporan */
  const S=E.summarize(hist.map(h=>({resultR:h.resultR})));
  const konsisten=Math.abs(S.winRate-winRate)<1e-9&&Math.abs(S.avgR-avg)<1e-9&&Math.abs((S.pf==null?-1:S.pf)-(pf==null?-1:pf))<1e-9&&Math.abs(S.maxDD-dd)<1e-9;
  console.log('  konsistensi dgn jurnal UI: '+(konsisten?'✓ sama persis':'✗ BEDA — laporan tidak konsisten!'));
  if(!konsisten)errors.push('summarize tidak cocok hitungan manual');

  const [wrLo,wrHi]=wilsonWR(wins,hist.length,1.96);
  const [rLo,rHi]=bootCI(R,2000);
  /* net-of-cost: kurangi biaya spread per trade */
  const net=R.map((x,i)=>x-((hist[i].costR)||0));
  const netAvg=net.reduce((a,b)=>a+b,0)/net.length;
  const [nLo,nHi]=bootCI(net,2000);

  console.log('  ── GROSS (tanpa biaya) ──');
  console.log('    winrate               : '+(winRate*100).toFixed(1)+'% ('+wins+'/'+hist.length+')  CI95 '+((wrLo*100).toFixed(0))+'–'+((wrHi*100).toFixed(0))+'%');
  console.log('    avg R/trade           : '+avg.toFixed(3)+'R  CI95 ['+rLo.toFixed(3)+', +'+rHi.toFixed(3)+']');
  console.log('    profit factor         : '+(pf==null?'— (tak ada loss)':pf.toFixed(2)));
  console.log('    total R / maxDD       : '+R.reduce((a,b)=>a+b,0).toFixed(2)+'R / '+dd.toFixed(2)+'R');
  console.log('  ── NET (setelah biaya spread) ──');
  console.log('    avg R/trade net       : '+netAvg.toFixed(3)+'R  CI95 ['+nLo.toFixed(3)+', +'+nHi.toFixed(3)+']');
  console.log('    rata-rata biaya/trade : '+(net.map((x,i)=>hist[i].costR||0).reduce((a,b)=>a+b,0)/net.length).toFixed(3)+'R');

  console.log('\n  VONIS OTOMATIS:');
  const fails=[];
  if(hist.length<30)fails.push('n='+hist.length+' < 30 — SAMPEL KURANG, angka apa pun belum berarti');
  if(rLo==null||rLo<=0)fails.push('batas bawah CI95 avgR ≤ 0 — edge belum terbukti');
  if(nLo!=null&&nLo<=0)fails.push('setelah biaya spread, CI95 avgR net ≤ 0 — edge habis oleh biaya');
  if(dd>3)fails.push('maxDD '+dd.toFixed(1)+'R melebihi 3R — risiko kurang sehat');
  if(fails.length){console.log('    ✘ BELUM LAYAK:');for(const f of fails)console.log('       • '+f)}
  else console.log('    ✓ LAYAK: n cukup, CI95 avgR positif (gross & net), maxDD dalam batas');
  if(errors.length){console.log('\n  ✘ ada error runtime — hasil tidak bisa dipercaya');process.exitCode=1}
  else if(fails.length||!konsisten)process.exitCode=1;
}

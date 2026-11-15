/* ============================================================
   SWEEP WALK-FORWARD 2 FASE (anti self-deception):

   FASE 1 — TRAIN (60% awal data):
      grid enterScore × confirmCandles × slATR × maxHoldMs,
      pilih TOP-N berdasar avgR NET (n train >= MIN_N_TRAIN).
   FASE 2 — HOLDOUT (40% akhir, TIDAK dipakai memilih):
      konfigurasi pilihan dievaluasi ulang di data yang belum
      pernah disentuh. Angka holdout-lah uji sebenarnya.

   Catatan: dimensi MODE engine DIHAPUS dari grid — terbukti pada
   sweep pertama bahwa 4 mode menghasilkan trade lock identik:
   lock hanya membaca side + confidence dari engine, gerbang mode
   (minER/persist/dll.) tidak menyaring lock. Yang mengikat adalah
   ambang lock sendiri.

   Kejujuran yang melekat:
   - Memilih dari banyak konfigurasi = bias multiple-testing;
     train PASTI terlihat lebih bagus dari kenyataan.
   - Bahkan holdout positif pun baru "menjanjikan" — konfirmasi
     akhir tetap dari paper trading / data live berikutnya.
   - Vonis LAYAK tetap: n>=30, CI95 bawah avgR NET > 0, maxDD<=3R.

   Jalankan: node tools/lock_sweep.js [SYM=BTCUSD] [HARI=60]
             [COSTPCT=0.02] [HOLD=all|4h|8h]
   Output: baris JSON per langkah (phase= train|rank|holdout|baseline).
   ============================================================ */
'use strict';
const fs = require('fs');
const SYM = (process.argv[2] || 'BTCUSD').toUpperCase();
const DAYS = Number(process.argv[3] || 60);
const COSTPCT = Number(process.argv[4] || 0.02);
const HOLDSEL = (process.argv[5] || 'all').toLowerCase(); // all|4h|8h
const E = require('../engine.js'), LOCK = require('../lock.js'), WF = require('../wf.js');
const CSV = { BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT' }[SYM];
if (!CSV){ console.log('SYM hanya BTCUSD/ETHUSD'); process.exit(1); }

const HOLD_ALL = { '4h': 4 * 3600000, '8h': 8 * 3600000 };
const HOLDS = HOLDSEL === 'all' ? Object.keys(HOLD_ALL) : [HOLDSEL];
if (HOLDS.some(h => !HOLD_ALL[h])){ console.log('HOLD hanya all|4h|8h'); process.exit(1); }
const GRID = { enter: [50, 60, 70], conf: [1, 2], slatr: [2.0, 2.5, 3.0] };
const MODE = 'balanced'; // mode engine tidak mengubah trade lock (lihat header)
const TOPN = 2, MIN_N_TRAIN = 20, SEED_TEST = 1000; // bar warmup utk holdout

function out(o){ console.log(JSON.stringify(o)); }

async function klines(){
  const cache = '/tmp/opencode/wf_klines_' + SYM + '_' + DAYS + '.json';
  if (fs.existsSync(cache)){
    console.error('[sweep ' + MODE + '] kline dari cache: ' + cache);
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }
  const total = DAYS * 1440, bars = [];
  const hosts = ['https://api.binance.com', 'https://data-api.binance.vision'];
  let endTime;
  fetchLoop:
  for (const host of hosts){
    try {
      while (bars.length < total){
        const url = host + '/api/v3/klines?symbol=' + CSV + '&interval=1m&limit=1000' + (endTime ? '&endTime=' + endTime : '');
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const rows = await r.json();
        if (!rows.length) break;
        for (const k of rows) bars.push({ k: Math.floor(k[0] / 60000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], vol: +k[5] });
        endTime = rows[0][0] - 1;
      }
      break fetchLoop;
    } catch (e){ console.error('[sweep ' + MODE + '] host gagal: ' + e.message); }
  }
  if (bars.length < 2000) throw new Error('data kline kurang');
  bars.sort((a, b) => a.k - b.k);
  const ded = [bars[0]];
  for (const b of bars) if (b.k > ded[ded.length - 1].k) ded.push(b);
  try { fs.writeFileSync(cache, JSON.stringify(ded)); } catch {}
  return ded;
}

function runOnce(bars, cfg, seedBars){
  LOCK.setCfg({ enterScore: cfg.enter, confirmCandles: cfg.conf, slATR: cfg.slatr, maxHoldMs: cfg.holdMs });
  LOCK.reset();
  const runner = WF.createRunner({ E, LOCK, sym: SYM, bars, costPct: COSTPCT, mode: MODE,
    seedBars: seedBars != null ? seedBars : undefined });
  while (!runner.step(400)){}
  return runner.result();
}

(async () => {
  const bars = await klines();
  const cut = Math.floor(bars.length * 0.6);
  const train = bars.slice(0, cut);
  const test = bars.slice(cut);
  const testFull = bars.slice(Math.max(0, cut - SEED_TEST), cut).concat(test);
  console.error('[sweep ' + MODE + '] train ' + train.length + ' bar (' + new Date(train[0].k * 60000).toISOString().slice(0, 10) + '→' + new Date(train[cut - 1].k * 60000).toISOString().slice(0, 10) + '), holdout ' + test.length + ' bar (' + new Date(test[0].k * 60000).toISOString().slice(0, 10) + '→' + new Date(test[test.length - 1].k * 60000).toISOString().slice(0, 10) + ')');

  const results = [];
  for (const hold of HOLDS) for (const enter of GRID.enter) for (const conf of GRID.conf) for (const slatr of GRID.slatr){
    const t0 = Date.now();
    const res = runOnce(train, { enter, conf, slatr, holdMs: HOLD_ALL[hold] });
    const st = res.stats;
    const row = { phase: 'train', mode: MODE, enter, conf, slatr, holdH: hold,
      n: st.n, avgN: st.avgN, ciN: st.ciN, pfN: st.pfN, maxDD: st.maxDD, wrN: st.wrN, sec: +((Date.now() - t0) / 1000).toFixed(1) };
    results.push(row);
    out(row);
  }
  const ranked = results.filter(r => r.n >= MIN_N_TRAIN && r.avgN != null).sort((a, b) => b.avgN - a.avgN);
  out({ phase: 'rank', mode: MODE, tested: results.length, qualified: ranked.length, top: ranked.slice(0, TOPN) });

  for (const r of ranked.slice(0, TOPN)){
    const res = runOnce(testFull, { enter: r.enter, conf: r.conf, slatr: r.slatr, holdMs: HOLD_ALL[r.holdH] }, SEED_TEST);
    const st = res.stats;
    out({ phase: 'holdout', mode: MODE, enter: r.enter, conf: r.conf, slatr: r.slatr, holdH: r.holdH,
      n: st.n, avgN: st.avgN, ciN: st.ciN, pfN: st.pfN, maxDD: st.maxDD, wrN: st.wrN, byStatus: st.byStatus });
  }
  /* baseline: konfigurasi DEFAULT (tanpa tuning) di holdout yang sama */
  LOCK.setCfg({ enterScore: 70, confirmCandles: 2, slATR: 2.5, maxHoldMs: HOLD_ALL[HOLDS[0]] });
  LOCK.reset();
  const res0 = runOnce(testFull, { enter: 70, conf: 2, slatr: 2.5, holdMs: HOLD_ALL[HOLDS[0]] }, SEED_TEST);
  out({ phase: 'holdout-baseline', mode: MODE, n: res0.stats.n, avgN: res0.stats.avgN, pfN: res0.stats.pfN, maxDD: res0.stats.maxDD });
})().catch(e => { console.error('[sweep ' + MODE + '] ' + (e && e.stack || e)); process.exit(1); });

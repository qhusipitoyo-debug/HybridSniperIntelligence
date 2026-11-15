/* ============================================================
   UJI WALK-FORWARD SIGNAL LOCK — data kline 1m Binance (REST).

   Replay riwayat HARI hari lewat engine utama + lock engine yang
   SAMA dengan yang jalan live (lihat wf.js), lalu laporkan
   statistik trade tertutup GROSS vs NET (biaya spread diasumsikan
   COSTPCT % harga per sisi) + vonis otomatis.

   PENTING (jujur):
   - IN-SAMPLE: parameter default, TANPA optimisasi di sini.
   - Gerbang berita/makro netral (kalender tidak direplay) →
     angka cenderung optimis utk sisi berita.
   - Vonis LAYAK hanya jika n>=30 DAN CI95 bawah avgR NET > 0
     DAN maxDD <= 3R. Nol kompromi.

   Jalankan: node tools/lock_walkforward.js [SYM=BTCUSD] [HARI=15] [COSTPCT=0.02]
                                             [MODE=balanced] [ENTER=0] [CONF=0] [SLATR=0]
   ENTER/CONF/SLATR = override ambang lock (0 = default). Mengubah ambang
   lalu membaca hasilnya adalah EKSPLORASI IN-SAMPLE — ambang yang menurun
   HARUS dikonfirmasi ulang di data berikutnya (out-of-sample) sebelum
   dipercaya. Vonis alat tetap tanpa kompromi.
   ============================================================ */
'use strict';
const SYM = (process.argv[2] || 'BTCUSD').toUpperCase();
const DAYS = Number(process.argv[3] || 15);
const COSTPCT = Number(process.argv[4] || 0.02);
const MODE = (process.argv[5] || 'balanced');
const ENTER = Number(process.argv[6] || 0), CONF = Number(process.argv[7] || 0), SLATR = Number(process.argv[8] || 0);
const E = require('../engine.js'), LOCK = require('../lock.js'), WF = require('../wf.js');
if (ENTER) LOCK.setCfg({ enterScore: ENTER });
if (CONF) LOCK.setCfg({ confirmCandles: CONF });
if (SLATR) LOCK.setCfg({ slATR: SLATR });
const CSV = { BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT' }[SYM];
if (!CSV){ console.log('SYM hanya BTCUSD/ETHUSD (kline Binance)'); process.exit(1); }

const fmt = (x, s) => x == null ? '—' : (s || x.toFixed(2));
function report(res){
  const st = res.stats, cfg = res.config, v = WF.verdict(st);
  console.log('\n=== WALK-FORWARD ' + SYM + ' • mode ' + cfg.mode + ' • biaya ' + cfg.costPct.toFixed(2) + '%/sisi' +
    (ENTER ? ' • enter ' + ENTER : '') + (CONF ? ' • confirm ' + CONF : '') + (SLATR ? ' • slATR ' + SLATR : '') + ' • IN-SAMPLE ===');
  console.log('  periode                  : ' + new Date(cfg.from).toISOString().replace('T', ' ').slice(0, 16) + ' → ' + new Date(cfg.to).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
  console.log('  bar 1m direplay          : ' + cfg.bars);
  console.log('  trade tertutup           : ' + st.n);
  console.log('  breakdown status         : ' + JSON.stringify(st.byStatus));
  console.log('  ── GROSS (tanpa biaya) ──');
  console.log('    winrate               : ' + fmt(st.wrG, st.wrG == null ? null : st.wrG.toFixed(1) + '%') + ' (' + st.winsG + 'W)');
  console.log('    avg R/trade           : ' + fmt(st.avgG) + 'R');
  console.log('    profit factor         : ' + (st.pfG == null ? '—' : st.pfG === Infinity ? '∞' : st.pfG.toFixed(2)));
  console.log('  ── NET (spread masuk+keluar dipotong) ──');
  console.log('    winrate               : ' + fmt(st.wrN, st.wrN == null ? null : st.wrN.toFixed(1) + '%') + ' (' + st.winsN + 'W)');
  console.log('    avg R/trade net       : ' + fmt(st.avgN) + 'R  CI95 bawah ' + fmt(st.ciN) + 'R');
  console.log('    profit factor         : ' + (st.pfN == null ? '—' : st.pfN === Infinity ? '∞' : st.pfN.toFixed(2)));
  console.log('    total net / maxDD     : ' + fmt(st.totN) + 'R / ' + fmt(st.maxDD) + 'R');
  console.log('    rata-rata biaya/trade : ' + fmt(st.costAvg) + 'R');
  if (res.weeks.length){
    console.log('  ── PER MINGGU (net) ──');
    for (const w of res.weeks)
      console.log('    ' + w.week + '  n=' + String(w.n).padStart(3) + '  avg ' + fmt(w.n ? w.net / w.n : null).padStart(7) + 'R  tot ' + fmt(w.net).padStart(8) + 'R');
  }
  const sh = res.stability;
  console.log('  ── STABILITAS (60/40) ──');
  console.log('    periode awal  : n=' + String(sh.firstHalf.n).padStart(3) + '  avgR net ' + fmt(sh.firstHalf.avgN) + 'R');
  console.log('    periode akhir : n=' + String(sh.lastHalf.n).padStart(3) + '  avgR net ' + fmt(sh.lastHalf.avgN) + 'R');
  console.log('\n  VONIS OTOMATIS: ' + (v.code === 'LAYAK' ? '✓ LAYAK' : v.code === 'GAGAL' ? '✘ BELUM LAYAK' : '⏳ SAMPEL NOL'));
  for (const r of v.reasons) console.log('       • ' + r);
  console.log('  catatan: IN-SAMPLE (tanpa optimisasi); gerbang berita netral; biaya = asumsi spread.');
}

(async () => {
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
        process.stdout.write('\r  unduh kline: ' + bars.length + '/' + total + '   ');
      }
      break fetchLoop;
    } catch (e){ console.log('\n  host gagal (' + host + '): ' + e.message); }
  }
  console.log('');
  if (bars.length < 1000){ console.log('data kline kurang — periksa koneksi'); process.exit(1); }
  bars.sort((a, b) => a.k - b.k);
  const ded = [bars[0]];
  for (const b of bars) if (b.k > ded[ded.length - 1].k) ded.push(b);

  const runner = WF.createRunner({ E, LOCK, sym: SYM, bars: ded, costPct: COSTPCT, mode: MODE });
  let lastPct = -1, t0 = Date.now();
  while (!runner.step(400)){
    const p = runner.progress(), pct = Math.floor(p.done / p.total * 100);
    if (pct !== lastPct){ process.stdout.write('\r  replay: ' + pct + '%   '); lastPct = pct; }
  }
  console.log('\r  replay: 100% (' + ((Date.now() - t0) / 1000).toFixed(1) + ' dtk)   ');
  report(runner.result());
})().catch(e => { console.error(e); process.exit(1); });

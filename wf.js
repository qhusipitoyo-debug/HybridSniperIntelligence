/* ============================================================
   wf.js — Walk-Forward Replay untuk Signal Lock Engine (v1)

   Apa: memutar riwayat bar 1-menit (mis. kline Binance) MELALUI
   engine utama (engine.js) + Signal Lock Engine (lock.js) yang
   sama persis dengan yang jalan live — tanpa mengubah satu baris
   logic keduanya (modul ini HANYA memanggil API publik keduanya).

   Kenapa: vonis kelayakan butuh n >= 30 trade. Kalau hanya
   menunggu trade live, itu butuh berminggu-minggu. Replay
   historis mempercepat pengumpulan sampel.

   Batasan yang jujur (dilaporkan juga di hasil):
   - TETAP IN-SAMPLE: parameter (enterScore, slATR, mode, ...)
     tidak dioptimasi di sini. Hasil = perilaku konfigurasi saat
     ini di masa lalu, bukan jaminan masa depan.
   - Spread historis tidak tersedia → dipakai ASUMSI costPct
     (% harga PER SISI). Default 0.02% ≈ spread BTC/ETH broker
     retail; naikkan bila broker Anda lebih lebar.
   - Kalender berita tidak direplay → ctx makro netral
     (fng/news null). Provider berita/sentimen engine yang bersifat
     global wajib dimatikan CALLER selama replay (app.js melakukannya)
     supaya sentimen hari ini tidak bocor ke masa lalu. Sinyal yang
     di live diblok berita bisa muncul di replay → angka replay
     cenderung OPTIMIS untuk sisi berita.
   - RVOL lock dihitung dari densitas tick sintetis yang mengikuti
     volume kline (relatif, bukan tick asli).
   - Gerbang sesi engine (hours), cooldown, dan rem harian tetap
     berlaku persis seperti live.
   - Langkah evaluate 6 detik (= DT_CAP engine) supaya akumulasi
     prog/bleed konfirmasi sama ritmenya dengan live (1 dtk/eval).

   API (dipakai CLI tools/lock_walkforward.js DAN panel UI):
     WF.createRunner({E, LOCK, sym, bars, costPct, mode, macroCtx})
       .step(nBar)   → true bila selesai
       .progress()   → {done, total}
       .result()     → {config, trades, stats, weeks, stability}
     WF.verdict(stats) → {code: 'NOL'|'KURANG'... 'LAYAK'|'GAGAL', reasons}
   ============================================================ */
(function (root) {
'use strict';

function createRunner(cfg){
  const E = cfg.E, LOCK = cfg.LOCK, SYM = String(cfg.sym || '').toUpperCase();
  const P = E && E.PAIRS && E.PAIRS[SYM];
  if (!P) throw new Error('PAIRS tidak mengenal ' + SYM);
  if (!LOCK || typeof LOCK.onCandleClose !== 'function') throw new Error('LOCK (lock.js) wajib diisi');

  const bars = (cfg.bars || [])
    .filter(b => b && [b.k, b.o, b.h, b.l, b.c].every(v => Number.isFinite(Number(v))) && Number(b.o) > 0 && Number(b.h) >= Number(b.l))
    .map(b => ({ k: Math.floor(Number(b.k)), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), vol: Number(b.vol) || 0 }))
    .sort((a, b) => a.k - b.k);
  const SEED = Math.min(cfg.seedBars != null ? cfg.seedBars : 420, Math.max(0, bars.length - 50));
  if (bars.length - SEED < 50) throw new Error('bar replay terlalu sedikit: ' + (bars.length - SEED));

  const costPct = cfg.costPct != null ? Number(cfg.costPct) : 0.02; // % harga per sisi
  const TF      = cfg.tfMs || 15 * 60 * 1000;
  const EVAL_MS = 6000;  // = DT_CAP engine → ritme prog/bleed setara live
  const RVOL_W  = 60;    // jendela rata-rata volume utk densitas tick sintetis

  const eng = E.create(SYM, { mode: cfg.mode || 'balanced', stale: 90000, hasFlow: false, feed: 'wf' });
  eng.appendBars(bars.slice(0, SEED).map(b => ({ k: b.k, o: b.o, h: b.h, l: b.l, c: b.c })));

  /* ---- candle M15 lokal — logika identik dengan lockIngestTick app.js ---- */
  let cur = null, lastEv = null, lastSpr = 0;
  const closed15 = [], trades = [], pend = {};

  function lockIndicators(b15){
    const n = b15.length;
    if (n < 15) return null; // ATR14 butuh 15 bar — sama dengan app.js
    let tr = 0;
    for (let i = n - 14; i < n; i++){
      const b = b15[i], pc = b15[i - 1].close;
      tr += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    }
    let vSum = 0, vN = 0;
    for (let i = Math.max(0, n - 21); i < n - 1; i++){ vSum += b15[i].vol; vN++; }
    const rvol = vN && vSum > 0 ? b15[n - 1].vol / (vSum / vN) : 0;
    return { atr: tr / 14, rvol, spreadOK: true, spread: lastSpr };
  }

  function closeLockCandle(c){
    closed15.push(c);
    if (closed15.length > 260) closed15.shift();
    const dir = lastEv && lastEv.side === 'UP' ? 'BUY' : lastEv && lastEv.side === 'DOWN' ? 'SELL' : null;
    if (!dir) return;
    const ind = lockIndicators(closed15);
    const score = lastEv && Number.isFinite(lastEv.confidence) ? lastEv.confidence : NaN;
    const ctx = cfg.macroCtx ? cfg.macroCtx(SYM, c.time)
      : { fng: null, newsImpact: null, newsMinutesAway: null, dxyTrend: null };
    const r = LOCK.onCandleClose(SYM,
      { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close },
      ind, score, dir, ctx);
    if (r && r.event === 'LOCKED' && r.signal) pend[r.signal.id] = c.spr;
    if (r && r.event === 'CLOSED' && r.signal){
      const s = r.signal, risk = s.risk > 0 ? s.risk : NaN;
      /* Biaya jujur: spread masuk + spread keluar, dibagi risk (=1R).
         Ini yang TIDAK dipotongkan oleh replay NewsIntelegence. */
      const costR = Number.isFinite(pend[s.id]) && risk > 0
        ? (pend[s.id] + lastSpr) / risk : 0;
      delete pend[s.id];
      trades.push({ id: s.id, sym: SYM, dir: s.dir, status: s.status,
        resultR: s.resultR, costR, entry: s.entry, sl: s.sl,
        lockedAt: s.lockedAt, closedAt: s.closedAt });
    }
  }

  function lockTick(now, mid){
    const k = Math.floor(now / TF);
    if (!cur || cur.k !== k){
      if (cur && [cur.open, cur.high, cur.low, cur.close].every(Number.isFinite)) closeLockCandle(cur);
      cur = { k, time: k * TF, open: mid, high: mid, low: mid, close: mid, vol: 1, spr: lastSpr };
    } else {
      if (mid > cur.high) cur.high = mid;
      if (mid < cur.low) cur.low = mid;
      cur.close = mid; cur.vol++; cur.spr = lastSpr;
    }
  }

  /* ---- state replay ---- */
  let idx = SEED, nextEvalT = 0, vRoll = [];

  /* jalur harga 1 bar: o→h→l→c (bar naik) / o→l→h→c (bar turun),
     disampel nT titik; nT mengikuti volume bar (densitas → RVOL lock). */
  function ticksForBar(b, relVol){
    const nT = Math.max(4, Math.min(16, Math.round(4 + 4 * relVol)));
    const anchors = b.c >= b.o ? [b.o, b.h, b.l, b.c] : [b.o, b.l, b.h, b.c];
    const pts = [];
    for (let i = 0; i < nT; i++){
      const u = (i / (nT - 1)) * (anchors.length - 1);
      const s = Math.min(anchors.length - 2, Math.floor(u)), f = u - s;
      pts.push(anchors[s] * (1 - f) + anchors[s + 1] * f);
    }
    return pts;
  }

  function step(nBars){
    if (!nextEvalT && bars[SEED]) nextEvalT = bars[SEED].k * 60000 + EVAL_MS;
    const end = Math.min(bars.length, idx + (nBars || 1));
    for (; idx < end; idx++){
      const b = bars[idx];
      const volMean = vRoll.length ? vRoll.reduce((a, x) => a + x, 0) / vRoll.length : 0;
      const relVol = volMean > 0 ? b.vol / volMean : 1;
      vRoll.push(b.vol); if (vRoll.length > RVOL_W) vRoll.shift();

      const pts = ticksForBar(b, relVol), barMs = b.k * 60000;
      for (let i = 0; i < pts.length; i++){
        const t = barMs + Math.round((i + 1) * 60000 / pts.length);
        const px = pts[i];
        const spr = Math.max(px * costPct / 100, 1e-9);
        lastSpr = spr;
        eng.onTick(t, px - spr / 2, px + spr / 2);
        lockTick(t, px);
        /* evaluate di batas 6 dtk — DT_CAP engine membuat ritme
           akumulasi konfirmasi identik dengan live (eval tiap 1 dtk) */
        while (nextEvalT <= t){
          lastEv = eng.evaluate(nextEvalT);
          nextEvalT += EVAL_MS;
        }
      }
    }
    return idx >= bars.length;
  }

  function progress(){ return { done: idx - SEED, total: bars.length - SEED }; }

  /* ---- statistik & laporan ---- */
  function summarize(list){
    const n = list.length;
    const R = list.map(t => t.resultR);
    const NET = list.map(t => t.resultR - (t.costR || 0));
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const sd = a => { if (a.length < 2) return null; const m = avg(a);
      return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
    const ciLo = a => { const s = sd(a); return s == null ? null : avg(a) - 1.96 * s / Math.sqrt(a.length); };
    const pf = a => { const g = a.filter(x => x > 0).reduce((s, x) => s + x, 0),
      l = a.filter(x => x < 0).reduce((s, x) => s - x, 0);
      return l > 0 ? g / l : (g > 0 ? Infinity : null); };
    let c = 0, p = 0, dd = 0;
    for (const x of NET){ c += x; p = Math.max(p, c); dd = Math.max(dd, p - c); }
    const by = {};
    for (const t of list) by[t.status] = (by[t.status] || 0) + 1;
    return {
      n,
      winsG: R.filter(x => x > 0).length, winsN: NET.filter(x => x > 0).length,
      wrG: n ? 100 * R.filter(x => x > 0).length / n : null,
      wrN: n ? 100 * NET.filter(x => x > 0).length / n : null,
      avgG: avg(R), avgN: avg(NET), ciN: ciLo(NET),
      pfG: pf(R), pfN: pf(NET),
      totN: NET.reduce((a, b) => a + b, 0), maxDD: dd,
      costAvg: n ? list.reduce((a, t) => a + (t.costR || 0), 0) / n : 0,
      byStatus: by
    };
  }

  function weekly(list){
    const map = {};
    for (const t of list){
      const w = Math.floor((t.closedAt || 0) / (7 * 86400000));
      const key = new Date(w * 7 * 86400000).toISOString().slice(0, 10);
      const g = map[key] || (map[key] = { week: key, n: 0, gross: 0, net: 0 });
      g.n++; g.gross += t.resultR; g.net += t.resultR - (t.costR || 0);
    }
    return Object.values(map).sort((a, b) => a.week < b.week ? -1 : 1);
  }

  function result(){
    const t0 = bars[SEED].k * 60000, t1 = bars[bars.length - 1].k * 60000 + 60000;
    const cut = t0 + 0.6 * (t1 - t0);
    return {
      config: { sym: SYM, mode: cfg.mode || 'balanced', costPct,
        bars: bars.length - SEED, seedBars: SEED, from: t0, to: t1, tfMin: TF / 60000 },
      trades: trades.slice(),
      stats: summarize(trades),
      weeks: weekly(trades),
      stability: {
        cutAt: cut,
        firstHalf: summarize(trades.filter(t => (t.closedAt || 0) < cut)),
        lastHalf:  summarize(trades.filter(t => (t.closedAt || 0) >= cut))
      }
    };
  }

  return { step, progress, result };
}

/* vonis — aturan sama dengan tools/lock_backtest.js & panel vonis live:
   n >= 30 DAN batas bawah CI95 avgR NET > 0 → LAYAK */
function verdict(st){
  if (!st || !st.n) return { code: 'NOL', reasons: ['belum ada trade tertutup di jendela replay'] };
  const reasons = [];
  if (st.n < 30) reasons.push('n=' + st.n + ' < 30 — sampel kurang, angka apa pun belum berarti');
  if (st.ciN == null || st.ciN <= 0)
    reasons.push('CI95 bawah avgR net ' + (st.ciN == null ? '—' : st.ciN.toFixed(2) + 'R') + ' ≤ 0 — edge belum terbukti setelah biaya');
  if (st.maxDD > 3) reasons.push('maxDD ' + st.maxDD.toFixed(1) + 'R melebihi 3R — risiko kurang sehat');
  return reasons.length ? { code: 'GAGAL', reasons } : { code: 'LAYAK', reasons: [] };
}

const WF = { createRunner, verdict };
if (typeof module !== 'undefined' && module.exports) module.exports = WF;
else root.WF = WF;
})(typeof window !== 'undefined' ? window : globalThis);

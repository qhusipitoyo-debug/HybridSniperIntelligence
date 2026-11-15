/* ============================================================
   SIGNAL LOCK ENGINE v2 — gerbang akhir (last gate) sebelum order.
   Dipanggil HANYA saat candle timeframe sinyal (M15) CLOSE.
   Skor (0–100) & arah tetap dari engine utama; modul ini hanya:
   filter kualitas → konfirmasi berulang → BEKUKAN level (lock).

   Perbaikan v2 (vs potongan awal):
   1) newsMinutesAway null/undefined → Math.abs(null)=0 → SEMUA sinyal
      terblokir diam-diam. Sekarang hanya blokir bila angka valid.
   2) rvol undefined lolos filter (`ind.rvol < 1.1` = false). Sekarang
      wajib finite & >= minRVOL.
   3) atr 0/undefined → isSpike() selalu true (semua candle dianggap
      spike) dan risk = 0 → SL = TP = entry. ATR wajib > 0 sekarang.
   4) spreadOK undefined menolak SEMUA sinyal tanpa petunjuk. Sekarang
      kasus itu mengembalikan why:'SPREAD?' agar terlihat di log.
   5) dir tidak divalidasi — selain 'BUY' dianggap SELL diam-diam.
      Sekarang wajib 'BUY'/'SELL', selain itu event ERROR.
   6) TP2 dihitung tapi TIDAK PERNAH dipakai (posisi mati di TP1).
      Sekarang: TP1 → close 50% + SL digeser ke entry (BE), sisa 50%
      ditarik ke TP2; hasil R dibebankan benar di event CLOSED.
   7) Sinyal terkunci hidup selamanya bila harga sideways. Sekarang
      ada TTL (maxHoldMs) → ditutup status TIME.
   8) Konfirmasi "berturut-turut" tidak menghitung gap candle (feed
      putus → dua candle terpisah tetap dihitung berturut). Sekarang
      jarak > 1.5×tf memutus rantai konfirmasi.
   9) Simbol crypto dipatok 'BTCUSDT'/'ETHUSDT' padahal repo memakai
      'BTCUSD'/'ETHUSD'. Sekarang keduanya (regex) diterima.
   10) skor null/undefined membuat invalidasi (`score < dropScore`)
       tidak pernah jalan (undefined<50 = false). Wajib finite.
   ============================================================ */
(function(root){
'use strict';

const LOCK_CFG = {
  enterScore: 70,        // skor minimum untuk kandidat (0–100)
  dropScore: 50,         // hysteresis: batal jika skor < ini
  confirmCandles: 2,     // jumlah candle close berturut-turut searah
  maxRangeATR: 2.5,      // candle > 2.5 ATR dianggap spike
  maxWickRatio: 0.6,     // wick > 60% range = rejection/fake
  minRVOL: 1.1,          // volume relatif minimum (BTC/ETH)
  cooldownMs: 30 * 60 * 1000,
  newsBlockMin: 30,      // blok ±30 menit dari High impact
  rr: [1.5, 2.5],        // TP1, TP2 dalam kelipatan R
  slATR: 1.5,
  maxHoldMs: 4 * 60 * 60 * 1000, // TTL plan terkunci (4 jam) — baru di v2
  tfMs: 15 * 60 * 1000,  // timeframe candle sinyal — untuk cek gap konfirmasi
  tp1Frac: 0.5           // porsi posisi yang ditutup di TP1
};

/* state internal: symbol -> object */
const candidates = {}; // {dir, count, lastCandleTime}
const locked     = {}; // sinyal terkunci (dibekukan)
const cooldown   = {}; // symbol -> timestamp bebas lagi
const history    = []; // ringkasan CLOSED (terbaru di akhir)

const isCrypto = s => /^(BTC|ETH)(USD|USDT)$/i.test(s || '');
const isGold   = s => /XAU|GOLD/i.test(s || '');
const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);

/* Fear & Greed bisa datang sebagai 0–100 (index) atau -1..+1 (score).
   Normalisasi ke 0–100 agar ambang 80/20 konsisten. */
function fngPct(v){
  if (!isFiniteNum(v)) return null;
  return Math.abs(v) <= 1 ? (v + 1) / 2 * 100 : v;
}

function isSpike(c, atr){
  if (!(atr > 0)) return false;          // FIX (3): tanpa ATR valid, jangan sangka spike
  const range = c.high - c.low;
  if (range <= 0) return true;           // candle flat/0-range: data tidak layak dikonfirmasi
  const body = Math.abs(c.close - c.open);
  const wick = (range - body) / range;
  return range > LOCK_CFG.maxRangeATR * atr || wick > LOCK_CFG.maxWickRatio;
}

function macroAllows(sym, dir, ctx){
  // ctx: {fng (0-100 ATAU -1..1), newsMinutesAway, newsImpact, dxyTrend}
  ctx = ctx || {};
  // FIX (1): hanya blokir bila newsMinutesAway benar-benar angka.
  if (ctx.newsImpact === 'High' && isFiniteNum(ctx.newsMinutesAway) &&
      Math.abs(ctx.newsMinutesAway) <= LOCK_CFG.newsBlockMin)
    return { ok:false, why:'NEWS BLOCK' };

  const fng = fngPct(ctx.fng);
  if (isCrypto(sym) && fng != null) {
    if (dir === 'BUY'  && fng > 80) return { ok:false, why:'EXTREME GREED' };
    if (dir === 'SELL' && fng < 20) return { ok:false, why:'EXTREME FEAR' };
  } else if (isGold(sym) && isFiniteNum(ctx.dxyTrend)) {
    // emas biasanya berlawanan dengan DXY (dxyTrend: +1 naik, -1 turun, 0 netral)
    if (dir === 'BUY'  && ctx.dxyTrend > 0.2) return { ok:false, why:'DXY NAIK' };
    if (dir === 'SELL' && ctx.dxyTrend < -0.2) return { ok:false, why:'DXY TURUN' };
  }
  return { ok:true };
}

/* tutup plan terkunci: catat history, set cooldown, bebaskan simbol */
function finish(sym, s, status, resultR, now){
  s.status = status;
  s.resultR = Math.round(resultR * 1000) / 1000;
  s.closedAt = now;
  history.push({ id:s.id, sym, dir:s.dir, entry:s.entry, status, resultR:s.resultR, closedAt:now });
  if (history.length > 200) history.shift();
  cooldown[sym] = now + LOCK_CFG.cooldownMs;
  delete locked[sym];
  return { event:'CLOSED', signal:s };
}

/* Panggil HANYA saat candle baru close (bukan tiap tick) */
function onCandleClose(sym, candle, ind, score, dir, ctx){
  const now = Date.now();

  /* --- validasi input (baru di v2) --- */
  if (!candle || !isFiniteNum(candle.time) || !isFiniteNum(candle.open) ||
      !isFiniteNum(candle.high) || !isFiniteNum(candle.low) || !isFiniteNum(candle.close))
    return { event:'ERROR', why:'CANDLE TIDAK VALID' };
  if (dir !== 'BUY' && dir !== 'SELL')            // FIX (5)
    return { event:'ERROR', why:'ARAH TIDAK VALID' };
  if (!ind || !isFiniteNum(ind.atr) || ind.atr <= 0)   // FIX (3)
    return { event:'REJECT', why:'ATR BELUM SIAP' };

  /* --- 1) sinyal terkunci → kelola posisi, jangan ubah level --- */
  if (locked[sym]){
    const s = locked[sym];
    const buy  = s.dir === 'BUY';
    const hitSL  = buy ? candle.low  <= s.sl  : candle.high >= s.sl;
    const hitTP2 = buy ? candle.high >= s.tp2 : candle.low  <= s.tp2;
    const hitTP1 = buy ? candle.high >= s.tp1 : candle.low  <= s.tp1;

    // FIX (6+7): SL dicek dulu (konservatif bila candle menyentuh dua sisi),
    // lalu TP2 (implisit TP1 sudah lewat), lalu TP1 → BE, lalu TTL.
    if (hitSL){
      if (s.tp1Hit){
        // sisa 50% keluar di entry (SL sudah digeser ke BE)
        return finish(sym, s, 'BE', LOCK_CFG.tp1Frac * LOCK_CFG.rr[0], now);
      }
      return finish(sym, s, 'SL', -1, now);
    }
    // high >= tp2 (atau low <= tp2 untuk SELL) berarti harga PASTI melewati TP1
    // lebih dulu — dan karena hitSL sudah ditolak di atas, jalur TP1→TP2 sah.
    // Jadi TP2 ditutup penuh walau candle yang sama adalah candle TP1 pertama.
    if (hitTP2){
      return finish(sym, s, 'TP2',
        LOCK_CFG.tp1Frac * LOCK_CFG.rr[0] + (1 - LOCK_CFG.tp1Frac) * LOCK_CFG.rr[1], now);
    }
    if (hitTP1 && !s.tp1Hit){
      s.tp1Hit = true;
      s.status = 'TP1_HIT';
      s.sl = s.entry;                       // BE: SL digeser ke entry
      return { event:'TP1', signal:s };
    }
    // TTL dihitung dari WAKTU CANDLE (bukan wall-clock) agar perilaku
    // live = perilaku backtest dan tahan terhadap Replay/simulasi.
    if (candle.time - s.lockedCandleTime > LOCK_CFG.maxHoldMs){
      const r = buy ? (candle.close - s.entry) / s.risk : (s.entry - candle.close) / s.risk;
      const rr = s.tp1Hit
        ? LOCK_CFG.tp1Frac * LOCK_CFG.rr[0] + (1 - LOCK_CFG.tp1Frac) * r : r;
      return finish(sym, s, 'TIME', rr, now);
    }
    // FIX (10): invalidasi butuh skor finite
    if (isFiniteNum(score) && score < LOCK_CFG.dropScore && !s.tp1Hit){
      return finish(sym, s, 'INVALID', 0, now);
    }
    return { event:'HOLD', signal:s };
  }

  /* --- 2) cooldown --- */
  if (cooldown[sym]){
    if (now < cooldown[sym]) return { event:'COOLDOWN', until:cooldown[sym] };
    delete cooldown[sym];                    // bersihkan entri kedaluwarsa
  }

  /* --- 3) filter kualitas --- */
  const macro = macroAllows(sym, dir, ctx);
  const bad =
    !isFiniteNum(score) || score < LOCK_CFG.enterScore ||
    isSpike(candle, ind.atr) ||
    !(isFiniteNum(ind.rvol) && ind.rvol >= LOCK_CFG.minRVOL) ||  // FIX (2)
    !ind.spreadOK ||                                            // FIX (4): lihat why di bawah
    !macro.ok;

  if (bad){
    delete candidates[sym];
    return { event:'REJECT', why:
      !ind.spreadOK ? (ind.spreadOK === undefined ? 'SPREAD? (filter belum diisi caller)' : 'SPREAD LEBAR')
      : !macro.ok ? macro.why
      : !isFiniteNum(score) ? 'SKOR TIDAK VALID'
      : isSpike(candle, ind.atr) ? 'SPIKE'
      : !(isFiniteNum(ind.rvol) && ind.rvol >= LOCK_CFG.minRVOL) ? 'RVOL RENDAH'
      : 'SKOR < ' + LOCK_CFG.enterScore };
  }

  /* --- 4) konfirmasi berulang (anti fake) --- */
  const c = candidates[sym];
  if (c && c.dir === dir && c.lastCandleTime !== candle.time){
    // FIX (8): gap candle memutus rantai "berturut-turut"
    if (LOCK_CFG.tfMs > 0 && candle.time - c.lastCandleTime > LOCK_CFG.tfMs * 1.5)
      candidates[sym] = { dir, count:1, lastCandleTime:candle.time };
    else { c.count++; c.lastCandleTime = candle.time; }
  } else if (!c || c.dir !== dir){
    candidates[sym] = { dir, count:1, lastCandleTime:candle.time };
  }
  /* candle.time sama diproses ulang → diabaikan (anti double-count) */

  if (candidates[sym].count < LOCK_CFG.confirmCandles)
    return { event:'PENDING', count:candidates[sym].count };

  /* --- 5) KUNCI: level dibekukan sekali saja --- */
  const entry = candle.close;
  const risk = ind.atr * LOCK_CFG.slATR;
  if (!(risk > 0)) return { event:'REJECT', why:'RISK = 0' };
  const sgn = dir === 'BUY' ? 1 : -1;
  locked[sym] = {
    id: sym + '-' + candle.time,
    sym, dir, entry, score,
    risk,
    sl:  entry - sgn * risk,
    tp1: entry + sgn * risk * LOCK_CFG.rr[0],
    tp2: entry + sgn * risk * LOCK_CFG.rr[1],
    tp1Hit:false,
    lockedAt: now, lockedCandleTime: candle.time, status:'LOCKED'
  };
  delete candidates[sym];
  return { event:'LOCKED', signal:locked[sym] };
}

/* ---- API ---- */
const API = {
  LOCK_CFG,
  onCandleClose,
  isSpike, macroAllows,
  setCfg: patch => { if (patch && typeof patch === 'object') Object.assign(LOCK_CFG, patch); },
  lockedPlan: sym => locked[sym] ? Object.assign({}, locked[sym]) : null,
  allLocked: () => Object.keys(locked).map(k => Object.assign({}, locked[k])),
  allCandidates: () => Object.keys(candidates).map(k => Object.assign({}, candidates[k], { sym:k })),
  historyList: () => history.slice(),
  reset: () => { for (const k of Object.keys(candidates)) delete candidates[k];
                 for (const k of Object.keys(locked)) delete locked[k];
                 for (const k of Object.keys(cooldown)) delete cooldown[k];
                 history.length = 0; }
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.SnapLock = API;
})(typeof window !== 'undefined' ? window : globalThis);

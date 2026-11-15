/* Uji Signal Lock Engine v2 — jalankan: node tools/lock_test.js */
'use strict';
const L = require('../lock.js');

let pass = 0, fail = 0;
function check(name, cond, extra){
  if (cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}
const T0 = Date.now();
/* candle M15 sintetis: {time, open, high, low, close} */
const TF = 15 * 60 * 1000;
const candle = (i, o, h, l, c) => ({ time: Math.floor((T0 + i * TF) / TF) * TF, open:o, high:h, low:l, close:c });
const ind = { atr: 10, rvol: 1.5, spreadOK: true, spread: 1 };
const ctx = {};

console.log('1) Kandidat butuh 2 candle berturut-turut:');
const RK = 10 * L.LOCK_CFG.slATR; // risk fixture: ATR 10 × slATR
let r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', ctx);
check('candle 1 → PENDING', r.event === 'PENDING' && r.count === 1, r);
r = L.onCandleClose('BTCUSD', candle(1, 104, 110, 102, 108), ind, 80, 'BUY', ctx);
check('candle 2 → LOCKED', r.event === 'LOCKED', r);
check('SL = entry - slATR×ATR', Math.abs(r.signal.sl - (108 - RK)) < 1e-9, r.signal);
check('TP1 = entry + 1.5R', Math.abs(r.signal.tp1 - (108 + 1.5 * RK)) < 1e-9, r.signal);
check('TP2 = entry + 2.5R', Math.abs(r.signal.tp2 - (108 + 2.5 * RK)) < 1e-9, r.signal);

console.log('2) Sinyal terkunci bertahan (HOLD):');
r = L.onCandleClose('BTCUSD', candle(2, 108, 112, 105, 110), ind, 80, 'BUY', ctx);
check('HOLD tanpa menyentuh SL/TP', r.event === 'HOLD', r);

console.log('3) TP1 → BE, sisa ke TP2:');
r = L.onCandleClose('BTCUSD', candle(3, 110, 108 + 1.5 * RK + 2, 109, 108 + 1.5 * RK), ind, 80, 'BUY', ctx);
check('TP1 event', r.event === 'TP1', r);
check('SL digeser ke entry (BE)', r.signal.sl === r.signal.entry, r.signal);
r = L.onCandleClose('BTCUSD', candle(4, 131, 120, 100.5, 101), ind, 80, 'BUY', ctx);
check('mundur ke entry → CLOSED BE', r.event === 'CLOSED' && r.signal.status === 'BE', r);
check('hasil BE = 0.5×1.5R = +0.75R', Math.abs(r.signal.resultR - 0.75) < 1e-9, r.signal);

console.log('4) Cooldown aktif setelah close:');
r = L.onCandleClose('BTCUSD', candle(5, 101, 108, 100, 107), ind, 80, 'BUY', ctx);
check('COOLDOWN', r.event === 'COOLDOWN', r);

console.log('5) Skenario TP2 penuh:');
r = L.onCandleClose('ETHUSD', candle(0, 200, 206, 199, 205), ind, 85, 'BUY', ctx);
r = L.onCandleClose('ETHUSD', candle(1, 205, 212, 203, 210), ind, 85, 'BUY', ctx);
check('LOCKED', r.event === 'LOCKED', r);
const entry = r.signal.entry, tp1 = r.signal.tp1, tp2 = r.signal.tp2, sl = r.signal.sl;
r = L.onCandleClose('ETHUSD', candle(2, 210, tp2 + 2, 208, tp2), ind, 85, 'BUY', ctx);
check('TP2 langsung → CLOSED TP2', r.event === 'CLOSED' && r.signal.status === 'TP2', r);
check('hasil TP2 = 0.5×1.5 + 0.5×2.5 = 2.0R', Math.abs(r.signal.resultR - 2.0) < 1e-9, r.signal);

console.log('6) SL kena dulu (konservatif meski TP ikut tersentuh):');
r = L.onCandleClose('XAUUSD', candle(0, 2400, 2406, 2398, 2405), ind, 75, 'BUY', ctx);
r = L.onCandleClose('XAUUSD', candle(1, 2405, 2412, 2402, 2410), ind, 75, 'BUY', ctx);
check('LOCKED', r.event === 'LOCKED', r);
const slGold = r.signal.sl, tp1Gold = r.signal.tp1;
r = L.onCandleClose('XAUUSD', candle(2, 2410, tp1Gold, slGold - 1, 2408), ind, 75, 'BUY', ctx);
check('SL + TP1 dalam satu candle → SL', r.event === 'CLOSED' && r.signal.status === 'SL', r);
check('hasil SL = -1R', Math.abs(r.signal.resultR - (-1)) < 1e-9, r.signal);

console.log('7) Filter Spike / RVOL / Spread / Skor:');
L.reset();
r = L.onCandleClose('BTCUSD', candle(0, 100, 140, 98, 104), ind, 80, 'BUY', ctx); // range 42 > 2.5×10
check('candle spike ditolak', r.event === 'REJECT' && r.why === 'SPIKE', r);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), { atr:10, rvol:0.8, spreadOK:true, spread:1 }, 80, 'BUY', ctx);
check('rvol rendah ditolak', r.event === 'REJECT' && r.why === 'RVOL RENDAH', r);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), { atr:10, rvol:1.5, spreadOK:false }, 80, 'BUY', ctx);
check('spread lebar ditolak', r.event === 'REJECT' && r.why === 'SPREAD LEBAR', r);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), { atr:10 }, 80, 'BUY', ctx);
check('spreadOK tidak diisi → why eksplisit', r.event === 'REJECT' && /SPREAD\?/.test(r.why), r);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 50, 'BUY', ctx);
check('skor di bawah enterScore ditolak', r.event === 'REJECT', r);

console.log('8) Gerbang makro:');
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', { fng: 95 });
check('FNG extreme greed memblokir BUY', r.event === 'REJECT' && r.why === 'EXTREME GREED', r);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', { fng: 0.9 }); // skala -1..1
check('FNG skala -1..1 ikut dinormalisasi', r.event === 'REJECT' && r.why === 'EXTREME GREED', r);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', { newsImpact:'High', newsMinutesAway:null });
check('newsMinutesAway null TIDAK memblokir (bug lama)', r.event === 'PENDING', r);
r = L.onCandleClose('XAUUSD', candle(0, 2400, 2406, 2398, 2405), ind, 80, 'BUY', { newsImpact:'High', newsMinutesAway:10 });
check('news ±30m High memblokir', r.event === 'REJECT' && r.why === 'NEWS BLOCK', r);
r = L.onCandleClose('XAUUSD', candle(0, 2400, 2406, 2398, 2405), ind, 80, 'BUY', { dxyTrend: 0.8 });
check('DXY naik memblokir BUY gold', r.event === 'REJECT' && r.why === 'DXY NAIK', r);

console.log('9) Validasi input & invalidasi BERLAWANAN (v3):');
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'MAYBE', ctx);
check('arah tidak valid → ERROR', r.event === 'ERROR', r);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), { atr:0, rvol:1.5, spreadOK:true, spread:1 }, 80, 'BUY', ctx);
check('ATR 0 → REJECT (bukan crash)', r.event === 'REJECT' && r.why === 'ATR BELUM SIAP', r);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', ctx);
r = L.onCandleClose('BTCUSD', candle(1, 104, 110, 102, 108), ind, 80, 'BUY', ctx);
check('LOCKED', r.event === 'LOCKED', r);
r = L.onCandleClose('BTCUSD', candle(2, 108, 111, 104, 106), ind, 40, 'BUY', ctx);
check('skor melemah (40) TIDAK membunuh posisi (v3)', r.event === 'HOLD', r);
r = L.onCandleClose('BTCUSD', candle(3, 106, 109, 103, 105), ind, 80, 'SELL', ctx);
check('sinyal BERLAWANAN kuat → INVALID', r.event === 'CLOSED' && r.signal.status === 'INVALID', r);
check('INVALID dibebankan R riil: (105-108)/RK = ' + (-3 / RK).toFixed(3) + 'R', Math.abs(r.signal.resultR - (-3 / RK)) < 1e-9, r.signal);

console.log('10) Gap candle memutus konfirmasi:');
L.reset();
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', ctx);
r = L.onCandleClose('BTCUSD', candle(5, 104, 110, 102, 108), ind, 80, 'BUY', ctx); // lompat 5 tf
check('gap > 1.5×tf → tetap PENDING count 1', r.event === 'PENDING' && r.count === 1, r);

console.log('11) Double-close candle yang sama tidak dihitung dua kali:');
L.reset();
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', ctx);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', ctx); // duplikat event
check('duplikat candle → count tetap 1', r.event === 'PENDING' && r.count === 1, r);

console.log('12) TTL plan terkunci:');
L.reset();
L.setCfg({ maxHoldMs: 2 * TF });
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', ctx);
r = L.onCandleClose('BTCUSD', candle(1, 104, 110, 102, 108), ind, 80, 'BUY', ctx);
r = L.onCandleClose('BTCUSD', candle(20, 108, 112, 105, 110), ind, 80, 'BUY', ctx); // 20 tf sejak lock > 2 tf TTL
check('melewati TTL → CLOSED TIME', r.event === 'CLOSED' && r.signal.status === 'TIME', r);
L.setCfg({ maxHoldMs: 4 * 60 * 60 * 1000 });

console.log('13) Gerbang biaya (v3):');
L.reset();
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), { atr:10, rvol:1.5, spreadOK:true, spread:8 }, 80, 'BUY', ctx);
check('spread 8 vs risk ' + RK + ' = ' + (800 / RK).toFixed(0) + '% > 25% → BIAYA TINGGI', r.event === 'REJECT' && r.why.startsWith('BIAYA TINGGI'), r);
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), { atr:10, rvol:1.5, spreadOK:true }, 80, 'BUY', ctx);
check('spread tidak diukur → fail-closed', r.event === 'REJECT' && r.why.startsWith('BIAYA TIDAK DIUKUR'), r);

console.log('14) Rem rugi harian (v3):');
L.reset();
L.setCfg({ maxDailyLossR: 1, cooldownMs: 10 * 60000 });
r = L.onCandleClose('BTCUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', ctx);
r = L.onCandleClose('BTCUSD', candle(1, 104, 110, 102, 108), ind, 80, 'BUY', ctx);
r = L.onCandleClose('BTCUSD', candle(2, 108, 112, 80, 82), ind, 80, 'BUY', ctx); // SL kena (-1R)
check('SL menutup hari -1R', r.event === 'CLOSED' && r.signal.status === 'SL', r);
r = L.onCandleClose('ETHUSD', candle(0, 200, 205, 198, 204), ind, 80, 'BUY', ctx);
check('entry baru ditolak: BATAS RUGI HARIAN (di atas cooldown)', r.event === 'REJECT' && r.why.startsWith('BATAS RUGI HARIAN'), r);
L.setCfg({ maxDailyLossR: 3, cooldownMs: 30 * 60 * 1000 });

console.log('15) Maksimum posisi serentak (v3):');
L.reset();
for (const s of ['BTCUSD', 'ETHUSD', 'XAUUSD']){
  L.onCandleClose(s, candle(0, 100, 105, 98, 104), ind, 80, 'BUY', ctx);
  r = L.onCandleClose(s, candle(1, 104, 110, 102, 108), ind, 80, 'BUY', ctx);
}
check('3 simbol terkunci', Object.keys(L.allLocked()).length === 3);
r = L.onCandleClose('AUDUSD', candle(0, 100, 105, 98, 104), ind, 80, 'BUY', ctx);
r = L.onCandleClose('AUDUSD', candle(1, 104, 110, 102, 108), ind, 80, 'BUY', ctx);
check('simbol ke-4 ditolak: MAKS POSISI', r.event === 'REJECT' && r.why.startsWith('MAKS POSISI'), r);

console.log('\nHasil: ' + pass + ' lulus, ' + fail + ' gagal');
process.exit(fail ? 1 : 0);

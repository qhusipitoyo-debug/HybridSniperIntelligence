/* ============================================================
   SNIPERNEWS INTELLIGENCE — HYBRID ENGINE CONTROLLER
   Menggabungkan Radar Makro & Berita dengan Scanner Teknikal Sniper 14 Pair.
   ============================================================ */
console.log('[app] SniperNews Hybrid Controller initialized');

const $ = id => document.getElementById(id);
const N = x => Number(x) || 0;
const E = window.FXEngine;
if (!E) console.error('engine.js belum termuat');

const STORE = 'sniperNewsHybrid';
const PAIRS = E.PAIRS;
const ALL_KEYS = Object.keys(PAIRS);

const FEEDS = {
  hybrid:  { label: 'Binance + Deriv (Hybrid)', short: 'HYBRID', stale: 15000, flow: true },
  deriv:   { label: 'Deriv (14 Pair)',          short: 'DERIV',  stale: 20000, flow: false },
  binance: { label: 'Binance (BTC/ETH USDT)',   short: 'BINANCE', stale: 12000, flow: true }
};

const DERIV_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const BINANCE_WS_HOSTS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443', 'wss://stream.binance.com'];

let selectedFeed = 'hybrid';
let selectedMode = 'balanced';
let calendarEvents = [];
let sentimentData = null;
let pairStats = null;
let nextCatalyst = null;

const engines = {};
const quotes = {};
const signalStates = {};
const plans = {};
let storedEntries = [];
let historyEntries = [];
let settings = { balance: 1000, riskPct: 1 };

const sgn = (v, d = 2) => `${N(v) >= 0 ? '+' : ''}${N(v).toFixed(d)}`;
const fmtR = v => v == null ? '—' : sgn(v, 2) + 'R';
const safeText = (id, txt) => { try { const el = $(id); if (el) el.textContent = txt; } catch {} };
const safeHTML = (id, html) => { try { const el = $(id); if (el) el.innerHTML = html; } catch {} };
const safeClass = (id, cls) => { try { const el = $(id); if (el) el.className = cls; } catch {} };

/* ---------- WebSocket Helper ---------- */
function openWS(url, onOpen, onMsg, label = 'ws') {
  let ws = null, delay = 500, dead = false;
  const go = () => {
    if (dead) return;
    try {
      const me = new WebSocket(url);
      ws = me;
      me.onopen = () => { if (dead || ws !== me) return; onOpen && onOpen(me); };
      me.onmessage = e => { if (dead || ws !== me) return; delay = 500; try { onMsg(JSON.parse(e.data)); } catch {} };
      me.onerror = () => {};
      me.onclose = () => { if (dead || ws !== me) return; setTimeout(go, delay); delay = Math.min(15000, delay * 2); };
    } catch { setTimeout(go, delay); }
  };
  go();
  return () => { dead = true; if (ws) try { ws.close(); } catch {} };
}

/* ---------- Inisialisasi Engine & Kalender ---------- */
function initEngines() {
  const now = Date.now();
  ALL_KEYS.forEach(pair => {
    const hasFlow = (selectedFeed === 'binance' || selectedFeed === 'hybrid') && !!PAIRS[pair].binance;
    const eng = E.create(pair, { mode: selectedMode, stale: 20000, hasFlow, feed: selectedFeed });
    engines[pair] = eng;
    if (!signalStates[pair]) {
      signalStates[pair] = { stage: 'WAIT', side: 'WAIT', confidence: 0, generatedAt: 0, reason: 'Warming…', confirming: false };
    }
  });
}

/* ---------- Hook Penyedia Berita & Sentimen ---------- */
function setupProviders() {
  // 1. News Provider Hook: memblokir sinyal teknikal saat berada di jendela berita besar
  E.setNewsProvider((pairKey, now) => {
    if (!calendarEvents || !calendarEvents.length) return null;
    const p = PAIRS[pairKey];
    if (!p) return null;
    const currs = [pairKey.slice(0, 3), pairKey.slice(3, 6)];
    if (pairKey === 'XAUUSD') currs.push('USD', 'XAU');
    if (pairKey === 'BTCUSD' || pairKey === 'ETHUSD') currs.push('USD');

    for (const ev of calendarEvents) {
      if (ev.impact !== 'High' && ev.impact !== 'Medium') continue;
      if (!currs.includes(ev.country)) continue;
      const diff = ev.ts - now; // ms
      if (diff >= -15 * 60000 && diff <= 0) {
        return { phase: 'post', impact: ev.impact === 'High' ? 3 : 2, event: ev.title };
      }
      if (diff > 0 && diff <= 15 * 60000) {
        return { phase: 'pre', impact: ev.impact === 'High' ? 3 : 2, event: ev.title };
      }
    }
    return null;
  });

  // 2. Sentiment Provider Hook: menyelaraskan skor teknikal dengan rezim makro
  E.setSentimentProvider((pairKey, now) => {
    if (!sentimentData) return null;
    const isCrypto = PAIRS[pairKey] && PAIRS[pairKey].kind === 'crypto';
    const isGold = pairKey === 'XAUUSD';
    let pairBias = 0;
    if (isCrypto && sentimentData.fng) {
      pairBias = sentimentData.fng.score || 0; // -1 to +1
    } else if (isGold && sentimentData.market24h) {
      pairBias = sentimentData.market24h.goldPct > 0 ? 0.3 : -0.3;
    }
    return { pairBias, riskScore: sentimentData.market24h ? sentimentData.market24h.riskBias : 0 };
  });
}

/* ---------- Load Kalender & Sentimen Makro ---------- */
async function loadMacroContext() {
  try {
    const [cRes, sRes, pRes] = await Promise.all([
      fetch('stats/calendar.json?v=' + Date.now(), { cache: 'no-store' }),
      fetch('stats/sentiment.json?v=' + Date.now(), { cache: 'no-store' }),
      fetch('stats/pair_stats.json?v=' + Date.now(), { cache: 'no-store' })
    ]);
    if (cRes.ok) calendarEvents = await cRes.json();
    if (sRes.ok) sentimentData = await sRes.json();
    if (pRes.ok) pairStats = await pRes.json();
  } catch (e) {
    console.warn('loadMacroContext', e);
  }
  updateMacroUI();
  updateNextCatalyst();
}

function updateMacroUI() {
  if (sentimentData) {
    if (sentimentData.fng) {
      safeText('fngMetric', `${sentimentData.fng.value} ${sentimentData.fng.classification}`);
    }
    if (sentimentData.market24h) {
      const rb = sentimentData.market24h.riskBias || 0;
      safeText('regimeMetric', rb < -0.3 ? 'RISK-OFF' : (rb > 0.3 ? 'RISK-ON' : 'NETRAL'));
    }
  }
}

function updateNextCatalyst() {
  const now = Date.now();
  if (!calendarEvents || !calendarEvents.length) return;
  const upcoming = calendarEvents
    .filter(e => e.ts > now && (e.impact === 'High' || e.impact === 'Medium'))
    .sort((a, b) => a.ts - b.ts);

  if (upcoming.length) {
    nextCatalyst = upcoming[0];
    safeText('catalystTitle', nextCatalyst.title);
    safeText('catalystImpact', nextCatalyst.impact);
    safeText('catalystCcy', nextCatalyst.country);
    const d = new Date(nextCatalyst.ts);
    // Tampilkan waktu WITA (UTC+8)
    const wita = new Date(nextCatalyst.ts + 8 * 3600000);
    safeText('catalystTime', `${String(wita.getUTCHours()).padStart(2,'0')}:${String(wita.getUTCMinutes()).padStart(2,'0')}`);

    // Estimasi Bias Makro sederhana
    let biasText = 'Menunggu Rilis';
    if (nextCatalyst.forecast && nextCatalyst.previous) {
      const f = parseFloat(nextCatalyst.forecast), p = parseFloat(nextCatalyst.previous);
      if (!isNaN(f) && !isNaN(p)) {
        if (nextCatalyst.country === 'USD') {
          biasText = f > p ? 'USD Menguat (Bearish Gold/EUR)' : 'USD Melemah (Bullish Gold/EUR)';
        } else {
          biasText = f > p ? `${nextCatalyst.country} Menguat` : `${nextCatalyst.country} Melemah`;
        }
      }
    }
    safeText('catalystBias', biasText);
  }
  renderCalendarList();
}

function renderCountdown() {
  if (!nextCatalyst) return;
  const now = Date.now();
  const diff = nextCatalyst.ts - now;
  if (diff <= 0) {
    safeText('countdownTimer', '00:00:00');
    safeText('shieldMetric', 'WASPADA (RILIS)');
    $('shieldMetric').style.color = 'var(--down)';
    updateNextCatalyst();
    return;
  }
  if (diff <= 15 * 60000) {
    safeText('shieldMetric', 'BLOCKED (±15m)');
    $('shieldMetric').style.color = 'var(--gold)';
  } else {
    safeText('shieldMetric', 'AMAN (CLEAR)');
    $('shieldMetric').style.color = 'var(--up)';
  }
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  safeText('countdownTimer', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
}

function renderCalendarList() {
  const now = Date.now();
  const list = (calendarEvents || [])
    .filter(e => e.ts >= now - 3600000 && (e.impact === 'High' || e.impact === 'Medium'))
    .slice(0, 15);

  if (!list.length) {
    safeHTML('calendarList', '<div style="color:var(--muted); font-size:11px; padding:10px;">Tidak ada agenda berita Medium/High dalam waktu dekat.</div>');
    return;
  }

  const html = list.map(ev => {
    const wita = new Date(ev.ts + 8 * 3600000);
    const timeStr = `${String(wita.getUTCHours()).padStart(2,'0')}:${String(wita.getUTCMinutes()).padStart(2,'0')}`;
    const impCls = ev.impact.toLowerCase();
    const passed = ev.ts < now;
    return `
      <div class="calEventRow" style="${passed ? 'opacity:0.6;' : ''}">
        <b style="color:#94a3b8;">${timeStr} WITA</b>
        <span class="calImpact ${impCls}">${ev.impact.toUpperCase()}</span>
        <div><b>${ev.title}</b> <small style="color:var(--muted)">(${ev.country})</small></div>
        <div style="font-family:monospace; font-size:10px;">F: ${ev.forecast || '—'} / P: ${ev.previous || '—'}</div>
        <div style="text-align:right; color:${passed ? 'var(--up)' : 'var(--gold)'}; font-size:10px;">${passed ? '✓ Dirilis' : 'Upcoming'}</div>
      </div>`;
  }).join('');
  safeHTML('calendarList', html);
}

/* ---------- Feed Streaming (WebSocket) ---------- */
function startDerivFeed() {
  const symbols = ALL_KEYS.map(k => PAIRS[k].deriv).filter(Boolean);
  const ws = openWS(DERIV_WS, me => {
    safeClass('derivDot', 'live');
    symbols.forEach(sym => me.send(JSON.stringify({ ticks: sym, subscribe: 1 })));
  }, msg => {
    if (msg.tick) {
      const sym = msg.tick.symbol;
      const pair = ALL_KEYS.find(k => PAIRS[k].deriv === sym);
      if (!pair) return;
      if (selectedFeed === 'binance' && PAIRS[pair].binance) return;
      const bid = msg.tick.bid || (msg.tick.quote - (PAIRS[pair].typSpread || 1) * PAIRS[pair].pip * 0.5);
      const ask = msg.tick.ask || (msg.tick.quote + (PAIRS[pair].typSpread || 1) * PAIRS[pair].pip * 0.5);
      quotes[pair] = { bid, ask, last: (bid + ask) / 2, ts: Date.now() };
      if (engines[pair]) engines[pair].onTick(Date.now(), bid, ask);
    }
  }, 'deriv');
  return ws;
}

function startBinanceFeed() {
  const cryptoPairs = ALL_KEYS.filter(k => PAIRS[k].binance);
  const streams = cryptoPairs.map(k => PAIRS[k].binance + '@bookTicker').join('/');
  const url = BINANCE_WS_HOSTS[0] + '/stream?streams=' + streams;

  const ws = openWS(url, () => {
    safeClass('binanceDot', 'live');
  }, msg => {
    const d = msg.data;
    if (!d || !d.s) return;
    const sym = d.s.toLowerCase();
    const pair = cryptoPairs.find(k => PAIRS[k].binance === sym);
    if (!pair) return;
    const bid = parseFloat(d.b), ask = parseFloat(d.a);
    if (!(bid > 0 && ask > 0)) return;
    quotes[pair] = { bid, ask, last: (bid + ask) / 2, ts: Date.now() };
    if (engines[pair]) engines[pair].onTick(Date.now(), bid, ask);
  }, 'binance');
  return ws;
}

/* ---------- Manajemen Lot & Posisi ---------- */
function lotFor(plan) {
  const c = PAIRS[plan.pair] || PAIRS.EURUSD;
  const bal = N(settings.balance), riskUsd = bal * N(settings.riskPct) / 100;
  const pipv = (c.units || 100000) * c.pip / (c.quoteUSD ? 1 : plan.entry);
  const slPips = plan.slDist / c.pip;
  let lot = Math.floor(riskUsd / (slPips * pipv) * 100) / 100;
  if (!(lot >= 0.01)) lot = 0.01;
  return { lot, riskUsd: lot * slPips * pipv, slPips, c };
}

/* ---------- Evaluasi & Render Dashboard ---------- */
function evaluateAll() {
  const now = Date.now();
  const alertCards = [];
  const matrixRows = [];

  ALL_KEYS.forEach(pair => {
    const eng = engines[pair];
    if (!eng) return;
    const q = quotes[pair] || {};
    const c = PAIRS[pair];
    const dp = c.dp;

    // Evaluasi sinyal engine
    const ev = eng.evaluate(now);
    const buy = ev.side === 'UP';
    const lbl = buy ? 'BUY' : 'SELL';

    // Bersihkan zombie plan lama
    let stored = plans[pair];
    if (stored) {
      const isZombie = !stored.done && (now >= stored.expires || (stored.t && now - stored.t > stored.expires) || (q.last > 0 && stored.entry > 0 && Math.abs(q.last - stored.entry) / stored.entry > 0.04));
      if (isZombie) {
        if (eng) eng.abandon(stored.id);
        delete plans[pair];
        stored = null;
      }
    }

    if (ev.fired && ev.trade) {
      plans[pair] = ev.trade;
      stored = ev.trade;
      persistTrade(ev.trade);
    }

    const locked = !!(stored && !stored.done);
    const preview = (!locked && ev.side && ev.side !== 'WAIT' && eng) ? eng.preview(ev.side) : null;
    const plan = locked ? stored : preview;
    const stage = locked ? 'ENTRY' : (ev.confirming ? 'SETUP' : (ev.stage || 'WATCH'));

    // Status chip badge dari pair_stats
    const modeStats = pairStats && pairStats.pairs && pairStats.pairs[pair] && pairStats.pairs[pair].modes && pairStats.pairs[pair].modes[selectedMode];
    let chipHtml = '<span class="statChip none">—</span>';
    if (modeStats && modeStats.n) {
      const pf = modeStats.pf || 0;
      const wr = (modeStats.winRate * 100).toFixed(1) + '%';
      const isGood = modeStats.avgR > 0 && pf >= 1.2;
      const cls = isGood ? 'good' : (modeStats.avgR > 0 || pf >= 1 ? 'marginal' : 'bad');
      const txt = isGood ? 'BAGUS' : (modeStats.avgR > 0 ? 'MARGINAL' : 'JELEK');
      chipHtml = `<span class="statChip ${cls}">${txt} · WR ${wr} · PF ${pf.toFixed(2)}</span>`;
    }

    // Bangun Card Sinyal
    if (plan && (locked || ev.confirming || ev.stage === 'ENTRY')) {
      const L = lotFor(plan);
      const f = v => Number(v).toFixed(dp);
      alertCards.push(`
        <article class="alertCard ${stage.toLowerCase()}">
          <header>
            <div><strong>${c.name}</strong> <em>${c.nick}</em></div>
            <div class="alertSide ${buy ? 'upText' : 'downText'}">${locked ? '🔒 ' : ''}${lbl}</div>
          </header>
          <div class="alertMeta">
            <span class="pill ${stage.toLowerCase()}">${stage}</span>
            <span>skor ${sgn(ev.score)}</span>
            <span>mid ${q.last ? q.last.toFixed(dp) : '—'}</span>
          </div>
          <div>${chipHtml}</div>
          <div class="cdBar ${locked ? 'ok' : ''}">
            <i style="width: ${locked ? 100 : Math.round((ev.prog / Math.max(1, ev.persistMs)) * 100)}%"></i>
          </div>
          <p class="alertReason">${ev.blocked || ev.reason || 'Sinyal terkonfirmasi lolos threshold'}</p>
          <div class="alertLevels">
            <div><span>ENTRY</span><b>${f(plan.entry)}</b></div>
            <div><span>SL</span><b style="color:var(--down)">${f(plan.sl)}</b></div>
            <div><span>TP1 (50%)</span><b style="color:var(--up)">${f(plan.tp1)}</b></div>
            <div><span>TP2</span><b style="color:var(--up)">${f(plan.tp2)}</b></div>
            <div><span>LOT</span><b>${L.lot.toFixed(2)}</b></div>
            <div><span>RISK</span><b>$${L.riskUsd.toFixed(2)}</b></div>
          </div>
          <div class="alertPlanNote">
            ${locked ? `🔒 ORDER VALID TERKUNCI — <b>${lbl} @ ${f(plan.entry)}</b>, SL ${f(plan.sl)}, TP1 ${f(plan.tp1)}, TP2 ${f(plan.tp2)}. Tutup 50% di TP1 lalu BE, sisanya tahan ke TP2.` : `≈ PREVIEW ORDER — Konfirmasi ${Math.round((ev.prog / Math.max(1, ev.persistMs)) * 100)}%. Menunggu 100% untuk mengunci order.`}
          </div>
          <button class="copyOne" onclick="copyOrder('${pair}')">📋 SALIN ORDER PLAN</button>
        </article>
      `);
    }

    // Bangun Matrix Row Table
    const age = q.ts ? Math.round((now - q.ts) / 1000) + 's' : '—';
    const hb = ev.hard ? `🚫 ${ev.hard}` : (ev.blocked ? `⏳ ${ev.blocked}` : '✓ Lolos filter');
    matrixRows.push(`
      <div class="scanRow ${locked ? 'active' : ''}">
        <div><b>${c.name}</b> <small style="color:var(--muted)">${c.nick}</small></div>
        <div><span class="pill ${stage.toLowerCase()}">${stage}</span></div>
        <div class="${ev.side === 'WAIT' ? '' : (buy ? 'upText' : 'downText')}">${ev.side === 'WAIT' ? '—' : (locked ? '🔒 ' + lbl : lbl)}</div>
        <div>${sgn(ev.score)}</div>
        <div style="font-family:monospace; font-weight:700;">${q.last ? q.last.toFixed(dp) : '—'}</div>
        <div style="color:var(--muted)">${age}</div>
        <div style="font-size:10px; color:${ev.hard ? 'var(--down)' : (ev.blocked ? 'var(--gold)' : 'var(--up)')};">${hb}</div>
      </div>
    `);
  });

  safeHTML('alertBoard', alertCards.length ? alertCards.join('') : '<div style="color:var(--muted); padding:20px; font-size:12px;">Belum ada order yang mencapai tahap SETUP / ENTRY saat ini. Scanner memindai terus di latar belakang…</div>');
  safeHTML('scanRows', matrixRows.join(''));
  safeText('activePlanCount', `${alertCards.length} Sinyal Lolos`);
}

/* ---------- Salin Order ---------- */
window.copyOrder = function(pair) {
  const p = plans[pair] || (engines[pair] && engines[pair].preview(signalStates[pair].side));
  if (!p) return;
  const c = PAIRS[pair] || PAIRS.EURUSD;
  const f = v => Number(v).toFixed(c.dp);
  const L = lotFor(p);
  const txt = `[SNIPERNEWS HYBRID ORDER]\nPair: ${c.name}\nOrder: ${p.order}\nEntry: ${f(p.entry)}\nSL: ${f(p.sl)} (${L.slPips.toFixed(1)} pips)\nTP1: ${f(p.tp1)}\nTP2: ${f(p.tp2)}\nLot: ${L.lot.toFixed(2)} (Risiko $${L.riskUsd.toFixed(2)})\nAturan: Tutup 50% di TP1 lalu geser SL ke Entry (BE), sisa tahan ke TP2.`;
  navigator.clipboard.writeText(txt).then(() => alert('Order berhasil disalin ke clipboard!\n\n' + txt)).catch(() => {});
};

/* ---------- Jurnal Eksekusi & Riwayat ---------- */
function persistTrade(tr) {
  storedEntries.push({ id: tr.id, pair: tr.pair, side: tr.side, order: tr.order, entry: tr.entry, sl: tr.sl, tp1: tr.tp1, tp2: tr.tp2, t: Date.now() });
  saveAll();
  updateJournalUI();
}

function saveAll() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ entries: storedEntries.slice(-100), plans }));
  } catch {}
}

function loadAll() {
  try {
    const z = JSON.parse(localStorage.getItem(STORE) || '{}');
    storedEntries = Array.isArray(z.entries) ? z.entries : [];
    if (z.plans && typeof z.plans === 'object') {
      const now = Date.now();
      for (const k of Object.keys(z.plans)) {
        const p = z.plans[k];
        if (p && !p.done && now < p.expires) plans[k] = p;
      }
    }
  } catch {}
  updateJournalUI();
}

function updateJournalUI() {
  const finished = storedEntries.filter(e => typeof e.resultR === 'number');
  const S = E.summarize(finished.map(e => ({ resultR: e.resultR })));
  safeText('statTotal', String(storedEntries.length));
  safeText('statWinRate', S.n ? (S.winRate * 100).toFixed(1) + '%' : '—');
  safeText('statTotalR', S.n ? fmtR(S.totalR) : '—');
  safeText('statPF', S.n ? (S.pf ? S.pf.toFixed(2) : '—') : '—');
  safeText('statAvgR', S.n ? fmtR(S.avgR) : '—');
  safeText('statDD', S.n ? '-' + S.maxDD.toFixed(1) + 'R' : '—');

  if (storedEntries.length) {
    const list = storedEntries.slice(-10).reverse().map(e => `
      <div class="historyRow">
        <b>${e.pair} ${e.order}</b>
        <span>@ ${e.entry}</span>
        <span style="color:${e.resultR > 0 ? 'var(--up)' : (e.resultR < 0 ? 'var(--down)' : 'var(--gold)')};">${typeof e.resultR === 'number' ? fmtR(e.resultR) : 'BERJALAN'}</span>
      </div>
    `).join('');
    safeHTML('historyList', list);
  }
}

/* ---------- Start Up ---------- */
window.addEventListener('DOMContentLoaded', () => {
  loadAll();
  initEngines();
  setupProviders();
  loadMacroContext();

  startDerivFeed();
  startBinanceFeed();

  // Evaluasi berkala
  setInterval(evaluateAll, 1000);
  setInterval(renderCountdown, 1000);
  setInterval(loadMacroContext, 180000); // refresh berita tiap 3 menit

  $('modeSelect').addEventListener('change', e => {
    selectedMode = e.target.value;
    initEngines();
  });

  $('clearJournalBtn').addEventListener('click', () => {
    if (confirm('Bersihkan riwayat jurnal eksekusi di browser ini?')) {
      storedEntries = [];
      saveAll();
      updateJournalUI();
    }
  });

  $('refreshBtn').addEventListener('click', () => {
    loadMacroContext();
    evaluateAll();
  });
});

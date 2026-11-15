/* ============================================================
   SNIPERNEWS INTELLIGENCE — HYBRID ENGINE CONTROLLER v1
   Menggabungkan Radar Makro & Berita dengan Scanner Teknikal Sniper 14 Pair.
   ============================================================ */
console.log('[app] SniperNews Hybrid Controller starting…');

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
const BINANCE_REST_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

let selectedFeed = 'hybrid';
let selectedMode = 'balanced';
let calendarEvents = [];
let sentimentData = null;
let pairStats = null;
let nextCatalyst = null;
let stopFeed = null;
let restPollTimer = null;
let feedWatchTimer = null;

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
  let ws = null, delay = 500, dead = false, timer = null;
  const retry = () => { if (dead) return; timer = setTimeout(go, delay); delay = Math.min(15000, delay * 2); };
  const go = () => {
    if (dead) return;
    try {
      const me = new WebSocket(url);
      ws = me;
      me.onopen = () => { if (dead || ws !== me) return; console.log(`[${label}] connected`); onOpen && onOpen(me); };
      me.onmessage = e => { if (dead || ws !== me) return; delay = 500; try { onMsg(JSON.parse(e.data)); } catch (err) {} };
      me.onerror = () => {};
      me.onclose = ev => { if (dead || ws !== me) return; retry(); };
    } catch { retry(); }
  };
  go();
  return () => { dead = true; clearTimeout(timer); if (ws) try { ws.close(); } catch {} };
}

/* ---------- Ingest per Pair ---------- */
function ingestPair(pair, bid, ask, now) {
  if (!(bid > 0 && ask > 0 && ask >= bid) || !PAIRS[pair]) return;
  const mid = (bid + ask) / 2;
  quotes[pair] = { bid, ask, last: mid, ts: now };
  lockIngestTick(pair, mid, now); // Signal Lock Engine: candle M15 dari tick mid
  const eng = engines[pair];
  if (eng) {
    eng.onTick(now, bid, ask);
  }
}

/* ============================================================
   SIGNAL LOCK ENGINE (lock.js) — gerbang akhir M15 candle-close.
   Candle M15 dibangun dari tick mid (Binance/Deriv); event
   LOCKED / TP1 / CLOSED dibaca panel lock & jurnal di bawah.
   ============================================================ */
const LOCK = window.SnapLock || null;
const LOCK_TF_MS = 15 * 60 * 1000;
const lockCandles = {}; // pair -> {bars:[closed], cur:{time,open,high,low,close,vol}}
const lockPlans = {};   // pair -> plan terkunci aktif
const lastEval = {};    // pair -> hasil evaluate() terakhir (skor & arah utk lock)

function lockIngestTick(pair, mid, now) {
  if (!LOCK || !(mid > 0)) return;
  const st = lockCandles[pair] || (lockCandles[pair] = { bars: [], cur: null });
  const k = Math.floor(now / LOCK_TF_MS);
  if (!st.cur || st.cur.k !== k) {
    const prev = st.cur;
    st.cur = { k, time: k * LOCK_TF_MS, open: mid, high: mid, low: mid, close: mid, vol: 0 };
    if (prev && [prev.open, prev.high, prev.low, prev.close].every(Number.isFinite)) {
      st.bars.push(prev);
      if (st.bars.length > 240) st.bars.shift();
      try { onLockCandleClose(pair, prev); } catch (e) { console.warn('[lock]', pair, e); }
    }
  }
  const c = st.cur;
  if (mid > c.high) c.high = mid;
  if (mid < c.low) c.low = mid;
  c.close = mid;
  c.vol++; // proxy volume: jumlah tick per candle M15 (relatif antar candle)
}

function lockIndicators(pair, bars) {
  const n = bars.length;
  if (n < 15) return null; // butuh 14 bar utk ATR + 20 bar utk RVOL
  let tr = 0;
  for (let i = n - 14; i < n; i++) {
    const b = bars[i], pc = bars[i - 1].close;
    tr += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  const atr = tr / 14;
  let vSum = 0, vN = 0;
  for (let i = Math.max(0, n - 21); i < n - 1; i++) { vSum += bars[i].vol; vN++; }
  const rvol = vN && vSum > 0 ? bars[n - 1].vol / (vSum / vN) : 0;
  const q = quotes[pair], P = PAIRS[pair];
  const spreadPips = q && P && P.pip > 0 ? (q.ask - q.bid) / P.pip : Infinity;
  return { atr, rvol, spreadOK: !!P && spreadPips <= P.maxSpread };
}

function lockMacroCtx(pair) {
  const now = Date.now();
  const currs = [pair.slice(0, 3), pair.slice(3, 6)];
  if (pair === 'XAUUSD') currs.push('USD', 'XAU');
  if (pair === 'BTCUSD' || pair === 'ETHUSD') currs.push('USD');
  let newsImpact = null, newsMinutesAway = null;
  for (const ev of calendarEvents) {
    if (ev.impact !== 'High' || !currs.includes(ev.country)) continue;
    const min = (ev.ts - now) / 60000;
    if (newsMinutesAway === null || Math.abs(min) < Math.abs(newsMinutesAway)) {
      newsMinutesAway = min; newsImpact = 'High';
    }
  }
  const fng = sentimentData && sentimentData.fng ? Number(sentimentData.fng.value) : null;
  return { fng: Number.isFinite(fng) ? fng : null, newsImpact, newsMinutesAway, dxyTrend: null };
}

function onLockCandleClose(pair, candle) {
  if (!LOCK || !lastEval[pair]) return;
  const ev = lastEval[pair];
  const dir = ev.side === 'UP' ? 'BUY' : ev.side === 'DOWN' ? 'SELL' : null;
  if (!dir) return; // engine belum punya arah — jangan buat kandidat
  const ind = lockIndicators(pair, lockCandles[pair].bars) || { atr: 0, rvol: 0, spreadOK: false };
  const score = Number.isFinite(ev.confidence) ? ev.confidence : NaN;
  const res = LOCK.onCandleClose(pair, candle, ind, score, dir, lockMacroCtx(pair));
  handleLockEvent(res);
}

function handleLockEvent(res) {
  if (!res || !res.signal) {
    if (res && res.why) console.log('[lock]', res.event, res.why);
    return;
  }
  const s = res.signal;
  if (res.event === 'LOCKED') {
    lockPlans[s.sym] = s;
    if (!storedEntries.some(e => e.id === s.id)) {
      storedEntries.push({ id: s.id, pair: s.sym, side: s.dir === 'BUY' ? 'UP' : 'DOWN',
        order: s.dir, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, t: s.lockedAt, locked: true });
      saveAll();
      updateJournalUI();
    }
  } else if (res.event === 'TP1') {
    lockPlans[s.sym] = s; // SL sudah digeser ke entry (BE) oleh lock.js
  } else if (res.event === 'CLOSED') {
    const e = storedEntries.find(x => x.id === s.id);
    if (e) {
      e.resultR = s.resultR;
      e.status = s.status;
      e.closedAt = s.closedAt;
      saveAll();
      updateJournalUI();
    }
    delete lockPlans[s.sym];
  }
}

function updateLockUI() {
  if (!LOCK || !$('lockRows')) return;
  const plans = LOCK.allLocked();
  const rows = plans.length ? plans.map(s => {
    const c = PAIRS[s.sym] || { name: s.sym, nick: '', dp: 2 };
    const f = v => Number(v).toFixed(c.dp);
    const age = Math.max(0, Math.round((Date.now() - s.lockedAt) / 60000)) + 'm';
    const st = s.status === 'TP1_HIT' ? 'TP1 ✓ (BE)' : '🔒 LOCKED';
    const buy = s.dir === 'BUY';
    return `<div class="scanRow ${s.status === 'TP1_HIT' ? 'active' : ''}">
      <div><b>${c.name}</b> <small style="color:var(--muted)">${c.nick}</small></div>
      <div>${st}</div>
      <div class="${buy ? 'upText' : 'downText'}">${s.dir}</div>
      <div style="font-family:monospace">${f(s.entry)}</div>
      <div style="font-family:monospace;color:var(--down)">${f(s.sl)}</div>
      <div style="font-family:monospace;color:var(--up)">${f(s.tp1)} / ${f(s.tp2)}</div>
      <div style="color:var(--muted)">${age}</div>
    </div>`;
  }).join('') : '<div style="color:var(--muted); padding:10px 14px; font-size:11px;">Belum ada sinyal terkunci. Engine menunggu 2 candle M15 close berturut-turut searah + lolos filter kualitas (spike, RVOL, spread, makro).</div>';
  safeHTML('lockRows', rows);
  safeText('lockCount', `${plans.length} Terkunci · ${LOCK.allCandidates().filter(c => c.count > 0).length} Konfirmasi`);
}

function needBars(pair) {
  const p = engines[pair] ? engines[pair].params() : E.PARAMS;
  return Math.min(1000, Math.max(320, (Math.max(p.MIN_BARS || 12, 62)) * (p.BAR_MIN || 1)));
}

function seedEng(eng, bars) {
  try {
    if (eng && typeof eng.seedBars === 'function') {
      eng.seedBars(bars);
    }
  } catch (e) { console.warn('seed', e); }
}

/* ---------- Prefill Binance Bars ---------- */
async function prefillBinancePair(pair, sym) {
  if (!sym) return;
  const limit = needBars(pair);
  for (const h of BINANCE_REST_HOSTS) {
    try {
      const r = await fetch(h + '/api/v3/klines?symbol=' + sym.toUpperCase() + '&interval=1m&limit=' + limit, { cache: 'no-store' });
      if (!r.ok) continue;
      const rows = await r.json();
      const bars = rows.map(k => ({ k: Math.floor(k[0] / 60000), o: N(k[1]), h: N(k[2]), l: N(k[3]), c: N(k[4]) }));
      seedEng(engines[pair], bars);
      return;
    } catch {}
  }
}

/* ---------- Binance Streaming ---------- */
function startBinanceMulti(keys) {
  const syms = keys.map(k => PAIRS[k].binance).filter(Boolean);
  if (!syms.length) return () => {};
  let stopWs = null, dead = false;
  const streams = syms.map(s => s + '@bookTicker/' + s + '@trade').join('/');
  const symToPair = {};
  keys.forEach(k => { if (PAIRS[k].binance) symToPair[PAIRS[k].binance] = k; });

  const connect = () => {
    if (dead) return;
    if (stopWs) { try { stopWs(); } catch {} stopWs = null; }
    const host = BINANCE_WS_HOSTS[0];
    const url = host + '/stream?streams=' + streams;
    stopWs = openWS(url, () => {
      safeClass('binanceDot', 'live');
    }, msg => {
      const stream = String(msg.stream || ''), d = msg.data || msg, now = Date.now();
      const m = stream.match(/^([a-z0-9]+)@/);
      const sym = m ? m[1] : String(d.s || '').toLowerCase();
      const pair = symToPair[sym];
      if (!pair) return;
      if (stream.endsWith('@bookTicker') || (d.b && d.a && d.e === undefined)) {
        ingestPair(pair, N(d.b), N(d.a), now);
        return;
      }
      if (stream.endsWith('@trade') || d.e === 'trade') {
        const q = N(d.q);
        if (engines[pair] && q > 0) engines[pair].addFlow(now, (d.m ? -1 : 1) * q);
      }
    }, 'binance-multi');
  };
  connect();

  const poll = async () => {
    if (dead) return;
    try {
      const h = BINANCE_REST_HOSTS[0];
      await Promise.all(syms.map(async sym => {
        try {
          const r = await fetch(h + '/api/v3/ticker/bookTicker?symbol=' + sym.toUpperCase(), { cache: 'no-store' });
          if (!r.ok) return;
          const d = await r.json(), pair = symToPair[sym], q = quotes[pair];
          if (!pair) return;
          if (!q || Date.now() - q.ts > 2000) {
            ingestPair(pair, N(d.bidPrice), N(d.askPrice), Date.now());
          }
        } catch {}
      }));
    } catch {}
  };
  restPollTimer = setInterval(poll, 2000);
  poll();
  syms.forEach(sym => prefillBinancePair(symToPair[sym], sym));

  return () => {
    dead = true;
    if (restPollTimer) clearInterval(restPollTimer);
    if (stopWs) try { stopWs(); } catch {}
  };
}

/* ---------- Deriv Streaming ---------- */
function startDerivMulti(keys) {
  let pingTimer = null, dead = false;
  const stopWs = openWS(DERIV_WS, ws => {
    safeClass('derivDot', 'live');
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ ping: 1 })); } catch {} }, 15000);
    keys.forEach(k => {
      const sym = PAIRS[k].deriv;
      if (!sym) return;
      ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
      ws.send(JSON.stringify({ ticks_history: sym, adjust_start_time: 1, count: needBars(k), end: 'latest', granularity: 60, style: 'candles' }));
    });
  }, msg => {
    if (msg.candles && msg.echo_req) {
      const sym = msg.echo_req.ticks_history || msg.echo_req.ticks;
      const pair = keys.find(k => PAIRS[k].deriv === sym);
      if (pair) {
        const bars = (msg.candles || []).map(c => ({ k: Math.floor(N(c.epoch) / 60), o: N(c.open), h: N(c.high), l: N(c.low), c: N(c.close) }));
        seedEng(engines[pair], bars);
      }
      return;
    }
    const t = msg.tick;
    if (!t) return;
    const pair = keys.find(k => PAIRS[k].deriv === (t.symbol || ''));
    if (!pair) return;
    let bid = N(t.bid), ask = N(t.ask), q = N(t.quote);
    const now = t.epoch ? N(t.epoch) * 1000 : Date.now();
    if (!(bid > 0 && ask > 0)) {
      if (!(q > 0)) return;
      const half = PAIRS[pair].pip * 0.4;
      bid = q - half; ask = q + half;
    }
    ingestPair(pair, bid, ask, now);
  }, 'deriv-multi');

  return () => {
    dead = true;
    if (pingTimer) clearInterval(pingTimer);
    try { stopWs(); } catch {}
  };
}

function startFeed() {
  if (stopFeed) { try { stopFeed(); } catch {} stopFeed = null; }
  buildEngines(ALL_KEYS);

  if (selectedFeed === 'hybrid') {
    const binKeys = ALL_KEYS.filter(k => !!PAIRS[k].binance);
    const derivKeys = ALL_KEYS.filter(k => !PAIRS[k].binance);
    const stopB = startBinanceMulti(binKeys);
    const stopD = startDerivMulti(derivKeys);
    stopFeed = () => { try { stopB(); } catch {} try { stopD(); } catch {} };
  } else if (selectedFeed === 'deriv') {
    stopFeed = startDerivMulti(ALL_KEYS);
  } else if (selectedFeed === 'binance') {
    const binKeys = ALL_KEYS.filter(k => !!PAIRS[k].binance);
    stopFeed = startBinanceMulti(binKeys);
  }
}

function buildEngines(keys) {
  const now = Date.now(), today = Math.floor(now / 86400000);
  keys.forEach(pair => {
    const hasFlow = (selectedFeed === 'binance' || selectedFeed === 'hybrid') && !!PAIRS[pair].binance;
    const eng = E.create(pair, { mode: selectedMode, stale: 20000, hasFlow, feed: selectedFeed });
    engines[pair] = eng;
    if (!signalStates[pair]) {
      signalStates[pair] = { stage: 'WAIT', side: 'WAIT', confidence: 0, generatedAt: 0, reason: 'Warming…', confirming: false };
    }
  });
}

/* ---------- Setup Hook Berita & Sentimen ---------- */
function setupProviders() {
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
      const diff = ev.ts - now;
      if (diff >= -15 * 60000 && diff <= 0) {
        return { phase: 'post', impact: ev.impact === 'High' ? 3 : 2, event: ev.title };
      }
      if (diff > 0 && diff <= 15 * 60000) {
        return { phase: 'pre', impact: ev.impact === 'High' ? 3 : 2, event: ev.title };
      }
    }
    return null;
  });

  E.setSentimentProvider((pairKey, now) => {
    if (!sentimentData) return null;
    const isCrypto = PAIRS[pairKey] && PAIRS[pairKey].kind === 'crypto';
    const isGold = pairKey === 'XAUUSD';
    let pairBias = 0;
    if (isCrypto && sentimentData.fng) {
      pairBias = sentimentData.fng.score || 0;
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
    if (cRes.ok) {
      const cRaw = await cRes.json();
      const rawList = Array.isArray(cRaw) ? cRaw : (cRaw.events || []);
      calendarEvents = rawList.map(e => ({
        ts: e.ts || Date.parse(e.date || e.Date),
        title: e.title || e.Event,
        country: e.country || e.Country,
        impact: e.impact || (e.Importance >= 3 ? 'High' : (e.Importance === 2 ? 'Medium' : 'Low')),
        forecast: e.forecast || e.Forecast || '',
        previous: e.previous || e.Previous || '',
        actual: e.actual || e.Actual || ''
      })).filter(e => e.ts && e.title);
      console.log('[macro] Calendar loaded:', calendarEvents.length, 'events');
    }
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
  const upcomingHighMed = calendarEvents
    .filter(e => e.ts > now && (e.impact === 'High' || e.impact === 'Medium'))
    .sort((a, b) => a.ts - b.ts);
  const upcomingAll = calendarEvents
    .filter(e => e.ts > now)
    .sort((a, b) => a.ts - b.ts);

  nextCatalyst = upcomingHighMed[0] || upcomingAll[0] || null;

  if (nextCatalyst) {
    safeText('catalystTitle', nextCatalyst.title);
    safeText('catalystImpact', nextCatalyst.impact);
    safeText('catalystCcy', nextCatalyst.country);
    const wita = new Date(nextCatalyst.ts + 8 * 3600000);
    const dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
    const dayStr = dayNames[wita.getUTCDay()];
    safeText('catalystTime', `${dayStr}, ${String(wita.getUTCHours()).padStart(2,'0')}:${String(wita.getUTCMinutes()).padStart(2,'0')}`);

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
  renderCountdown();
  renderCalendarList();
}

function renderCountdown() {
  if (!nextCatalyst) return;
  const now = Date.now();
  const diff = nextCatalyst.ts - now;
  if (diff <= 0) {
    safeText('countdownTimer', '00:00:00');
    safeText('shieldMetric', 'WASPADA (RILIS)');
    if ($('shieldMetric')) $('shieldMetric').style.color = 'var(--down)';
    updateNextCatalyst();
    return;
  }
  if (diff <= 15 * 60000) {
    safeText('shieldMetric', 'BLOCKED (±15m)');
    if ($('shieldMetric')) $('shieldMetric').style.color = 'var(--gold)';
  } else {
    safeText('shieldMetric', 'AMAN (CLEAR)');
    if ($('shieldMetric')) $('shieldMetric').style.color = 'var(--up)';
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

    const ev = eng.evaluate(now);
    lastEval[pair] = ev; // dipakai Signal Lock Engine saat candle M15 close
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
  updateLockUI();
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

/* ---------- Start Up (Boot Safe) ---------- */
function boot() {
  console.log('[app] Booting SniperNews Engine & Feeds…');
  loadAll();
  setupProviders();
  loadMacroContext();
  startFeed();

  // Evaluasi berkala
  evaluateAll();
  renderCountdown();
  setInterval(evaluateAll, 1000);
  setInterval(renderCountdown, 1000);
  setInterval(loadMacroContext, 180000);

  if ($('modeSelect')) {
    $('modeSelect').addEventListener('change', e => {
      selectedMode = e.target.value;
      buildEngines(ALL_KEYS);
      evaluateAll();
    });
  }

  if ($('feedSelect')) {
    $('feedSelect').addEventListener('change', e => {
      selectedFeed = e.target.value;
      startFeed();
    });
  }

  if ($('clearJournalBtn')) {
    $('clearJournalBtn').addEventListener('click', () => {
      if (confirm('Bersihkan riwayat jurnal eksekusi di browser ini?')) {
        storedEntries = [];
        saveAll();
        updateJournalUI();
      }
    });
  }

  if ($('refreshBtn')) {
    $('refreshBtn').addEventListener('click', () => {
      loadMacroContext();
      evaluateAll();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

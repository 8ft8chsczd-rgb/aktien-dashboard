import * as store from './store.js';
import * as fmt from './format.js';
import { marketStatus, nyTime } from './market.js';
import {
  positionValue,
  stopDistancePct,
  dedupeHistory,
  findPriceGap,
  projectedStop,
  stopHasTrailed,
} from './portfolio.js';
import { loadBotData } from './github.js';
import { fetchQuote, fetchProfile, TradeStream } from './live.js';
import { loadSeries, cachedSeries, pruneSeriesCache } from './history.js';
import { LineChart } from './chart.js';

const SETTINGS_KEY = 'depot.settings.v1';
const PROFILES_KEY = 'depot.profiles.v1';
const TICKS_KEY = 'depot.ticks.v1';
const DEFAULT_SETTINGS = {
  githubToken: '',
  finnhubKey: '',
  twelveKey: '',
  repo: '8ft8chsczd-rgb/Aktien',
  branch: 'claude/sp500-rsi-trading-bot-qpt6pz',
  setupDone: false,
};

const MINUTE = 60_000;
const DAY = 24 * 3600_000;

const RANGES = [
  { id: '1T', label: '1T' },
  { id: '1W', label: '1W' },
  { id: '1M', label: '1M' },
  { id: '1J', label: '1J' },
  { id: 'MAX', label: 'Max' },
];
const RANGE_LABELS = { '1W': '1 Woche', '1M': '1 Monat', '1J': '1 Jahr', MAX: 'Seit Start' };
const RANGE_DAYS = { '1W': 7, '1M': 31, '1J': 366 };

const INDICATORS = [
  ['macd', 'MACD', 'Dreht der Trend?'],
  ['bbands', 'Bollinger %B', 'Wie extrem liegt der Kurs im Band?'],
  ['stochastic', 'Stochastik', 'Zweite Überkauft-/Überverkauft-Prüfung'],
  ['volume_obv', 'Volumen & OBV', 'Steckt echtes Handelsinteresse dahinter?'],
  ['atr_filter', 'ATR-Filter', 'Schwankt die Aktie nicht zu wild?'],
  ['trend_filter', 'Trend SMA 50/200', 'Nicht gegen den großen Trend handeln'],
];

const EXIT_REASONS = {
  stop_loss: 'Stop-Loss',
  trailing_stop: 'Trailing Stop',
  rsi_reverted: 'RSI bei 50',
  max_holding_days: 'Zeitlimit',
  corporate_action: 'Kapitalmaßnahme',
};

const ICONS = {
  settings:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path d="M4 7h9M19 7h1M4 17h2M12 17h8"/><circle cx="16" cy="7" r="2.5"/><circle cx="9" cy="17" r="2.5"/></g></svg>',
  back:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// --- State -----------------------------------------------------------------

function loadSettings() {
  const saved = store.load(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
}

function loadTicks() {
  const saved = store.load(TICKS_KEY, null);
  return saved && saved.date && saved.series ? saved : { date: null, series: {} };
}

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('aktie/')) {
    const symbol = decodeURIComponent(hash.slice(6)).toUpperCase().replace(/[^A-Z0-9.-]/g, '');
    if (symbol) return { view: 'detail', symbol };
  }
  if (hash === 'einstellungen') return { view: 'settings' };
  return { view: 'home' };
}

const savedRange = store.load('depot.ui.range', '1T');

const state = {
  settings: loadSettings(),
  bot: null,
  botError: null,
  botLoading: false,
  quotes: {},
  quoteError: null,
  profiles: store.load(PROFILES_KEY, {}) || {},
  stream: { status: 'off', error: null },
  ticks: loadTicks(),
  series: {},
  seriesAt: {},
  seriesError: null,
  market: marketStatus(),
  route: parseRoute(),
  ui: {
    range: RANGES.some((r) => r.id === savedRange) ? savedRange : '1T',
    detailRange: '1T',
    perf: store.load('depot.ui.perf', 'total') === 'today' ? 'today' : 'total',
    scrub: null,
    forgetArmed: false,
    homeScroll: 0,
  },
};

const hasSetup = () => Boolean(state.settings.githubToken || state.settings.setupDone);

// --- Derived numbers ---------------------------------------------------------

function trackedSymbols() {
  const bot = state.bot;
  if (!bot) return [];
  const set = new Set(bot.portfolio.open_positions.map((p) => p.symbol));
  for (const c of bot.candidates || []) set.add(c.symbol);
  if (state.route.view === 'detail') set.add(state.route.symbol);
  return [...set];
}

function computeModel() {
  const bot = state.bot;
  if (!bot) return null;
  const { rules, portfolio: pf } = bot;
  const session = state.market.session;
  const leverage = rules.leverage;
  const positions = pf.open_positions.map((pos) => {
    const q = state.quotes[pos.symbol] || null;
    const price = q?.price ?? null;
    const value = price != null ? positionValue(pos, price, leverage) : null;
    // Bought at the close of the shown session or later: the day starts at its stake.
    const boughtAfter = pos.entry_date >= session.date;
    const dayBase = boughtAfter ? pos.size_eur : q?.prevClose ? positionValue(pos, q.prevClose, leverage) : null;
    return {
      pos,
      q,
      price,
      value,
      pnl: value != null ? value - pos.size_eur : null,
      pnlPct: value != null ? ((value - pos.size_eur) / pos.size_eur) * 100 : null,
      dayBase,
      dayPnl: value != null && dayBase != null ? value - dayBase : null,
      dayPct: value != null && dayBase ? ((value - dayBase) / dayBase) * 100 : null,
      stopDist: price != null ? stopDistancePct(pos, price) : null,
    };
  });
  const history = dedupeHistory(pf.equity_history);
  const botEquity = history.length ? history[history.length - 1].equity : pf.cash;
  const liveEquity = positions.every((p) => p.value != null)
    ? positions.reduce((sum, p) => sum + p.value, pf.cash)
    : null;
  const dayBaseEquity = positions.every((p) => p.dayBase != null)
    ? positions.reduce((sum, p) => sum + p.dayBase, pf.cash)
    : null;
  return {
    rules,
    pf,
    session,
    history,
    positions,
    botEquity,
    liveEquity,
    equityNow: liveEquity ?? botEquity,
    dayBaseEquity,
    startingCapital: pf.starting_capital ?? rules.startingCapital,
  };
}

function sessionLabel(session) {
  return session.date === state.market.today ? 'Heute' : fmt.dayWeekday(session.date);
}

// Intraday prices of one symbol for a session: Twelve Data 5-minute bars,
// continued by the trades streamed while the app was open.
function intradayPrices(symbol, session) {
  const bars = (state.series[`${symbol}:intraday`] || []).filter(([t]) => t > session.open && t <= session.close);
  const ticks = state.ticks.date === session.date ? state.ticks.series[symbol] || [] : [];
  const lastBar = bars.length ? bars[bars.length - 1][0] : -Infinity;
  return [...bars, ...ticks.filter(([t]) => t > lastBar)];
}

function depotIntraday(model) {
  const { session, rules } = model;
  const now = Date.now();
  const end = Math.min(now, session.close);
  const cash = model.pf.cash;
  const domain = [session.open, session.close];
  const label = sessionLabel(session);
  if (!model.positions.length) {
    return { points: [[session.open, cash], [Math.max(end, session.open + MINUTE), cash]], baseline: cash, domain, label };
  }
  const tracks = model.positions.map((p) => {
    const fixed = p.pos.entry_date >= session.date;
    const series = fixed ? [] : intradayPrices(p.pos.symbol, session);
    const start = p.q?.open || series[0]?.[1] || p.q?.prevClose || p.pos.entry_price;
    return { pos: p.pos, fixed, series, price: start, i: 0 };
  });
  const total = () =>
    tracks.reduce((sum, tr) => sum + (tr.fixed ? tr.pos.size_eur : positionValue(tr.pos, tr.price, rules.leverage)), cash);
  const points = [[session.open, total()]];
  const times = [...new Set(tracks.flatMap((tr) => tr.series.map(([t]) => t)))].sort((a, b) => a - b);
  for (const t of times) {
    for (const tr of tracks) {
      while (tr.i < tr.series.length && tr.series[tr.i][0] <= t) tr.price = tr.series[tr.i++][1];
    }
    points.push([t, total()]);
  }
  if (model.liveEquity != null) {
    const t = state.market.state === 'open' ? now : end;
    if (t > points[points.length - 1][0]) points.push([t, model.liveEquity]);
  }
  return { points, baseline: model.dayBaseEquity, domain, label };
}

function depotSeries(model, range) {
  if (range === '1T') return depotIntraday(model);
  const now = Date.now();
  const all = model.history.map((h) => [nyTime(h.date, 16, 0), h.equity]);
  if (model.liveEquity != null) {
    const t = state.market.state === 'open' ? now : Math.min(now, state.market.session.close);
    const lastT = all.length ? all[all.length - 1][0] : -Infinity;
    if (t > lastT + MINUTE) all.push([t, model.liveEquity]);
  }
  const from = range === 'MAX' ? -Infinity : now - RANGE_DAYS[range] * DAY;
  const inside = all.filter(([t]) => t >= from);
  const before = all.filter(([t]) => t < from).pop();
  const points = before ? [before, ...inside] : inside;
  const baseline = range === 'MAX' ? model.startingCapital : points[0]?.[1] ?? null;
  return { points, baseline, label: RANGE_LABELS[range], emptyText: 'Noch zu wenig Verlauf für diesen Zeitraum' };
}

function detailSeries(symbol, range, q, position) {
  const session = state.market.session;
  const now = Date.now();
  const live = q?.price != null && state.market.state === 'open' ? [now, q.price] : null;
  const stopName = stopLabel(state.bot.rules);
  const refLines = position
    ? [
        { value: position.entry_price, label: `Einstieg ${fmt.usd(position.entry_price)}`, tone: 'neutral' },
        { value: position.stop_loss_price, label: `${stopName} ${fmt.usd(position.stop_loss_price)}`, tone: 'neg' },
      ]
    : [];
  if (range === '1T') {
    let points = intradayPrices(symbol, session);
    if (q?.open && (!points.length || points[0][0] > session.open)) points = [[session.open, q.open], ...points];
    if (live) points.push(live);
    else if (q?.price != null && points.length < 2 && q.open) points = [[session.open, q.open], [Math.min(now, session.close), q.price]];
    return {
      points,
      baseline: q?.prevClose ?? null,
      domain: [session.open, session.close],
      refLines,
      label: sessionLabel(session),
      emptyText: state.settings.finnhubKey ? 'Warte auf Kurse …' : 'Für den Tagesverlauf fehlt der Finnhub-Schlüssel',
    };
  }
  const noKeyText = 'Kursverlauf braucht einen Twelve-Data-Schlüssel';
  if (range === '1W') {
    const points = [...(state.series[`${symbol}:week`] || [])];
    if (live) points.push(live);
    return {
      points,
      baseline: points[0]?.[1] ?? null,
      refLines,
      label: RANGE_LABELS[range],
      emptyText: state.settings.twelveKey ? 'Lade Kursverlauf …' : noKeyText,
    };
  }
  const daily = state.series[`${symbol}:daily`] || [];
  const from = range === 'MAX' ? -Infinity : now - RANGE_DAYS[range] * DAY;
  const points = daily.filter(([t]) => t >= from);
  if (live) points.push(live);
  return {
    points,
    baseline: points[0]?.[1] ?? null,
    refLines,
    label: range === 'MAX' ? (points.length ? `seit ${fmt.monthYear(points[0][0])}` : 'Max') : RANGE_LABELS[range],
    emptyText: state.settings.twelveKey ? 'Lade Kursverlauf …' : noKeyText,
  };
}

function priceGap(symbol) {
  const daily = state.series[`${symbol}:daily`];
  if (!daily || daily.length < 2) return null;
  const gap = findPriceGap(daily.slice(-90));
  return gap && Date.now() - gap.t < 120 * DAY ? gap : null;
}

// A price jump the bot itself flagged on a position, else one found in the
// cached daily prices.
function gapInfo(symbol, pos = null) {
  const flagged = pos?.corporate_action;
  if (flagged?.date) {
    return { t: nyTime(flagged.date, 16, 0), r: flagged.change_pct / 100, from: flagged.close_before, to: flagged.close_after, flagged: true };
  }
  return priceGap(symbol);
}

function stopLabel(rules) {
  return rules.trailingStopPct ? 'Trailing Stop' : 'Stop-Loss';
}

// --- Names and logos -------------------------------------------------------

function displayName(symbol) {
  const name = state.profiles[symbol]?.name;
  if (!name) return symbol;
  const short = name
    .replace(/[,.]?\s+(Inc|Incorporated|Corp|Corporation|Co|Company|Ltd|Limited|plc|PLC|Holdings?|Group|N\.?V|S\.?A|AG)\.?$/i, '')
    .replace(/[,.]?\s+(Inc|Corp|Co|Ltd|plc)\.?$/i, '')
    .trim();
  return short || name;
}

function initials(symbol) {
  return esc(symbol.replace(/[^A-Z]/g, '').slice(0, 2) || symbol.slice(0, 2));
}

function logo(symbol) {
  const url = state.profiles[symbol]?.logo;
  if (url && /^https:\/\//.test(url)) {
    return `<span class="logo"><img class="logo-img" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-initials="${initials(symbol)}"></span>`;
  }
  return `<span class="logo logo-text" aria-hidden="true">${initials(symbol)}</span>`;
}

// --- Live values (painted in place, many times per second) -------------------

function pillValue() {
  // An empty pill is hidden: without depot data there is nothing live to show.
  if (!state.bot) return { text: '', tone: 'off' };
  if (!state.settings.finnhubKey) return { text: 'Stand Bot', tone: 'off' };
  if (state.quoteError && /Schlüssel/.test(state.quoteError)) return { text: 'Live aus', tone: 'error' };
  const ms = state.market.state;
  if (ms === 'closed') return { text: 'Börse zu', tone: 'closed' };
  const { status } = state.stream;
  if (status === 'connected') {
    if (ms === 'open') return { text: 'Live', tone: 'live' };
    return { text: ms === 'pre' ? 'Vorbörse' : 'Nachbörse', tone: 'closed' };
  }
  if (status === 'connecting') return { text: 'Verbinde …', tone: 'connecting' };
  if (status === 'error') return { text: 'Live gestört', tone: 'error' };
  return { text: 'Börse zu', tone: 'closed' };
}

function withTone(change) {
  return { text: change.text, tone: change.dir, label: change.label };
}

function homeValues(model, depot, v) {
  const range = state.ui.range;
  const scrub = state.ui.scrub;
  const reference = depot.baseline ?? depot.points[0]?.[1] ?? null;
  let value;
  let abs = null;
  let base = null;
  let label = depot.label;
  if (scrub) {
    value = scrub.v;
    if (reference != null) {
      abs = scrub.v - reference;
      base = reference;
    }
    label = range === '1T' ? fmt.time(scrub.t) : fmt.dateOnly(scrub.t);
  } else {
    value = model.equityNow;
    if (range === '1T') {
      if (model.liveEquity != null && model.dayBaseEquity != null) {
        abs = model.liveEquity - model.dayBaseEquity;
        base = model.dayBaseEquity;
      } else if (model.history.length > 1) {
        const prev = model.history[model.history.length - 2].equity;
        abs = model.botEquity - prev;
        base = prev;
        label = 'letzter Bot-Lauf';
      }
    } else if (reference != null) {
      abs = value - reference;
      base = reference;
    }
  }
  v['depot-value'] = { text: fmt.eur(value), n: scrub ? null : value };
  if (abs != null) {
    v['depot-change'] = withTone(fmt.change(abs, base ? (abs / base) * 100 : null));
  } else {
    v['depot-change'] = { text: 'Live-Kurse fehlen', tone: 'flat' };
  }
  v['depot-label'] = { text: label };

  for (const p of model.positions) {
    const s = p.pos.symbol;
    v[`pos-value:${s}`] = p.value != null ? { text: fmt.eur(p.value), n: p.value } : { text: fmt.eur(p.pos.size_eur) };
    const pct = state.ui.perf === 'today' ? p.dayPct : p.pnlPct;
    v[`pos-perf:${s}`] = pct != null ? withTone(fmt.pctChange(pct)) : { text: 'Einsatz, kein Kurs', tone: 'flat' };
  }
  for (const c of state.bot.candidates || []) {
    const q = state.quotes[c.symbol];
    v[`cand-price:${c.symbol}`] = q?.price != null ? { text: fmt.usd(q.price), n: q.price } : { text: c.close != null ? fmt.usd(c.close) : '–' };
    v[`cand-change:${c.symbol}`] =
      q?.price != null && q.prevClose
        ? withTone(fmt.pctChange((q.price / q.prevClose - 1) * 100))
        : { text: 'Schlusskurs', tone: 'flat' };
  }
}

function detailValues(model, detail, held, v) {
  const symbol = state.route.symbol;
  const q = state.quotes[symbol];
  const scrub = state.ui.scrub;
  const range = state.ui.detailRange;
  const cand = (state.bot.candidates || []).find((c) => c.symbol === symbol);
  const lastBar = (state.series[`${symbol}:daily`] || []).slice(-1)[0];
  const fallback = lastBar?.[1] ?? cand?.close ?? held?.pos.entry_price ?? null;
  const reference = range === '1T' ? q?.prevClose ?? detail.points[0]?.[1] : detail.baseline ?? detail.points[0]?.[1];
  let price = q?.price ?? fallback;
  let label = detail.label;
  if (scrub) {
    price = scrub.v;
    label = range === '1T' ? fmt.time(scrub.t) : range === '1W' ? fmt.stamp(scrub.t) : fmt.dateOnly(scrub.t);
  }
  v['d-price'] = price != null ? { text: fmt.usd(price), n: scrub ? null : price } : { text: '–' };
  if (price != null && reference) {
    v['d-change'] = withTone(fmt.change(price - reference, (price / reference - 1) * 100, fmt.absUsd));
  } else {
    v['d-change'] = { text: q ? '' : 'kein Live-Kurs', tone: 'flat' };
  }
  v['d-label'] = { text: label };

  if (held) {
    v['d-pos-value'] = held.value != null ? { text: fmt.eur(held.value), n: held.value } : { text: '–' };
    v['d-pos-pnl'] = held.pnl != null ? withTone(fmt.change(held.pnl, held.pnlPct)) : { text: '–', tone: 'flat' };
    v['d-pos-day'] = held.dayPnl != null ? withTone(fmt.change(held.dayPnl, held.dayPct)) : { text: '–', tone: 'flat' };
    if (held.stopDist != null) {
      const through = held.stopDist <= 0;
      const nb = '\u00a0';
      v['d-stop-dist'] = { text: through ? 'unterschritten' : `noch ${fmt.num(held.stopDist, 1)}${nb}% Abstand`, tone: through ? 'down' : 'flat' };
      // The bot moves its trailing stop at the close; show where it would land at today's price.
      const next = projectedStop(held.pos, held.price, model.rules.trailingStopPct);
      const moves = Math.abs(next - held.pos.stop_loss_price) >= 0.005;
      let text = through
        ? 'Der Kurs liegt drunter. Der Bot verkauft beim nächsten Lauf, wenn das zum Schluss so bleibt.'
        : `noch ${fmt.num(held.stopDist, 1)}${nb}% Abstand zum aktuellen Kurs.`;
      if (!through && moves) text += ` Schließt der Kurs so, zieht der Stop auf ${fmt.usd(next)} nach.`;
      v['d-stop-rule'] = { text, tone: through ? 'down' : 'flat' };
    } else {
      v['d-stop-dist'] = { text: '', tone: 'flat' };
      v['d-stop-rule'] = { text: 'Abstand erscheint mit Live-Kursen', tone: 'flat' };
    }
  }
}

function currentSeries(model) {
  if (!model) return null;
  if (state.route.view === 'home') return depotSeries(model, state.ui.range);
  if (state.route.view === 'detail') {
    const held = model.positions.find((p) => p.pos.symbol === state.route.symbol);
    return detailSeries(state.route.symbol, state.ui.detailRange, state.quotes[state.route.symbol], held?.pos);
  }
  return null;
}

let mainChart = null;

function paint({ charts = true } = {}) {
  const model = computeModel();
  const series = currentSeries(model);
  const v = { 'live-pill': pillValue() };
  if (model && series) {
    if (state.route.view === 'home') homeValues(model, series, v);
    else {
      const held = model.positions.find((p) => p.pos.symbol === state.route.symbol);
      detailValues(model, series, held, v);
    }
  }
  for (const el of document.querySelectorAll('[data-live]')) {
    const value = v[el.dataset.live];
    if (!value) continue;
    if (el.textContent !== value.text) {
      const prev = el.dataset.n ? Number(el.dataset.n) : null;
      el.textContent = value.text;
      if ('flash' in el.dataset && value.n != null && prev != null && value.n !== prev) flash(el, value.n > prev);
    }
    if (value.n != null) el.dataset.n = String(value.n);
    else delete el.dataset.n;
    if (value.tone) el.dataset.tone = value.tone;
    if (value.label) el.setAttribute('aria-label', value.label);
    else el.removeAttribute('aria-label');
  }
  if (charts && mainChart && series) {
    mainChart.update({
      ...series,
      live: state.market.state === 'open' && state.stream.status === 'connected',
    });
  }
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Tints the big number for a moment in the direction of the last trade, at
// most every two seconds so a busy stock does not flicker.
function flash(el, up) {
  if (reducedMotion.matches) return;
  const now = Date.now();
  if (now - Number(el.dataset.flashAt || 0) < 2000) return;
  el.dataset.flashAt = String(now);
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // restart the animation
  el.classList.add(up ? 'flash-up' : 'flash-down');
}

// --- Views -------------------------------------------------------------------

function topbar({ title, back = false, pill = true, settings = false }) {
  return `<header class="topbar">
    ${back ? `<button type="button" class="icon-btn" data-action="back" aria-label="Zurück">${ICONS.back}</button>` : ''}
    <div class="topbar-title">${esc(title)}</div>
    <div class="topbar-actions">
      ${pill ? '<span class="pill" data-live="live-pill" role="status"></span>' : ''}
      ${settings ? `<a class="icon-btn" href="#/einstellungen" aria-label="Einstellungen">${ICONS.settings}</a>` : ''}
    </div>
  </header>`;
}

function rangeTabs(active, attr) {
  const buttons = RANGES.map(
    (r) =>
      `<button type="button" role="tab" class="range" data-${attr}="${r.id}" aria-selected="${r.id === active}">${r.label}</button>`,
  ).join('');
  return `<div class="ranges" role="tablist" aria-label="Zeitraum">${buttons}</div>`;
}

function notice(text, { tone = 'info', action = '' } = {}) {
  return `<div class="notice notice-${tone}" role="${tone === 'error' ? 'alert' : 'note'}">
    ${tone === 'warn' || tone === 'error' ? `<span class="notice-icon">${ICONS.warn}</span>` : ''}
    <div class="notice-body"><p>${text}</p>${action}</div>
  </div>`;
}

function skeleton() {
  return `<section class="hero" aria-busy="true"><div class="skeleton skeleton-value"></div><div class="skeleton skeleton-line"></div></section>
    <div class="chart chart-skeleton"></div>
    <p class="loading-text">Lade Depot aus GitHub …</p>`;
}

function errorBlock(message) {
  return notice(esc(message), {
    tone: 'error',
    action:
      '<div class="notice-actions"><button type="button" class="btn small" data-action="retry">Erneut versuchen</button>' +
      '<a class="btn small ghost" href="#/einstellungen">Einstellungen</a></div>',
  });
}

function viewWelcome() {
  return `${topbar({ title: 'Depot', pill: false, settings: true })}
  <section class="welcome">
    <h1>Dein RSI-Bot, live</h1>
    <p>Diese App zeigt das simulierte Depot deines S&amp;P-500-RSI-Bots mit Echtzeitkursen. Dafür trägst du einmalig ein:</p>
    <ol class="steps">
      <li><b>GitHub-Token</b> (nur Lesen) für die Depotdaten aus deinem privaten Repo</li>
      <li><b>Finnhub-Schlüssel</b> für die Live-Kurse (kostenlos)</li>
      <li><b>Twelve-Data-Schlüssel</b> für den Kursverlauf (optional, den hat dein Bot schon)</li>
    </ol>
    <a class="btn primary" href="#/einstellungen">Jetzt einrichten</a>
    <p class="note">Die Schlüssel bleiben nur auf diesem Gerät gespeichert.</p>
  </section>`;
}

function homeNotices(model) {
  const out = [];
  if (state.botError) out.push(errorBlock(`Aktualisierung fehlgeschlagen: ${state.botError}`));
  if (!state.settings.finnhubKey) {
    out.push(
      notice('Ohne Finnhub-Schlüssel siehst du den Stand vom letzten Bot-Lauf, aber keine Live-Kurse.', {
        action: '<a class="notice-link" href="#/einstellungen">Schlüssel eintragen</a>',
      }),
    );
  } else if (state.quoteError) {
    out.push(notice(esc(state.quoteError), { tone: 'error' }));
  }
  if (state.stream.error) out.push(notice(`Live-Verbindung: ${esc(state.stream.error)}`, { tone: 'warn' }));
  const gaps = model.positions.map((p) => [p.pos.symbol, gapInfo(p.pos.symbol, p.pos)]).filter(([, g]) => g);
  for (const [symbol, gap] of gaps) {
    out.push(
      notice(
        `<b>${esc(displayName(symbol))}:</b> Kurssprung um ${fmt.signedPct(gap.r * 100, 1)} an einem Tag (${fmt.dateOnly(gap.t)}). ` +
          'Das sieht nach einer Kapitalmaßnahme aus, zum Beispiel einer Abspaltung. Das RSI-Signal ist dann nicht aussagekräftig.' +
          (gap.flagged ? ' Der Bot hat die Position markiert, ihr Ergebnis fließt nicht ins Lernen ein.' : ''),
        { tone: 'warn', action: `<a class="notice-link" href="#/aktie/${encodeURIComponent(symbol)}">Details</a>` },
      ),
    );
  }
  return out.join('');
}

function positionRow(p, rules) {
  const { pos } = p;
  const s = pos.symbol;
  const direction = pos.direction === 'SHORT' ? 'Short' : 'Long';
  return `<li><a class="row" href="#/aktie/${encodeURIComponent(s)}">
    ${logo(s)}
    <span class="row-main">
      <span class="row-title">${esc(displayName(s))}</span>
      <span class="row-sub">${esc(s)} · ${direction} ${fmt.num(rules.leverage, 0)}× · Tag ${pos.days_held} von ${rules.maxHoldingDays}</span>
    </span>
    <span class="row-side">
      <span class="row-value" data-live="pos-value:${esc(s)}"></span>
      <span class="row-perf" data-live="pos-perf:${esc(s)}"></span>
    </span>
  </a></li>`;
}

function positionsSection(model) {
  const { positions, pf, rules } = model;
  const free = Math.max(0, rules.maxPositions - positions.length);
  const perfLabel = state.ui.perf === 'today' ? 'Heute' : 'Seit Kauf';
  const toggle = positions.length
    ? `<button type="button" class="chip-btn" data-action="toggle-perf" aria-label="Performance: ${perfLabel}. Umschalten">${perfLabel}<span aria-hidden="true">⇅</span></button>`
    : '';
  const body = positions.length
    ? `<ul class="rows">${positions.map((p) => positionRow(p, rules)).join('')}</ul>`
    : `<p class="empty">Gerade keine offene Position. Der Bot kauft, sobald ein Signal mindestens ${fmt.num(rules.minScore, 0)} Punkte erreicht.</p>`;
  return `<section class="section" aria-labelledby="h-positions">
    <div class="section-head"><h2 id="h-positions">Positionen</h2>${toggle}</div>
    ${body}
    <div class="cash-row">
      <span class="cash-main"><span class="row-title">Verfügbar</span><span class="row-sub">${free} von ${rules.maxPositions} Plätzen frei</span></span>
      <span class="row-value">${fmt.eur(pf.cash)}</span>
    </div>
  </section>`;
}

function signalsSection(model) {
  const candidates = state.bot.candidates || [];
  const held = new Set(model.positions.map((p) => p.pos.symbol));
  const lastRun = model.history.length ? model.history[model.history.length - 1].date : null;
  const sub = lastRun ? `<p class="section-sub">Aus dem Bot-Lauf vom ${fmt.dayLong(lastRun)}</p>` : '';
  const blocked = blockedRows();
  if (!candidates.length) {
    return `<section class="section" aria-labelledby="h-signals">
      <div class="section-head"><h2 id="h-signals">Signale</h2></div>${sub}
      <p class="empty">Keine Aktie hat beim letzten Lauf die Mindestpunktzahl von ${fmt.num(model.rules.minScore, 0)} erreicht.</p>
      ${blocked}
    </section>`;
  }
  const rows = candidates
    .map((c) => {
      const s = c.symbol;
      const dir = c.direction === 'SHORT' ? 'Short' : 'Long';
      return `<li><a class="row" href="#/aktie/${encodeURIComponent(s)}">
        ${logo(s)}
        <span class="row-main">
          <span class="row-title row-title-tagged"><span class="row-name">${esc(displayName(s))}</span>${held.has(s) ? '<span class="tag">gekauft</span>' : ''}</span>
          <span class="row-sub">${esc(s)} · ${dir} · Score ${fmt.num(c.score, 0)} · RSI ${fmt.num(c.rsi, 1)}</span>
        </span>
        <span class="row-side">
          <span class="row-value" data-live="cand-price:${esc(s)}"></span>
          <span class="row-perf" data-live="cand-change:${esc(s)}"></span>
        </span>
      </a></li>`;
    })
    .join('');
  return `<section class="section" aria-labelledby="h-signals">
    <div class="section-head"><h2 id="h-signals">Signale</h2></div>${sub}
    <ul class="rows">${rows}</ul>
    ${blocked}
  </section>`;
}

// Signals the bot's corporate-action filter dropped in its last run.
function blockedRows() {
  const blocked = state.bot.blocked || [];
  if (!blocked.length) return '';
  const rows = blocked
    .map((b) => {
      const s = b.symbol;
      const dir = b.direction === 'SHORT' ? 'Short' : 'Long';
      const jump = b.change_pct != null ? `Sprung ${fmt.signedPct(b.change_pct, 1)}${b.date ? ` am ${fmt.dayCompact(b.date)}` : ''}` : 'Kurssprung';
      return `<li><a class="row" href="#/aktie/${encodeURIComponent(s)}">
        ${logo(s)}
        <span class="row-main">
          <span class="row-title row-title-tagged"><span class="row-name">${esc(displayName(s))}</span><span class="tag">gefiltert</span></span>
          <span class="row-sub">${dir} · ${jump}</span>
        </span>
        <span class="row-side"><span class="row-value">${b.close != null ? fmt.usd(b.close) : '–'}</span></span>
      </a></li>`;
    })
    .join('');
  return `<h3 class="sub-head">Vom Kapitalmaßnahmen-Filter aussortiert</h3><ul class="rows">${rows}</ul>`;
}

function activityItems(trades) {
  const items = [];
  for (const t of trades) {
    if (t.entryDate) items.push({ date: t.entryDate, kind: 'open', t });
    if (t.status === 'CLOSED' && t.exitDate) items.push({ date: t.exitDate, kind: 'close', t });
  }
  return items.sort((a, b) => b.date.localeCompare(a.date) || (a.kind === 'close' ? -1 : 1));
}

function activityRow(item) {
  const { t } = item;
  const s = t.symbol;
  if (item.kind === 'open') {
    const what = t.direction === 'SHORT' ? 'Leerverkauf' : 'Kauf';
    return `<li><a class="row" href="#/aktie/${encodeURIComponent(s)}">
      ${logo(s)}
      <span class="row-main"><span class="row-title">${esc(displayName(s))}</span>
        <span class="row-sub">${what} · ${fmt.dayCompact(item.date)}</span></span>
      <span class="row-side"><span class="row-value">${t.sizeEur != null ? fmt.eur(t.sizeEur) : '–'}</span>
        <span class="row-perf" data-tone="flat">Score ${t.score != null ? fmt.num(t.score, 1) : '–'}</span></span>
    </a></li>`;
  }
  // The row shows the result in euros; the percentage is in the label for screen readers.
  const result = t.pnlEur != null ? fmt.change(t.pnlEur, t.pnlPct) : null;
  const resultText = result ? `${fmt.ARROWS[result.dir] ? `${fmt.ARROWS[result.dir]} ` : ''}${fmt.absEur(t.pnlEur)}` : '';
  return `<li><a class="row" href="#/aktie/${encodeURIComponent(s)}">
    ${logo(s)}
    <span class="row-main"><span class="row-title">${esc(displayName(s))}</span>
      <span class="row-sub">Verkauf · ${esc(EXIT_REASONS[t.exitReason] || t.exitReason || '')} · ${fmt.dayCompact(item.date)}</span></span>
    <span class="row-side"><span class="row-value">${t.sizeEur != null && t.pnlEur != null ? fmt.eur(t.sizeEur + t.pnlEur) : '–'}</span>
      ${result ? `<span class="row-perf" data-tone="${result.dir}" aria-label="${esc(result.label)}">${resultText}</span>` : ''}</span>
  </a></li>`;
}

function activitySection() {
  const items = activityItems(state.bot.trades || []);
  if (!items.length) {
    return `<section class="section" aria-labelledby="h-activity"><div class="section-head"><h2 id="h-activity">Aktivität</h2></div>
      <p class="empty">Noch keine Trades.</p></section>`;
  }
  const shown = items.slice(0, 12).map(activityRow).join('');
  const more = items.length > 12 ? `<p class="section-sub">und ${items.length - 12} ältere Einträge</p>` : '';
  return `<section class="section" aria-labelledby="h-activity">
    <div class="section-head"><h2 id="h-activity">Aktivität</h2></div>
    <ul class="rows">${shown}</ul>${more}
  </section>`;
}

// Without confirmation values the bars show each weight against the bot's
// cap (MAX_WEIGHT); with them, how strongly each indicator confirmed (0..1).
function weightBars(weights, maxWeight, values = null) {
  return INDICATORS.map(([key, name, hint]) => {
    const weight = weights[key] ?? 0;
    const confirm = values ? values[key] ?? 0 : null;
    const fill = values ? confirm * 100 : (weight / maxWeight) * 100;
    const shown = values ? fmt.num(confirm * weight, 1) : fmt.num(weight, 1);
    return `<li class="bar-row">
      <span class="bar-name">${name}<span class="bar-hint">${hint}</span></span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(0, Math.min(100, fill)).toFixed(1)}%"></span></span>
      <span class="bar-val">${shown}</span>
    </li>`;
  }).join('');
}

function botSection(model) {
  const { rules } = model;
  const meta = state.bot.weights?.meta || {};
  const weights = state.bot.weights?.weights || {};
  const window = meta.trade_window?.length ?? 0;
  const learning =
    window < rules.tradeWindowMin
      ? `Die Gewichte ändern sich, sobald ${fmt.num(rules.tradeWindowMin, 0)} Trades abgeschlossen sind (bisher ${window}).`
      : `Zuletzt angepasst am ${meta.last_updated ? fmt.dateOnly(Date.parse(meta.last_updated)) : '–'} aus ${window} abgeschlossenen Trades.`;
  const chips = [
    `RSI unter ${fmt.num(rules.rsiOversold, 0)} → Long`,
    `RSI über ${fmt.num(rules.rsiOverbought, 0)} → Short`,
    `Kauf ab ${fmt.num(rules.minScore, 0)} Punkten`,
    rules.trailingStopPct
      ? `Trailing Stop ${fmt.num(rules.trailingStopPct, 0)} %`
      : `Stop-Loss ${fmt.num(rules.stopLossPct, 0)} %`,
    `Ausstieg bei RSI ${fmt.num(rules.rsiExit, 0)}`,
    `max. ${fmt.num(rules.maxHoldingDays, 0)} Tage`,
    `Hebel ${fmt.num(rules.leverage, 0)}×`,
    ...(rules.gapPct ? [`Filter: Sprünge ab ${fmt.num(rules.gapPct, 0)} %`] : []),
  ]
    .map((c) => `<li>${c}</li>`)
    .join('');
  return `<section class="section" aria-labelledby="h-bot">
    <div class="section-head"><h2 id="h-bot">So entscheidet der Bot</h2></div>
    <ul class="rule-chips">${chips}</ul>
    <h3 class="sub-head">Gewichtung der sechs Bestätigungen</h3>
    <ul class="bars">${weightBars(weights, rules.maxWeight)}</ul>
    <p class="note">Jedes Gewicht liegt zwischen ${fmt.num(rules.minWeight, 0)} und ${fmt.num(rules.maxWeight, 0)}, zusammen sind es 100. ${learning}</p>
  </section>`;
}

function footer(model) {
  const c = state.bot.commit;
  return `<footer class="foot">
    <p>Bot-Stand: ${c.date ? fmt.stamp(Date.parse(c.date)) : '–'}</p>
    <p class="muted">Live-Kurse: Finnhub · Kursverlauf: Twelve Data. Gerechnet wie im Bot: ${fmt.num(model.rules.leverage, 0)}× Hebel, Kurse in US-Dollar, Depot in Euro ohne Währungsumrechnung.</p>
    <p class="muted">Simulation mit Spielgeld, keine Anlageberatung.</p>
  </footer>`;
}

function viewHome(model) {
  if (!hasSetup()) return viewWelcome();
  const top = topbar({ title: 'Depot', settings: true });
  if (!model) return `${top}${state.botError ? errorBlock(state.botError) : skeleton()}`;
  return `${top}
    <section class="hero" aria-label="Depotwert">
      <div class="hero-value" data-live="depot-value" data-flash></div>
      <div class="hero-change"><span data-live="depot-change"></span><span class="hero-label" data-live="depot-label"></span></div>
    </section>
    <div class="chart" id="main-chart"></div>
    ${rangeTabs(state.ui.range, 'range')}
    ${homeNotices(model)}
    ${positionsSection(model)}
    ${signalsSection(model)}
    ${activitySection()}
    ${botSection(model)}
    ${footer(model)}`;
}

function positionCard(p, rules) {
  const { pos } = p;
  const direction = pos.direction === 'SHORT' ? 'Short, setzt auf fallende Kurse' : 'Long, setzt auf steigende Kurse';
  const held = Math.min(pos.days_held, rules.maxHoldingDays);
  return `<section class="section" aria-labelledby="h-position">
    <div class="section-head"><h2 id="h-position">Deine Position</h2></div>
    <dl class="facts">
      <div><dt>Wert</dt><dd data-live="d-pos-value"></dd></div>
      <div><dt>Seit Kauf</dt><dd data-live="d-pos-pnl"></dd></div>
      <div><dt>Einsatz</dt><dd>${fmt.eur(pos.size_eur)}</dd></div>
      <div><dt>Heute</dt><dd data-live="d-pos-day"></dd></div>
      <div><dt>Einstieg</dt><dd>${fmt.usd(pos.entry_price)}<span class="dd-sub">${fmt.dayLong(pos.entry_date)}</span></dd></div>
      <div><dt>${stopLabel(rules)}</dt><dd>${fmt.usd(pos.stop_loss_price)}${
        stopHasTrailed(pos) ? `<span class="dd-sub">nachgezogen, Start ${fmt.usd(pos.initial_stop_price)}</span>` : ''
      }<span class="dd-sub" data-live="d-stop-dist"></span></dd></div>
      <div class="facts-wide"><dt>Richtung</dt><dd>${direction} · Hebel ${fmt.num(rules.leverage, 0)}×</dd></div>
    </dl>
    <div class="progress-head"><span>Haltedauer</span><span>Tag ${pos.days_held} von ${rules.maxHoldingDays}</span></div>
    <div class="progress" role="progressbar" aria-label="Haltedauer" aria-valuemin="0" aria-valuemax="${rules.maxHoldingDays}" aria-valuenow="${held}">
      <span style="width:${((held / rules.maxHoldingDays) * 100).toFixed(1)}%"></span>
    </div>
  </section>`;
}

function reasonCard(source, isPosition, rules) {
  const weights = state.bot.weights?.weights || {};
  const rsi = source.rsi_at_entry ?? source.rsi;
  const long = source.direction !== 'SHORT';
  const title = isPosition ? 'Warum der Bot eingestiegen ist' : 'Signal vom letzten Bot-Lauf';
  return `<section class="section" aria-labelledby="h-reason">
    <div class="section-head"><h2 id="h-reason">${title}</h2></div>
    <p class="lead">RSI ${rsi != null ? fmt.num(rsi, 1) : '–'}: ${long ? 'stark überverkauft, also Long' : 'stark überkauft, also Short'}.
      Score ${source.score != null ? fmt.num(source.score, 1) : '–'} von 100 Punkten, gehandelt wird ab ${fmt.num(rules.minScore, 0)}.</p>
    <ul class="bars">${weightBars(weights, rules.maxWeight, source.confirmations || {})}</ul>
    <p class="note">Balken: wie stark der Indikator das Signal bestätigt (0 bis 1). Zahl: Punkte mit den aktuellen Gewichten.</p>
  </section>`;
}

function exitCard(p, rules) {
  const { pos } = p;
  const left = Math.max(0, rules.maxHoldingDays - pos.days_held);
  return `<section class="section" aria-labelledby="h-exit">
    <div class="section-head"><h2 id="h-exit">Wann der Bot verkauft</h2></div>
    <ul class="rules">
      <li><span class="rule-name">${stopLabel(rules)} bei ${fmt.usd(pos.stop_loss_price)}</span><span class="rule-state" data-live="d-stop-rule"></span>${
        rules.trailingStopPct
          ? `<span class="rule-state" data-tone="flat">Er folgt dem besten Schlusskurs seit Kauf mit ${fmt.num(rules.trailingStopPct, 0)} % Abstand und geht nie zurück.</span>`
          : ''
      }</li>
      <li><span class="rule-name">RSI zurück auf ${fmt.num(rules.rsiExit, 0)}</span><span class="rule-state" data-tone="flat">Bei Einstieg lag er bei ${fmt.num(pos.rsi_at_entry, 1)}.</span></li>
      <li><span class="rule-name">Spätestens nach ${fmt.num(rules.maxHoldingDays, 0)} Handelstagen</span><span class="rule-state" data-tone="flat">${left ? `noch ${left} ${left === 1 ? 'Tag' : 'Tage'}` : 'beim nächsten Lauf'}</span></li>
    </ul>
    <p class="note">Der Bot prüft diese Regeln einmal pro Handelstag mit dem Schlusskurs, nicht während des Handels.</p>
  </section>`;
}

function tradesCard(trades) {
  const items = activityItems(trades).map(activityRow).join('');
  return `<section class="section" aria-labelledby="h-trades">
    <div class="section-head"><h2 id="h-trades">Trades mit dieser Aktie</h2></div>
    <ul class="rows">${items}</ul>
  </section>`;
}

function detailNotices(symbol, pos) {
  const out = [];
  const gap = gapInfo(symbol, pos);
  if (gap) {
    out.push(
      notice(
        `<b>Kurssprung am ${fmt.dateOnly(gap.t)}:</b> ${fmt.signedPct(gap.r * 100, 1)} an einem Tag, von ${fmt.usd(gap.from)} auf ${fmt.usd(gap.to)}. ` +
          'So ein Sprung entsteht meist durch eine Kapitalmaßnahme wie eine Abspaltung oder einen Aktiensplit, nicht durch echten Verkaufsdruck. ' +
          'Der RSI liest ihn trotzdem als extremen Ausverkauf, das Signal ist dann nicht aussagekräftig.' +
          (gap.flagged ? ' Der Bot hat die Position deshalb markiert, ihr Ergebnis fließt nicht ins Lernen ein.' : ''),
        { tone: 'warn' },
      ),
    );
  }
  if (!state.settings.twelveKey && state.ui.detailRange !== '1T') {
    out.push(
      notice('Für den Verlauf über mehrere Tage trägst du einen Twelve-Data-Schlüssel ein.', {
        action: '<a class="notice-link" href="#/einstellungen">Einstellungen</a>',
      }),
    );
  }
  if (state.seriesError) out.push(notice(esc(state.seriesError), { tone: 'warn' }));
  if (state.quoteError) out.push(notice(esc(state.quoteError), { tone: 'error' }));
  return out.join('');
}

function viewDetail(model) {
  const symbol = state.route.symbol;
  const top = topbar({ title: symbol, back: true });
  if (!model) return `${top}${state.botError ? errorBlock(state.botError) : skeleton()}`;
  const held = model.positions.find((p) => p.pos.symbol === symbol);
  const cand = (state.bot.candidates || []).find((c) => c.symbol === symbol);
  const trades = (state.bot.trades || []).filter((t) => t.symbol === symbol);
  const industry = state.profiles[symbol]?.industry;
  return `${top}
    <section class="hero" aria-label="Kurs">
      <div class="hero-title">${logo(symbol)}<span class="hero-names"><span class="hero-name">${esc(displayName(symbol))}</span>
        <span class="hero-sub">${esc(symbol)}${industry ? ` · ${esc(industry)}` : ''}</span></span></div>
      <div class="hero-value" data-live="d-price" data-flash></div>
      <div class="hero-change"><span data-live="d-change"></span><span class="hero-label" data-live="d-label"></span></div>
    </section>
    <div class="chart" id="main-chart"></div>
    ${rangeTabs(state.ui.detailRange, 'detail-range')}
    ${detailNotices(symbol, held?.pos)}
    ${held ? positionCard(held, model.rules) : ''}
    ${held || cand ? reasonCard(held ? held.pos : cand, Boolean(held), model.rules) : ''}
    ${held ? exitCard(held, model.rules) : ''}
    ${trades.length ? tradesCard(trades) : ''}
    ${!held && !cand && !trades.length ? '<p class="empty">Diese Aktie kommt in den Daten des Bots nicht vor.</p>' : ''}`;
}

function viewSettings() {
  const s = state.settings;
  const field = (id, name, label, value, placeholder, help, optional = false) => `
    <div class="field">
      <label for="${id}">${label}${optional ? ' <span class="optional">optional</span>' : ''}</label>
      <div class="secret">
        <input id="${id}" name="${name}" type="password" value="${esc(value)}" placeholder="${esc(placeholder)}"
          autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button type="button" class="reveal" data-action="reveal" data-target="${id}" aria-controls="${id}" aria-pressed="false">Zeigen</button>
      </div>
      <p class="help">${help}</p>
    </div>`;
  return `${topbar({ title: 'Einstellungen', back: true, pill: false })}
  <form id="settings-form" class="form" novalidate>
    <p class="lead">Die Schlüssel werden nur auf diesem Gerät gespeichert und gehen direkt an GitHub, Finnhub und Twelve Data.</p>
    ${field('set-github', 'githubToken', 'GitHub-Token', s.githubToken, 'github_pat_…',
      'Fine-grained Token mit Zugriff nur auf dein Aktien-Repo und dem Recht „Contents: Read-only“. ' +
      '<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Token erstellen</a>')}
    ${field('set-finnhub', 'finnhubKey', 'Finnhub-Schlüssel', s.finnhubKey, 'z. B. d1abc…',
      'Kostenlos für Echtzeitkurse. <a href="https://finnhub.io/register" target="_blank" rel="noopener">Registrieren</a>, danach steht der Schlüssel im Dashboard.')}
    ${field('set-twelve', 'twelveKey', 'Twelve-Data-Schlüssel', s.twelveKey, 'z. B. 1a2b3c…',
      'Für den Kursverlauf. Den Schlüssel nutzt auch dein Bot, die App ruft nur wenige Daten ab und pausiert während seines Laufs. ' +
      '<a href="https://twelvedata.com/account/api-keys" target="_blank" rel="noopener">Schlüssel ansehen</a>', true)}
    <details class="advanced">
      <summary>Repo und Branch</summary>
      <div class="field">
        <label for="set-repo">Repo</label>
        <input id="set-repo" name="repo" type="text" value="${esc(s.repo)}" autocomplete="off" autocapitalize="off" spellcheck="false">
      </div>
      <div class="field">
        <label for="set-branch">Branch mit den Bot-Daten</label>
        <input id="set-branch" name="branch" type="text" value="${esc(s.branch)}" autocomplete="off" autocapitalize="off" spellcheck="false">
      </div>
    </details>
    <button type="submit" class="btn primary">Speichern</button>
    <button type="button" class="btn ghost danger" data-action="forget">${state.ui.forgetArmed ? 'Wirklich löschen? Nochmal tippen' : 'Schlüssel von diesem Gerät löschen'}</button>
  </form>`;
}

// --- Rendering ---------------------------------------------------------------

function render({ force = false } = {}) {
  const app = document.getElementById('app');
  const view = state.route.view;
  // Background updates must not wipe what someone is typing.
  if (view === 'settings' && !force && document.getElementById('settings-form')) return;
  const model = computeModel();
  if (mainChart) {
    mainChart.destroy();
    mainChart = null;
  }
  app.innerHTML = view === 'settings' ? viewSettings() : view === 'detail' ? viewDetail(model) : viewHome(model);
  document.title = view === 'detail' ? `${state.route.symbol} · Depot` : view === 'settings' ? 'Einstellungen · Depot' : 'RSI-Bot Depot';
  const host = document.getElementById('main-chart');
  if (host) {
    mainChart = new LineChart(host, {
      height: 210,
      label: view === 'detail' ? `Kursverlauf ${state.route.symbol}` : 'Depotverlauf',
      onScrub: (point) => {
        state.ui.scrub = point;
        paint({ charts: false });
      },
    });
  }
  paint();
}

let pending = null;
let flushTimer = null;
let lastPaint = 0;

// Coalesces updates: a full render rebuilds the view, a live update only
// repaints numbers and the chart, at most four times per second.
function schedule(kind = 'full') {
  pending = pending === 'full' || kind === 'full' ? 'full' : 'live';
  if (flushTimer) return;
  const wait = pending === 'full' ? 0 : Math.max(0, 250 - (performance.now() - lastPaint));
  flushTimer = setTimeout(() => requestAnimationFrame(flush), wait);
}

function flush() {
  flushTimer = null;
  const kind = pending;
  pending = null;
  lastPaint = performance.now();
  if (kind === 'full') render();
  else paint();
}

// --- Data loading ------------------------------------------------------------

let botTimer = 0;
let quotesTimer = 0;
let botGeneration = 0;

async function refreshBot({ force = false } = {}) {
  if (!hasSetup()) return;
  // A forced load (new settings) supersedes one still in flight.
  if (state.botLoading && !force) return;
  const generation = ++botGeneration;
  state.botLoading = true;
  botTimer = Date.now();
  const prevError = state.botError;
  let changed = false;
  try {
    const data = await loadBotData(state.settings, force ? null : state.bot?.commit.sha);
    if (generation !== botGeneration) return;
    state.botError = null;
    if (data) {
      state.bot = data;
      changed = true;
      onSymbolsChanged();
    }
  } catch (err) {
    if (generation !== botGeneration) return;
    state.botError = err.message || 'Unbekannter Fehler.';
  } finally {
    if (generation === botGeneration) {
      state.botLoading = false;
      if (changed || prevError !== state.botError) schedule('full');
    }
  }
}

async function refreshQuotes() {
  const key = state.settings.finnhubKey;
  if (!key || !state.bot) return;
  quotesTimer = Date.now();
  const prevError = state.quoteError;
  const symbols = trackedSymbols();
  const results = await Promise.allSettled(symbols.map((s) => fetchQuote(s, key)));
  if (key !== state.settings.finnhubKey) return;
  let error = null;
  results.forEach((result, i) => {
    const symbol = symbols[i];
    if (result.status === 'fulfilled' && result.value) {
      const prev = state.quotes[symbol];
      const snap = result.value;
      // A streamed trade that is newer than this snapshot keeps its price.
      const keepStreamed = prev?.ts && prev.ts > snap.ts;
      state.quotes[symbol] = { ...snap, price: keepStreamed ? prev.price : snap.price, ts: keepStreamed ? prev.ts : snap.ts };
    } else if (result.status === 'rejected') {
      error = result.reason;
    }
  });
  state.quoteError = error ? error.message : null;
  if (error?.kind === 'auth') stopStream();
  schedule(prevError !== state.quoteError ? 'full' : 'live');
}

async function refreshProfiles() {
  const key = state.settings.finnhubKey;
  if (!key || !state.bot) return;
  const now = Date.now();
  const wanted = new Set(trackedSymbols());
  for (const t of (state.bot.trades || []).slice(-20)) wanted.add(t.symbol);
  for (const b of state.bot.blocked || []) wanted.add(b.symbol);
  const missing = [...wanted].filter((s) => !state.profiles[s] || now - (state.profiles[s].at || 0) > 7 * DAY).slice(0, 20);
  if (!missing.length) return;
  const results = await Promise.allSettled(missing.map((s) => fetchProfile(s, key)));
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') state.profiles[missing[i]] = { ...(result.value || {}), at: now };
  });
  store.save(PROFILES_KEY, state.profiles);
  schedule('full');
}

// How old a cached series may be. While the market is open it refreshes
// regularly; afterwards once, as soon as the session's data is settled.
function maxAgeFor(kind, purpose) {
  const now = Date.now();
  if (state.market.state === 'open') {
    if (kind === 'daily') return 6 * 3600_000;
    return purpose === 'detail' ? 10 * MINUTE : 30 * MINUTE;
  }
  const settled = state.market.session.close + 20 * MINUTE;
  return now > settled ? now - settled : 6 * 3600_000;
}

const inflight = new Set();

async function ensureSeries(symbol, kind, maxAgeMs) {
  const id = `${symbol}:${kind}`;
  if (!state.series[id]) {
    const cached = cachedSeries(symbol, kind);
    if (cached) {
      state.series[id] = cached.points;
      state.seriesAt[id] = cached.at;
    }
  }
  if (inflight.has(id)) return;
  inflight.add(id);
  try {
    const entry = await loadSeries(symbol, kind, state.settings.twelveKey, maxAgeMs);
    if (entry && entry.at !== state.seriesAt[id]) {
      state.series[id] = entry.points;
      state.seriesAt[id] = entry.at;
      schedule('full');
    }
    if (state.seriesError) {
      state.seriesError = null;
      schedule('full');
    }
  } catch (err) {
    state.seriesError = err.message;
    schedule('full');
  } finally {
    inflight.delete(id);
  }
}

function ensureDepotSeries() {
  if (!state.bot) return;
  for (const pos of state.bot.portfolio.open_positions) {
    ensureSeries(pos.symbol, 'intraday', maxAgeFor('intraday', 'depot'));
    // The daily series feeds the corporate-action check on each position.
    ensureSeries(pos.symbol, 'daily', maxAgeFor('daily', 'depot'));
  }
}

function ensureDetailSeries() {
  if (state.route.view !== 'detail' || !state.bot) return;
  const symbol = state.route.symbol;
  const kind = { '1T': 'intraday', '1W': 'week' }[state.ui.detailRange] || 'daily';
  ensureSeries(symbol, kind, maxAgeFor(kind, 'detail'));
  if (kind !== 'daily') ensureSeries(symbol, 'daily', maxAgeFor('daily', 'detail'));
}

function onSymbolsChanged() {
  stream?.setSymbols(trackedSymbols());
  refreshQuotes();
  refreshProfiles();
  ensureDepotSeries();
  ensureDetailSeries();
}

// --- Live stream -------------------------------------------------------------

let stream = null;
let ticksDirty = false;

function recordTick(symbol, price, t) {
  const { session } = state.market;
  // Only regular-session trades build the "1T" curve.
  if (t < session.open || t > session.close) return;
  if (state.ticks.date !== session.date) state.ticks = { date: session.date, series: {} };
  const minute = Math.floor(t / MINUTE) * MINUTE;
  const list = (state.ticks.series[symbol] ||= []);
  const last = list[list.length - 1];
  if (last && last[0] === minute) last[1] = price;
  else if (!last || minute > last[0]) list.push([minute, price]);
  ticksDirty = true;
}

function startStream() {
  const key = state.settings.finnhubKey;
  if (!key) return;
  if (!stream) {
    stream = new TradeStream({
      key,
      onTrades: (latest) => {
        for (const [symbol, trade] of latest) {
          const q = (state.quotes[symbol] ||= { price: null, prevClose: null, open: null, ts: 0 });
          if (!q.ts || trade.t >= q.ts) {
            q.price = trade.price;
            q.ts = trade.t;
          }
          recordTick(symbol, trade.price, trade.t);
        }
        schedule('live');
      },
      onStatus: (status, message) => {
        state.stream = { status, error: status === 'error' ? message : null };
        schedule('live');
      },
    });
  }
  stream.setSymbols(trackedSymbols());
  stream.start();
}

function stopStream() {
  if (stream) {
    stream.stop();
    stream = null;
  }
  state.stream = { status: 'off', error: null };
}

// The socket only runs while US trading (incl. pre- and after-hours) is on
// and the app is visible.
function syncStream() {
  const wanted = Boolean(state.settings.finnhubKey) && hasSetup() && state.market.state !== 'closed' && !document.hidden;
  if (wanted) startStream();
  else if (stream) stopStream();
}

// --- Events ------------------------------------------------------------------

let inAppNavigations = 0;

function onRouteChange() {
  inAppNavigations++;
  const prev = state.route;
  state.route = parseRoute();
  if (prev.view === 'home') state.ui.homeScroll = window.scrollY;
  state.ui.scrub = null;
  state.ui.forgetArmed = false;
  if (state.route.view === 'detail' && (prev.view !== 'detail' || prev.symbol !== state.route.symbol)) {
    state.ui.detailRange = '1T';
  }
  render({ force: true });
  window.scrollTo(0, state.route.view === 'home' ? state.ui.homeScroll : 0);
  if (state.route.view === 'detail') {
    stream?.setSymbols(trackedSymbols());
    if (!state.quotes[state.route.symbol]) refreshQuotes();
    refreshProfiles();
    ensureDetailSeries();
  }
}

function saveSettings(form) {
  const data = new FormData(form);
  const text = (name) => String(data.get(name) || '').trim();
  const repo = text('repo').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const next = {
    githubToken: text('githubToken'),
    finnhubKey: text('finnhubKey'),
    twelveKey: text('twelveKey'),
    repo: repo || DEFAULT_SETTINGS.repo,
    branch: text('branch') || DEFAULT_SETTINGS.branch,
    setupDone: true,
  };
  const feedChanged = next.finnhubKey !== state.settings.finnhubKey;
  state.settings = next;
  store.save(SETTINGS_KEY, next);
  if (feedChanged) {
    stopStream();
    state.quotes = {};
    state.quoteError = null;
  }
  state.bot = null;
  state.botError = null;
  state.seriesError = null;
  location.hash = '#/';
  refreshBot({ force: true });
  syncStream();
}

function forgetKeys() {
  stopStream();
  botGeneration++;
  state.botLoading = false;
  state.settings = { ...DEFAULT_SETTINGS, repo: state.settings.repo, branch: state.settings.branch };
  store.save(SETTINGS_KEY, state.settings);
  state.bot = null;
  state.quotes = {};
  state.quoteError = null;
  state.botError = null;
  state.ui.forgetArmed = false;
  location.hash = '#/';
  render({ force: true });
}

function bindEvents() {
  const app = document.getElementById('app');
  app.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action], [data-range], [data-detail-range]');
    if (!el) return;
    if (el.dataset.range) {
      state.ui.range = el.dataset.range;
      state.ui.scrub = null;
      store.save('depot.ui.range', state.ui.range);
      render();
      return;
    }
    if (el.dataset.detailRange) {
      state.ui.detailRange = el.dataset.detailRange;
      state.ui.scrub = null;
      ensureDetailSeries();
      render();
      return;
    }
    switch (el.dataset.action) {
      case 'toggle-perf':
        state.ui.perf = state.ui.perf === 'today' ? 'total' : 'today';
        store.save('depot.ui.perf', state.ui.perf);
        render();
        break;
      case 'retry':
        refreshBot({ force: true });
        break;
      case 'back':
        // Opened straight on a detail page there is nothing to go back to.
        if (inAppNavigations > 0) history.back();
        else location.hash = '#/';
        break;
      case 'reveal': {
        const input = document.getElementById(el.dataset.target);
        if (!input) break;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        el.textContent = show ? 'Verbergen' : 'Zeigen';
        el.setAttribute('aria-pressed', String(show));
        break;
      }
      case 'forget':
        if (state.ui.forgetArmed) forgetKeys();
        else {
          state.ui.forgetArmed = true;
          el.textContent = 'Wirklich löschen? Nochmal tippen';
        }
        break;
      default:
        break;
    }
  });
  app.addEventListener('submit', (event) => {
    if (event.target.id !== 'settings-form') return;
    event.preventDefault();
    saveSettings(event.target);
  });
  // Broken company logos fall back to the ticker's letters.
  document.addEventListener(
    'error',
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains('logo-img')) return;
      const holder = img.parentElement;
      holder.classList.add('logo-text');
      holder.textContent = img.dataset.initials || '';
    },
    true,
  );
  window.addEventListener('hashchange', onRouteChange);

  let hiddenTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Keep the socket briefly so a quick app switch does not reconnect.
      hiddenTimer = setTimeout(syncStream, 60_000);
      if (ticksDirty) {
        ticksDirty = false;
        store.save(TICKS_KEY, state.ticks);
      }
    } else {
      clearTimeout(hiddenTimer);
      heartbeat({ eager: true });
    }
  });
}

function heartbeat({ eager = false } = {}) {
  const now = Date.now();
  const prev = state.market;
  state.market = marketStatus(now);
  const changed = prev.state !== state.market.state || prev.session.date !== state.market.session.date;
  syncStream();
  if (ticksDirty) {
    ticksDirty = false;
    store.save(TICKS_KEY, state.ticks);
  }
  if (document.hidden || !hasSetup()) return;
  if (eager || now - botTimer > 2 * MINUTE) refreshBot();
  if (eager || now - quotesTimer > (state.market.state === 'open' ? 2 : 5) * MINUTE) refreshQuotes();
  if (eager || changed) {
    ensureDepotSeries();
    ensureDetailSeries();
  }
  schedule(changed ? 'full' : 'live');
}

function boot() {
  pruneSeriesCache();
  bindEvents();
  render({ force: true });
  if (hasSetup()) {
    refreshBot({ force: true });
    syncStream();
  }
  setInterval(heartbeat, 20_000);
}

boot();

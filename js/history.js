// Price history from Twelve Data (optional key). The free key is shared
// with the bot, which spends most of its 800 daily credits in one run
// starting 21:45 UTC — so this app stays out of that window, keeps to a few
// calls per minute and caches every series on the device.
import * as store from './store.js';
import { nyTime } from './market.js';

const API = 'https://api.twelvedata.com';
const CACHE_PREFIX = 'depot.td.v1:';
const CALLS_PER_MINUTE = 4;

export const SERIES = {
  intraday: { interval: '5min', outputsize: 80, barMs: 5 * 60_000 },
  week: { interval: '30min', outputsize: 70, barMs: 30 * 60_000 },
  daily: { interval: '1day', outputsize: 1300, barMs: 0 },
};

export class HistoryError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export function inBotWindow(now = Date.now()) {
  const d = new Date(now);
  const weekday = d.getUTCDay();
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return weekday >= 1 && weekday <= 5 && minutes >= 21 * 60 + 35 && minutes < 23 * 60 + 15;
}

const recentCalls = [];
function takeCallBudget(now) {
  while (recentCalls.length && now - recentCalls[0] > 60_000) recentCalls.shift();
  if (recentCalls.length >= CALLS_PER_MINUTE) return false;
  recentCalls.push(now);
  return true;
}

const toTwelve = (symbol) => symbol.replace(/-/g, '.');

// Bars are stamped at their end time; daily bars at that day's close.
function barTime(datetime, barMs) {
  if (datetime.length === 10) return nyTime(datetime, 16, 0);
  return Date.parse(`${datetime.replace(' ', 'T')}Z`) + barMs;
}

const cacheKey = (symbol, kind) => `${CACHE_PREFIX}${symbol}:${kind}`;

export function cachedSeries(symbol, kind) {
  return store.load(cacheKey(symbol, kind), null);
}

// Returns {at, points:[[t, close]]} — fresh if possible, otherwise the cached
// copy (possibly null). Throws only for real API errors.
export async function loadSeries(symbol, kind, key, maxAgeMs) {
  const entry = cachedSeries(symbol, kind);
  const now = Date.now();
  if (entry && now - entry.at < maxAgeMs) return entry;
  if (!key || inBotWindow(now) || !takeCallBudget(now)) return entry;
  const { interval, outputsize, barMs } = SERIES[kind];
  const url =
    `${API}/time_series?symbol=${encodeURIComponent(toTwelve(symbol))}` +
    `&interval=${interval}&outputsize=${outputsize}&timezone=UTC&apikey=${encodeURIComponent(key)}`;
  let json;
  try {
    const res = await fetch(url);
    json = await res.json();
  } catch {
    throw new HistoryError('network', 'Keine Verbindung zu Twelve Data.');
  }
  if (json.status === 'error') {
    if (json.code === 401) throw new HistoryError('auth', 'Der Twelve-Data-Schlüssel ist ungültig.');
    if (json.code === 429) throw new HistoryError('rate', 'Twelve-Data-Limit erreicht, der Kursverlauf kommt später.');
    throw new HistoryError('http', json.message || 'Twelve Data meldet einen Fehler.');
  }
  const points = (json.values || [])
    .map((v) => [barTime(v.datetime, barMs), Number(v.close)])
    .filter(([t, p]) => Number.isFinite(t) && Number.isFinite(p))
    .sort((a, b) => a[0] - b[0]);
  const fresh = { at: now, points };
  store.save(cacheKey(symbol, kind), fresh);
  return fresh;
}

// Drops cached series that have not been refreshed for a week.
export function pruneSeriesCache(now = Date.now()) {
  for (const key of store.keysWithPrefix(CACHE_PREFIX)) {
    const entry = store.load(key, null);
    if (!entry || now - entry.at > 7 * 24 * 3600_000) store.remove(key);
  }
}

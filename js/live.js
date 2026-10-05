// Real-time prices from Finnhub: REST for quotes and company profiles, a
// WebSocket for every trade while the US market is open.

const REST = 'https://finnhub.io/api/v1';
const SOCKET = 'wss://ws.finnhub.io';

export class FeedError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// Finnhub writes share classes with a dot (BRK.B), the bot with a dash (BRK-B).
export const toFinnhub = (symbol) => symbol.replace(/-/g, '.');

async function getJson(path, key) {
  const sep = path.includes('?') ? '&' : '?';
  let res;
  try {
    res = await fetch(`${REST}${path}${sep}token=${encodeURIComponent(key)}`);
  } catch {
    throw new FeedError('network', 'Keine Verbindung zu Finnhub.');
  }
  if (res.status === 401 || res.status === 403) throw new FeedError('auth', 'Der Finnhub-Schlüssel ist ungültig.');
  if (res.status === 429) throw new FeedError('rate', 'Finnhub-Abrufgrenze erreicht, gleich geht es weiter.');
  if (!res.ok) throw new FeedError('http', `Finnhub antwortet mit Fehler ${res.status}.`);
  return res.json();
}

export async function fetchQuote(symbol, key) {
  const q = await getJson(`/quote?symbol=${encodeURIComponent(toFinnhub(symbol))}`, key);
  // Unknown symbols come back as all zeros.
  if (!q || !q.c) return null;
  return {
    price: q.c,
    prevClose: q.pc || null,
    open: q.o || null,
    high: q.h || null,
    low: q.l || null,
    ts: (q.t || 0) * 1000,
  };
}

export async function fetchProfile(symbol, key) {
  const p = await getJson(`/stock/profile2?symbol=${encodeURIComponent(toFinnhub(symbol))}`, key);
  if (!p || !p.name) return null;
  return { name: p.name, logo: p.logo || '', industry: p.finnhubIndustry || '' };
}

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

// Streams trades for a set of symbols and reconnects with backoff.
// onTrades receives a Map(symbol -> {price, t}) with the latest trade per symbol.
export class TradeStream {
  constructor({ key, onTrades, onStatus }) {
    this.key = key;
    this.onTrades = onTrades;
    this.onStatus = onStatus;
    this.symbols = new Map(); // Finnhub symbol -> bot symbol
    this.ws = null;
    this.attempt = 0;
    this.timer = null;
    this.running = false;
  }

  setSymbols(list) {
    const next = new Map(list.map((s) => [toFinnhub(s), s]));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      for (const fs of this.symbols.keys()) {
        if (!next.has(fs)) this.send({ type: 'unsubscribe', symbol: fs });
      }
      for (const fs of next.keys()) {
        if (!this.symbols.has(fs)) this.send({ type: 'subscribe', symbol: fs });
      }
    }
    this.symbols = next;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.onStatus('off');
  }

  send(msg) {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // the close handler reconnects
    }
  }

  connect() {
    this.onStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(`${SOCKET}?token=${encodeURIComponent(this.key)}`);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      for (const fs of this.symbols.keys()) this.send({ type: 'subscribe', symbol: fs });
      this.onStatus('connected');
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'trade' && Array.isArray(msg.data)) {
        const latest = new Map();
        for (const trade of msg.data) {
          const symbol = this.symbols.get(trade.s);
          if (!symbol || !(trade.p > 0)) continue;
          const prev = latest.get(symbol);
          if (!prev || trade.t >= prev.t) latest.set(symbol, { price: trade.p, t: trade.t });
        }
        if (latest.size) this.onTrades(latest);
      } else if (msg.type === 'error') {
        this.onStatus('error', msg.msg || 'Finnhub meldet einen Fehler.');
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.running) this.retry();
    };
  }

  retry() {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.onStatus('connecting');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.running && this.connect(), delay);
  }
}

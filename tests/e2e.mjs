// Browser test: serves the app, mocks GitHub, Finnhub (REST + WebSocket) and
// Twelve Data, then drives an iPhone-sized Chromium through the main views.
//
//   node tests/e2e.mjs                  # synthetic fixtures in tests/fixtures
//   FIXTURES=/path SHOTS=/out node tests/e2e.mjs
//
// Needs Playwright (`npm i -D playwright`, or NODE_PATH pointing at a global install).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { marketStatus } from '../js/market.js';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = process.env.FIXTURES || path.join(ROOT, 'tests', 'fixtures');
const SHOTS = process.env.SHOTS || path.join(ROOT, 'tests', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const quotes = JSON.parse(fixture('quotes.json'));
const OPEN_TIME = Date.parse('2026-10-05T17:00:00Z'); // Monday, 13:00 in New York
const SUNDAY_TIME = Date.parse('2026-10-04T15:00:00Z');

// --- static server -----------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, resolve));
const BASE = `http://localhost:${server.address().port}/`;

// --- market data mocks ----------------------------------------------------------
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}
const pad = (n) => String(n).padStart(2, '0');
const utcStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
};

// Like Twelve Data: the bars of the current session, or of the last one when closed.
function intradayBars(symbol, now) {
  const q = quotes[symbol];
  const rand = rng(symbol.charCodeAt(0) * 97);
  const { open, close } = marketStatus(now).session;
  const values = [];
  let price = q.o;
  const steps = Math.max(1, Math.floor((Math.min(now, close) - open) / 300_000));
  for (let i = 0; i < steps; i++) {
    const target = q.o + ((q.c - q.o) * (i + 1)) / steps;
    price = target + (rand() - 0.5) * q.c * 0.006;
    values.push({ datetime: utcStamp(open + i * 300_000), close: price.toFixed(4) });
  }
  return values.reverse();
}

function dailyBars(symbol) {
  const q = quotes[symbol];
  const rand = rng(symbol.charCodeAt(0) * 31);
  const days = [];
  for (let d = new Date(Date.UTC(2026, 9, 2)); days.length < 300; d.setUTCDate(d.getUTCDate() - 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(d.toISOString().slice(0, 10));
  }
  days.reverse();
  let price = q.gap ? q.gap.from * 0.82 : q.pc * 0.9;
  return days
    .map((day) => {
      if (q.gap && day === q.gap.date) price = q.gap.to;
      else if (q.gap && day < q.gap.date) price = Math.max(1, price * (1 + (rand() - 0.47) * 0.025));
      else price = price * (1 + (rand() - 0.5) * 0.02);
      if (day === '2026-10-02') price = q.pc;
      return { datetime: day, close: price.toFixed(4) };
    })
    .reverse();
}

function weekBars(symbol, now) {
  const q = quotes[symbol];
  const rand = rng(symbol.charCodeAt(0) * 13);
  const values = [];
  let price = q.pc * 0.98;
  for (let t = Date.parse('2026-09-28T13:30:00Z'); t < now; t += 1_800_000) {
    const hourUtc = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6 || hourUtc < 13.5 || hourUtc >= 20) continue;
    price = price * (1 + (rand() - 0.5) * 0.008);
    values.push({ datetime: utcStamp(t), close: price.toFixed(4) });
  }
  return values.reverse();
}

const logoSvg = (symbol) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#1b5e9e"/>` +
  `<text x="32" y="41" font-family="Arial" font-size="24" font-weight="700" fill="#fff" text-anchor="middle">${symbol[0]}</text></svg>`;

async function mockApis(context, { github = 'ok', now = OPEN_TIME } = {}) {
  await context.route('https://api.github.com/**', (route) => {
    const url = new URL(route.request().url());
    if (github === 'unauthorized') return route.fulfill({ status: 401, body: '{}' });
    if (url.pathname.endsWith('/commits')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ sha: 'fixture', commit: { message: 'Run scheduled daily routine', committer: { date: '2026-10-02T22:50:27Z' } } }]),
      });
    }
    const file = decodeURIComponent(url.pathname.split('/contents/')[1] || '');
    const local = { 'data/portfolio.json': 'portfolio.json', 'data/trade_log.csv': 'trade_log.csv', 'data/weights.json': 'weights.json', 'data/last_candidates.json': 'last_candidates.json', 'data/last_blocked_signals.json': 'last_blocked_signals.json', 'config.py': 'config.py' }[file];
    if (!local || !fs.existsSync(path.join(FIXTURES, local))) return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({ body: fixture(local) });
  });
  await context.route('https://finnhub.io/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const symbol = (url.searchParams.get('symbol') || '').replace('.', '-');
    const q = quotes[symbol];
    if (url.pathname.endsWith('/quote')) {
      const body = q ? { c: q.c, pc: q.pc, o: q.o, h: q.c * 1.01, l: q.o * 0.99, t: Math.floor(now / 1000) - 60 } : { c: 0, pc: 0 };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.pathname.endsWith('/stock/profile2')) {
      const body = q ? { name: q.name, logo: `https://static2.finnhub.io/logo/${symbol}.png`, finnhubIndustry: q.industry } : {};
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await context.route('https://static2.finnhub.io/**', (route) => {
    const symbol = path.basename(new URL(route.request().url()).pathname, '.png');
    return route.fulfill({ contentType: 'image/svg+xml', body: logoSvg(symbol) });
  });
  await context.route('https://api.twelvedata.com/**', (route) => {
    const url = new URL(route.request().url());
    const symbol = (url.searchParams.get('symbol') || '').replace('.', '-');
    const interval = url.searchParams.get('interval');
    if (!quotes[symbol]) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'error', code: 400, message: 'unknown' }) });
    const values = interval === '5min' ? intradayBars(symbol, now) : interval === '30min' ? weekBars(symbol, now) : dailyBars(symbol);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'ok', values }) });
  });
  await context.routeWebSocket(/ws\.finnhub\.io/, (ws) => {
    const subs = new Set();
    const last = {};
    ws.onMessage((message) => {
      const msg = JSON.parse(message);
      if (msg.type === 'subscribe') subs.add(msg.symbol);
      if (msg.type === 'unsubscribe') subs.delete(msg.symbol);
    });
    let tick = 0;
    const timer = setInterval(() => {
      tick++;
      const data = [...subs].map((s) => {
        const q = quotes[s.replace('.', '-')];
        if (!q) return null;
        last[s] = (last[s] ?? q.c) * (1 + Math.sin(tick + s.length) * 0.0015);
        return { s, p: Number(last[s].toFixed(4)), t: now + tick * 400, v: 100 };
      }).filter(Boolean);
      if (data.length) ws.send(JSON.stringify({ type: 'trade', data }));
    }, 400);
    ws.onClose(() => clearInterval(timer));
  });
}

// --- driver ------------------------------------------------------------------
const browser = await chromium.launch();
const errors = [];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const settings = { githubToken: 'test-token', finnhubKey: 'test-key', twelveKey: 'test-key', setupDone: true };
const num = (text) => Number(text.replace(/[^\d,−-]/g, '').replace(/\./g, '').replace(',', '.').replace('−', '-'));

async function newPage({ scheme = 'dark', withSettings = true, now = OPEN_TIME, github = 'ok' } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  });
  await mockApis(context, { now, github });
  if (withSettings) {
    await context.addInitScript((s) => localStorage.setItem('depot.settings.v1', JSON.stringify(s)), settings);
  }
  const page = await context.newPage();
  await page.clock.install({ time: now });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  return { context, page };
}

try {
  // Home, dark, market open with live ticks.
  {
    const { context, page } = await newPage();
    await page.goto(BASE);
    await page.waitForSelector('.pill[data-tone="live"]', { timeout: 10_000 });
    await page.waitForTimeout(2500);
    const hero = await page.textContent('[data-live="depot-value"]');
    const cash = num(await page.textContent('.cash-row .row-value'));
    const values = await page.$$eval('[data-live^="pos-value:"]', (els) => els.map((e) => e.textContent));
    const sum = values.map(num).reduce((a, b) => a + b, cash);
    check('depot value = cash + positions', Math.abs(num(hero) - sum) <= 0.011 * (values.length + 1), `${hero} vs ${sum.toFixed(2)}`);
    check('change line shows "Heute"', (await page.textContent('[data-live="depot-label"]')) === 'Heute');
    check('chart drawn', (await page.$$('#main-chart path.chart-line')).length === 1);
    await page.screenshot({ path: path.join(SHOTS, 'home-dark.png'), fullPage: true });

    const box = await (await page.$('#main-chart svg')).boundingBox();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.waitForTimeout(100);
    const scrubLabel = await page.textContent('[data-live="depot-label"]');
    check('scrubbing shows the time under the pointer', /Uhr/.test(scrubLabel), scrubLabel);
    await page.screenshot({ path: path.join(SHOTS, 'home-scrub-dark.png'), clip: { x: 0, y: 0, width: 390, height: 420 } });
    await page.mouse.move(box.x + box.width / 2, box.y - 150);
    await page.waitForTimeout(400);
    check('leaving the chart restores the live value', (await page.textContent('[data-live="depot-label"]')) === 'Heute');

    await page.click('[data-range="1W"]');
    await page.waitForTimeout(400);
    check('range 1W labelled', (await page.textContent('[data-live="depot-label"]')) === '1 Woche');
    await page.screenshot({ path: path.join(SHOTS, 'home-1w-dark.png'), clip: { x: 0, y: 0, width: 390, height: 420 } });

    const firstRow = await page.$('.section .rows a.row');
    if (firstRow) {
      await firstRow.click();
      await page.waitForSelector('[data-live="d-price"]');
      await page.waitForTimeout(1500);
      check('detail shows a price', /\$/.test(await page.textContent('[data-live="d-price"]')));
      await page.screenshot({ path: path.join(SHOTS, 'detail-dark.png'), fullPage: true });
      await page.click('[data-detail-range="MAX"]');
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(SHOTS, 'detail-max-dark.png'), clip: { x: 0, y: 0, width: 390, height: 520 } });
      await page.click('[data-action="back"]');
      await page.waitForSelector('[data-live="depot-value"]');
      check('back returns home', true);
    }
    await context.close();
  }

  // Light theme.
  {
    const { context, page } = await newPage({ scheme: 'light' });
    await page.goto(BASE);
    await page.waitForSelector('.pill[data-tone="live"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, 'home-light.png'), fullPage: true });
    const firstRow = await page.$('.section .rows a.row');
    if (firstRow) {
      await firstRow.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(SHOTS, 'detail-light.png'), fullPage: true });
    }
    await page.goto(`${BASE}#/einstellungen`);
    await page.waitForSelector('#settings-form');
    await page.screenshot({ path: path.join(SHOTS, 'settings-light.png'), fullPage: true });
    await context.close();
  }

  // Sunday: market closed, no socket.
  {
    const { context, page } = await newPage({ now: SUNDAY_TIME });
    await page.goto(BASE);
    await page.waitForSelector('[data-live="depot-value"]');
    await page.waitForTimeout(1500);
    const pill = await page.textContent('.pill');
    check('closed market pill', pill === 'Börse zu', pill);
    const label = await page.textContent('[data-live="depot-label"]');
    check('1T on Sunday shows Friday', /Fr\./.test(label), label);
    await page.screenshot({ path: path.join(SHOTS, 'home-closed-dark.png'), fullPage: true });
    await context.close();
  }

  // First start without keys.
  {
    const { context, page } = await newPage({ withSettings: false });
    await page.goto(BASE);
    await page.waitForSelector('.welcome');
    await page.screenshot({ path: path.join(SHOTS, 'welcome-dark.png'), fullPage: true });
    await page.click('text=Jetzt einrichten');
    await page.waitForSelector('#settings-form');
    await page.fill('#set-github', 'abc');
    await page.fill('#set-finnhub', 'def');
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-live="depot-value"]', { timeout: 10_000 });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('depot.settings.v1')));
    check('settings are saved on the device', stored.githubToken === 'abc' && stored.finnhubKey === 'def');
    await context.close();
  }

  // Wrong GitHub token.
  {
    const { context, page } = await newPage({ github: 'unauthorized' });
    await page.goto(BASE);
    await page.waitForSelector('.notice-error');
    check('invalid token explained', /Token ist ungültig/.test(await page.textContent('.notice-error')));
    await page.screenshot({ path: path.join(SHOTS, 'error-dark.png'), fullPage: true });
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

// Failed requests are logged by the browser too; the 401 scenario provokes one on purpose.
const appErrors = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
check('no script errors', appErrors.length === 0, appErrors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);

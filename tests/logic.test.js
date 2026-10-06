import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRules,
  positionValue,
  pnlEur,
  equity,
  stopDistancePct,
  dedupeHistory,
  findPriceGap,
  projectedStop,
  stopHasTrailed,
  DEFAULT_RULES,
} from '../js/portfolio.js';
import { marketStatus, nyTime, isTradingDay, previousTradingDay } from '../js/market.js';
import { parseCsv } from '../js/csv.js';
import * as fmt from '../js/format.js';
import { inBotWindow } from '../js/history.js';
import { loadBotData } from '../js/github.js';

const long = {
  symbol: 'XYZ',
  direction: 'LONG',
  entry_price: 20,
  entry_date: '2026-10-01',
  size_eur: 1000,
  stop_loss_price: 18.4,
};

test('position value matches the bot: 2x leverage on the price return', () => {
  // -5 % on the price is -10 % on the stake with 2x leverage.
  assert.equal(positionValue(long, 19, 2), 900);
  assert.equal(equity(4000, [long], () => 19, 2), 4900);
});

test('short positions gain when the price falls', () => {
  const short = { ...long, direction: 'SHORT', entry_price: 100, stop_loss_price: 108 };
  assert.equal(pnlEur(short, 95, 2), 100);
  assert.equal(pnlEur(short, 105, 2), -100);
});

test('losses are floored at the full stake like the bot margin call', () => {
  assert.equal(pnlEur(long, 0.01, 2), -1000);
  assert.equal(positionValue(long, 0.01, 2), 0);
});

test('stop distance is positive while the stop is not reached', () => {
  assert.ok(Math.abs(stopDistancePct(long, 19) - 3.16) < 0.01);
  assert.ok(stopDistancePct(long, 18) < 0);
  const short = { ...long, direction: 'SHORT', entry_price: 100, stop_loss_price: 108 };
  assert.ok(stopDistancePct(short, 100) > 0);
  assert.ok(stopDistancePct(short, 110) < 0);
});

test('equity history keeps the last entry per date', () => {
  const h = dedupeHistory([
    { date: '2026-09-16', equity: 5000 },
    { date: '2026-09-16', equity: 5001 },
    { date: '2026-09-15', equity: 4999 },
  ]);
  assert.deepEqual(h.map((e) => e.equity), [4999, 5001]);
});

test('rules are read from config.py with defaults for the rest', () => {
  const rules = parseRules('LEVERAGE = 3.0\nMIN_SCORE_TO_TRADE = 40.0  # comment\nMAX_HOLDING_DAYS = 15\n');
  assert.equal(rules.leverage, 3);
  assert.equal(rules.minScore, 40);
  assert.equal(rules.maxHoldingDays, 15);
  assert.equal(rules.stopLossPct, DEFAULT_RULES.stopLossPct);
  assert.equal(rules.trailingStopPct, null, 'older bot versions have no trailing stop');
  assert.equal(parseRules('TRAILING_STOP_PCT = 8.0\nCORPORATE_ACTION_GAP_PCT = 30.0\n').trailingStopPct, 8);
});

test('trailing stop projection follows the bot: up for longs, down for shorts, never back', () => {
  const pos = { ...long, best_close: 22, stop_loss_price: 20.24, initial_stop_price: 18.4 };
  assert.ok(Math.abs(projectedStop(pos, 25, 8) - 23) < 1e-9);
  assert.ok(Math.abs(projectedStop(pos, 21, 8) - 20.24) < 1e-9, 'a lower price keeps the stop');
  assert.equal(projectedStop(pos, 25, null), 20.24, 'without a trailing stop nothing moves');
  assert.equal(stopHasTrailed(pos), true);
  assert.equal(stopHasTrailed({ ...long, initial_stop_price: 18.4 }), false);
  const short = { ...long, direction: 'SHORT', entry_price: 100, stop_loss_price: 108, initial_stop_price: 108 };
  assert.ok(Math.abs(projectedStop(short, 90, 8) - 97.2) < 1e-9);
  assert.equal(projectedStop(short, 105, 8), 108);
});

test('a one-day jump of 84 % is flagged as a likely corporate action', () => {
  const gap = findPriceGap([
    [1, 76.9],
    [2, 77.65],
    [3, 12.56],
    [4, 11.92],
  ]);
  assert.ok(gap);
  assert.equal(gap.t, 3);
  assert.ok(gap.r < -0.8);
  assert.equal(findPriceGap([[1, 10], [2, 10.5], [3, 9.8]]), null);
});

test('New York wall clock converts across daylight saving time', () => {
  assert.equal(nyTime('2026-10-05', 9, 30), Date.parse('2026-10-05T13:30:00Z'));
  assert.equal(nyTime('2026-10-05', 16, 0), Date.parse('2026-10-05T20:00:00Z'));
  assert.equal(nyTime('2026-11-02', 9, 30), Date.parse('2026-11-02T14:30:00Z'));
  assert.equal(nyTime('2027-03-15', 9, 30), Date.parse('2027-03-15T13:30:00Z'));
});

test('market status: open, pre-market, after-hours, weekend, holiday, early close', () => {
  let s = marketStatus(Date.parse('2026-10-05T17:00:00Z'));
  assert.equal(s.state, 'open');
  assert.equal(s.session.date, '2026-10-05');

  s = marketStatus(Date.parse('2026-10-05T12:00:00Z'));
  assert.equal(s.state, 'pre');
  assert.equal(s.session.date, '2026-10-02');

  s = marketStatus(Date.parse('2026-10-05T21:00:00Z'));
  assert.equal(s.state, 'post');
  assert.equal(s.session.date, '2026-10-05');

  s = marketStatus(Date.parse('2026-10-04T15:00:00Z'));
  assert.equal(s.state, 'closed');
  assert.equal(s.session.date, '2026-10-02');

  s = marketStatus(Date.parse('2026-11-26T16:00:00Z'));
  assert.equal(s.state, 'closed');
  assert.equal(s.session.date, '2026-11-25');

  s = marketStatus(Date.parse('2026-11-27T19:00:00Z'));
  assert.equal(s.state, 'post');
  assert.equal(s.session.close, Date.parse('2026-11-27T18:00:00Z'));

  assert.equal(isTradingDay('2026-07-03'), false);
  assert.equal(previousTradingDay('2026-10-05'), '2026-10-02');
});

test('CSV parser handles empty and quoted fields', () => {
  const rows = parseCsv('a,b,c\n1,,"x, y"\r\n2,"he said ""hi""",\n');
  assert.deepEqual(rows, [
    { a: '1', b: '', c: 'x, y' },
    { a: '2', b: 'he said "hi"', c: '' },
  ]);
});

test('German formatting with arrows instead of colour alone', () => {
  assert.equal(fmt.eur(4321.09).replace(/\s/g, ' '), '4.321,09 €');
  assert.equal(fmt.eur(-103.82).replace(/\s/g, ' '), '−103,82 €');
  const c = fmt.change(-103.82, -2.08);
  assert.equal(c.dir, 'down');
  assert.equal(c.text.replace(/\s/g, ' '), '▼ 103,82 € (2,08 %)');
  assert.equal(fmt.change(0.001, 0).dir, 'flat');
  assert.equal(fmt.signedPct(-83.8, 1).replace(/\s/g, ' '), '−83,8 %');
  assert.equal(fmt.dayLong('2026-10-01'), '1. Okt. 2026');
});

test('history calls pause while the bot runs on weekday nights', () => {
  assert.equal(inBotWindow(Date.parse('2026-10-05T21:50:00Z')), true);
  assert.equal(inBotWindow(Date.parse('2026-10-05T23:20:00Z')), false);
  assert.equal(inBotWindow(Date.parse('2026-10-03T21:50:00Z')), false);
  assert.equal(inBotWindow(Date.parse('2026-10-05T15:00:00Z')), false);
});

test('bot data loads from the branch head and maps API errors to German messages', async () => {
  const files = {
    'data/portfolio.json': JSON.stringify({ cash: 4000, starting_capital: 5000, open_positions: [long], closed_trades_count: 0, equity_history: [] }),
    'data/trade_log.csv': 'trade_id,symbol,direction,entry_date,entry_price,score,size_eur,status\nXYZ_x,XYZ,LONG,2026-10-01,20.0,43.1,1000.0,OPEN\n',
    'data/weights.json': JSON.stringify({ weights: { macd: 50, bbands: 50 }, meta: {} }),
    'data/last_candidates.json': '[]',
    'config.py': 'LEVERAGE = 2.0\n',
  };
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, auth: opts?.headers?.Authorization });
    const u = new URL(url);
    if (u.pathname.endsWith('/commits')) {
      return new Response(JSON.stringify([{ sha: 'abc', commit: { message: 'Run\n\nbody', committer: { date: '2026-10-02T22:50:27Z' } } }]));
    }
    const path = decodeURIComponent(u.pathname.split('/contents/')[1]);
    assert.equal(u.searchParams.get('ref'), 'abc');
    return files[path] ? new Response(files[path]) : new Response('', { status: 404 });
  };
  const cfg = { repo: 'me/Aktien', branch: 'claude/bot', githubToken: 'tok' };
  const data = await loadBotData(cfg);
  assert.equal(data.commit.message, 'Run');
  assert.equal(data.portfolio.cash, 4000);
  assert.equal(data.trades[0].score, 43.1);
  assert.equal(data.trades[0].exitDate, null);
  assert.equal(data.rules.leverage, 2);
  assert.ok(seen.every((r) => r.auth === 'Bearer tok'));
  assert.ok(seen[0].url.includes('sha=claude%2Fbot'));

  assert.equal(await loadBotData(cfg, 'abc'), null, 'unchanged head skips the download');

  globalThis.fetch = async () => new Response('', { status: 401 });
  await assert.rejects(loadBotData(cfg), /Token ist ungültig/);
  // A private repo the token cannot see and a missing branch both come back as 404.
  globalThis.fetch = async () => new Response('', { status: 404 });
  await assert.rejects(loadBotData(cfg), /keinen Zugriff auf me\/Aktien/);
  globalThis.fetch = async (url) =>
    new URL(url).pathname === '/repos/me/Aktien' ? new Response('{}') : new Response('', { status: 404 });
  await assert.rejects(loadBotData(cfg), /Branch „claude\/bot“ gibt es/);
});

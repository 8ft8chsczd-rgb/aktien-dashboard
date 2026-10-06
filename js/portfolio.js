// Mirrors the bot's bookkeeping (src/portfolio.py), so live values line up
// with what the bot records at the next close.

export const DEFAULT_RULES = {
  leverage: 2,
  stopLossPct: 8,
  maxHoldingDays: 15,
  rsiExit: 50,
  minScore: 40,
  maxPositions: 5,
  tradeWindowMin: 5,
  rsiOverbought: 80,
  rsiOversold: 20,
  startingCapital: 5000,
  minWeight: 5,
  maxWeight: 35,
  // Absent in bot versions without these features.
  trailingStopPct: null,
  gapPct: null,
  gapLookbackDays: null,
};

const CONFIG_NAMES = {
  leverage: 'LEVERAGE',
  stopLossPct: 'STOP_LOSS_PCT',
  maxHoldingDays: 'MAX_HOLDING_DAYS',
  rsiExit: 'RSI_EXIT_LEVEL',
  minScore: 'MIN_SCORE_TO_TRADE',
  maxPositions: 'MAX_OPEN_POSITIONS',
  tradeWindowMin: 'TRADE_WINDOW_MIN',
  rsiOverbought: 'RSI_OVERBOUGHT',
  rsiOversold: 'RSI_OVERSOLD',
  startingCapital: 'STARTING_CAPITAL',
  minWeight: 'MIN_WEIGHT',
  maxWeight: 'MAX_WEIGHT',
  trailingStopPct: 'TRAILING_STOP_PCT',
  gapPct: 'CORPORATE_ACTION_GAP_PCT',
  gapLookbackDays: 'CORPORATE_ACTION_LOOKBACK_DAYS',
};

// Reads plain `NAME = 1.5` assignments from the bot's config.py; anything
// missing keeps its default.
export function parseRules(configPy = '') {
  const rules = { ...DEFAULT_RULES };
  for (const [key, name] of Object.entries(CONFIG_NAMES)) {
    const match = configPy.match(new RegExp(`^${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, 'm'));
    if (match) rules[key] = Number(match[1]);
  }
  return rules;
}

export function priceReturn(pos, price) {
  const r = (price - pos.entry_price) / pos.entry_price;
  return pos.direction === 'SHORT' ? -r : r;
}

// Leveraged result in EUR, floored at a total loss like the bot's simulated margin call.
export function pnlEur(pos, price, leverage) {
  return pos.size_eur * Math.max(-1, priceReturn(pos, price) * leverage);
}

export const positionValue = (pos, price, leverage) => pos.size_eur + pnlEur(pos, price, leverage);

export function equity(cash, positions, priceOf, leverage) {
  return positions.reduce((sum, pos) => sum + positionValue(pos, priceOf(pos), leverage), cash);
}

// Where the bot's trailing stop will stand after today's close if the price
// closes here: it follows the best close since entry and never moves back.
export function projectedStop(pos, price, trailingPct) {
  if (!trailingPct || price == null) return pos.stop_loss_price;
  const trail = trailingPct / 100;
  const best = pos.best_close ?? pos.entry_price;
  if (pos.direction === 'SHORT') return Math.min(pos.stop_loss_price, Math.min(best, price) * (1 + trail));
  return Math.max(pos.stop_loss_price, Math.max(best, price) * (1 - trail));
}

// True once the trailing stop has moved away from its starting level.
export function stopHasTrailed(pos) {
  const initial = pos.initial_stop_price;
  if (initial == null) return false;
  return pos.direction === 'SHORT' ? pos.stop_loss_price < initial - 1e-9 : pos.stop_loss_price > initial + 1e-9;
}

// How far the price can still move against the position before the stop
// triggers, in percent of the current price. Negative means it is through.
export function stopDistancePct(pos, price) {
  const d = ((price - pos.stop_loss_price) / price) * 100;
  return pos.direction === 'SHORT' ? -d : d;
}

// equity_history can hold a date twice (setup and first run on the same
// day); the later entry wins.
export function dedupeHistory(history = []) {
  const byDate = new Map();
  for (const entry of history) byDate.set(entry.date, entry);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Largest single-day jump in a daily close series, if it looks like a
// corporate action (spin-off, split) rather than normal trading.
export function findPriceGap(points, threshold = 0.35) {
  let found = null;
  for (let i = 1; i < points.length; i++) {
    const [t, price] = points[i];
    const prev = points[i - 1][1];
    if (!prev) continue;
    const r = price / prev - 1;
    if (Math.abs(r) >= threshold && (!found || t > found.t)) found = { t, r, from: prev, to: price };
  }
  return found;
}

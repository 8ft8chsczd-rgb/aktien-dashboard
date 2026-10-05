// German number and date formatting used across the app.

const MINUS = '−';

const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const usdFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD' });
const pctFmt = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numFmts = new Map();

function numFmt(digits) {
  if (!numFmts.has(digits)) {
    numFmts.set(digits, new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  return numFmts.get(digits);
}

const typographicMinus = (s) => s.replace('-', MINUS);

export const eur = (v) => typographicMinus(eurFmt.format(v));
export const usd = (v) => typographicMinus(usdFmt.format(v));
export const num = (v, digits = 1) => typographicMinus(numFmt(digits).format(v));
export const absEur = (v) => eurFmt.format(Math.abs(v));
export const absUsd = (v) => usdFmt.format(Math.abs(v));
export const absPct = (v) => `${pctFmt.format(Math.abs(v))} %`;
export const signedPct = (v, digits = 2) =>
  `${v > 0 ? '+' : v < 0 ? MINUS : '±'}${numFmt(digits).format(Math.abs(v))} %`;

// Direction of a change as it will be displayed (rounded to cents), so a
// change that shows as "0,00" is never coloured as a gain or loss.
export function trend(value) {
  const rounded = Math.round(value * 100) / 100;
  if (rounded > 0) return 'up';
  if (rounded < 0) return 'down';
  return 'flat';
}

export const ARROWS = { up: '▲', down: '▼', flat: '' };

// "▲ 12,34 € (1,23 %)" — the arrow carries the sign so colour is never the only cue.
export function change(abs, pct, money = absEur) {
  const dir = trend(abs);
  const arrow = ARROWS[dir] ? `${ARROWS[dir]} ` : '';
  const pctText = pct == null || !Number.isFinite(pct) ? '' : ` (${absPct(pct)})`;
  const word = dir === 'up' ? 'plus' : dir === 'down' ? 'minus' : '';
  return { dir, text: `${arrow}${money(abs)}${pctText}`, label: `${word} ${money(abs)}${pctText}`.trim() };
}

export function pctChange(pct) {
  const dir = trend(pct);
  const arrow = ARROWS[dir] ? `${ARROWS[dir]} ` : '';
  return { dir, text: `${arrow}${absPct(pct)}` };
}

// Calendar dates ('YYYY-MM-DD') are formatted at noon UTC so the day never shifts.
const dayLongFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayShortFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayWeekdayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayNumericFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

const atNoon = (isoDate) => new Date(`${isoDate}T12:00:00Z`);

export const dayLong = (isoDate) => dayLongFmt.format(atNoon(isoDate));
export const dayShort = (isoDate) => dayShortFmt.format(atNoon(isoDate));
// Drops the year for dates in the current year: "28. Sept." / "28. Sept. 2025".
export const dayCompact = (isoDate, now = Date.now()) =>
  isoDate.slice(0, 4) === String(new Date(now).getFullYear()) ? dayShort(isoDate) : dayLong(isoDate);
export const dayWeekday = (isoDate) => dayWeekdayFmt.format(atNoon(isoDate));
export const dayNumeric = (isoDate) => dayNumericFmt.format(atNoon(isoDate));

// Timestamps are shown in the viewer's own time zone.
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const stampFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dateOnlyFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

const monthYearFmt = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });

export const time = (ms) => `${timeFmt.format(new Date(ms))} Uhr`;
export const monthYear = (ms) => monthYearFmt.format(new Date(ms));
export const stamp = (ms) => `${stampFmt.format(new Date(ms))} Uhr`;
export const dateOnly = (ms) => dateOnlyFmt.format(new Date(ms));

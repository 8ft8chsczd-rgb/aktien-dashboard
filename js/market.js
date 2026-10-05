// US stock market calendar (NYSE/Nasdaq regular session) in New York time.

const TZ = 'America/New_York';

// Full-day closures, from the NYSE holiday calendar. Extend once a year.
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// Sessions that end at 13:00 instead of 16:00.
const EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function nyParts(ms) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
  };
}

export const nyDate = (ms) => nyParts(ms).date;

// Epoch milliseconds of a New York wall-clock time on a calendar date.
export function nyTime(date, hour, minute = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  let ts = wall;
  // Two passes settle the UTC offset, including on daylight-saving switch days.
  for (let i = 0; i < 2; i++) {
    const p = nyParts(ts);
    const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ts;
    ts = wall - offset;
  }
  return ts;
}

export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function isTradingDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(date);
}

export function previousTradingDay(date) {
  let day = addDays(date, -1);
  while (!isTradingDay(day)) day = addDays(day, -1);
  return day;
}

export function sessionBounds(date) {
  return {
    date,
    open: nyTime(date, 9, 30),
    close: nyTime(date, EARLY_CLOSES.has(date) ? 13 : 16, 0),
  };
}

// state: 'open' | 'pre' | 'post' | 'closed'
// session: the trading day the "1T" view shows — today once trading has
// started, otherwise the most recent completed session.
export function marketStatus(now = Date.now()) {
  const today = nyDate(now);
  const todaySession = isTradingDay(today) ? sessionBounds(today) : null;
  let state = 'closed';
  if (todaySession) {
    if (now >= todaySession.open && now < todaySession.close) state = 'open';
    else if (now >= nyTime(today, 4, 0) && now < todaySession.open) state = 'pre';
    else if (now >= todaySession.close && now < nyTime(today, 20, 0)) state = 'post';
  }
  const session = todaySession && now >= todaySession.open ? todaySession : sessionBounds(previousTradingDay(today));
  return { state, session, today };
}

// Reads the bot's data files from its GitHub branch. Works for a private
// repo with a fine-grained read-only token, or for a public repo without one.
import { parseCsv } from './csv.js';
import { parseRules } from './portfolio.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function headers(token, accept) {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function request(url, token, accept) {
  let res;
  try {
    res = await fetch(url, { headers: headers(token, accept), cache: 'no-store' });
  } catch {
    throw new GitHubError('network', 'Keine Verbindung zu GitHub.');
  }
  if (res.ok) return res;
  if (res.status === 401) {
    throw new GitHubError('auth', 'Das GitHub-Token ist ungültig oder abgelaufen.');
  }
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubError('rate', 'GitHub-Abrufgrenze erreicht. In ein paar Minuten klappt es wieder.');
    }
    throw new GitHubError('auth', 'Das GitHub-Token darf dieses Repo nicht lesen. Es braucht „Contents: Read-only“ für das Repo.');
  }
  if (res.status === 404) {
    throw new GitHubError('notfound', 'Repo oder Branch nicht gefunden. Prüfe Token, Repo und Branch in den Einstellungen.');
  }
  throw new GitHubError('http', `GitHub antwortet mit Fehler ${res.status}.`);
}

export async function latestCommit({ repo, branch, githubToken }) {
  const url = `${API}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`;
  const res = await request(url, githubToken, 'application/vnd.github+json');
  const [commit] = await res.json();
  if (!commit) throw new GitHubError('notfound', 'Der Branch hat noch keine Commits.');
  return {
    sha: commit.sha,
    date: commit.commit?.committer?.date || commit.commit?.author?.date || null,
    message: (commit.commit?.message || '').split('\n')[0],
  };
}

async function readFile(cfg, path, ref) {
  const url = `${API}/repos/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  try {
    const res = await request(url, cfg.githubToken, 'application/vnd.github.raw+json');
    return await res.text();
  } catch (err) {
    if (err.kind === 'notfound') return null;
    throw err;
  }
}

function parseJson(text, file) {
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubError('data', `${file} ist kein gültiges JSON.`);
  }
}

const num = (s) => (s === '' || s == null ? null : Number(s));

function toTrade(row) {
  return {
    id: row.trade_id,
    symbol: row.symbol,
    direction: row.direction,
    entryDate: row.entry_date,
    entryPrice: num(row.entry_price),
    rsiAtEntry: num(row.rsi_at_entry),
    confirmations: {
      macd: num(row.macd_confirm),
      bbands: num(row.bbands_confirm),
      stochastic: num(row.stochastic_confirm),
      volume_obv: num(row.volume_obv_confirm),
      atr_filter: num(row.atr_filter_confirm),
      trend_filter: num(row.trend_filter_confirm),
    },
    score: num(row.score),
    sizeEur: num(row.size_eur),
    exitDate: row.exit_date || null,
    exitPrice: num(row.exit_price),
    exitReason: row.exit_reason || null,
    rsiAtExit: num(row.rsi_at_exit),
    pnlPct: num(row.pnl_pct),
    pnlEur: num(row.pnl_eur),
    status: row.status,
  };
}

// Loads everything the app shows from the bot's branch. Pass the commit SHA
// you already have to skip the download when nothing changed (returns null).
export async function loadBotData(cfg, knownSha = null) {
  const commit = await latestCommit(cfg);
  if (knownSha && commit.sha === knownSha) return null;
  const [portfolio, trades, weights, candidates, configPy] = await Promise.all([
    readFile(cfg, 'data/portfolio.json', commit.sha),
    readFile(cfg, 'data/trade_log.csv', commit.sha),
    readFile(cfg, 'data/weights.json', commit.sha),
    readFile(cfg, 'data/last_candidates.json', commit.sha),
    readFile(cfg, 'config.py', commit.sha),
  ]);
  if (!portfolio) {
    throw new GitHubError('notfound', 'Im Branch fehlt data/portfolio.json. Stimmt der Branch in den Einstellungen?');
  }
  return {
    commit,
    portfolio: parseJson(portfolio, 'portfolio.json'),
    trades: trades ? parseCsv(trades).map(toTrade) : [],
    weights: weights ? parseJson(weights, 'weights.json') : null,
    candidates: candidates ? parseJson(candidates, 'last_candidates.json') : [],
    rules: parseRules(configPy || ''),
    loadedAt: Date.now(),
  };
}

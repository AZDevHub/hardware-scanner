/**
 * Hardware Scanner — Cloudflare Worker
 *
 * Cron-driven scanner that watches Reddit for matching hardware listings and
 * fires ntfy notifications. All knobs are exposed via the configuration UI
 * served at `/` and persisted in KV (`SCANNER_KV`).
 */

interface Env {
  SCANNER_KV: KVNamespace;
  /** Optional. When set, mutating API routes require `Authorization: Bearer <ADMIN_TOKEN>`. */
  ADMIN_TOKEN?: string;
}

// ---------- Config model ---------------------------------------------------

type Priority = 'min' | 'low' | 'default' | 'high' | 'max';
type MatchMode = 'any' | 'all';

interface Config {
  enabled: boolean;
  subreddits: string[];
  matching: {
    keywords: string[];
    mode: MatchMode;
    caseSensitive: boolean;
    excludeKeywords: string[];
    excludeWtb: boolean;
  };
  notifications: {
    enabled: boolean;
    ntfyUrl: string;
    title: string;
    priority: Priority;
    tags: string;
    clickThrough: boolean;
  };
  fetch: {
    limit: number;
    userAgent: string;
  };
  filters: {
    priceFilterEnabled: boolean;
    minPrice: number;
    maxPrice: number;
  };
  storage: {
    maxSeen: number;
  };
}

const DEFAULT_CONFIG: Config = {
  enabled: true,
  subreddits: ['hardwareswap', 'homelabsales', 'buildapcsales'],
  matching: {
    keywords: [
      'rtx pro 2000',
      'rtx pro 4000',
      'rtx pro 5000',
      'rtx pro 6000',
      'pro 2000 blackwell',
      'pro 4000 blackwell',
      'pro 5000 blackwell',
      'pro 6000 blackwell',
    ],
    mode: 'any',
    caseSensitive: false,
    excludeKeywords: [],
    excludeWtb: true,
  },
  notifications: {
    enabled: true,
    ntfyUrl: 'https://ntfy.alexzaw.dev/gpu-blackwell',
    title: '\u{1F5A5}\u{FE0F} RTX Pro Blackwell Listed',
    priority: 'high',
    tags: 'gpu,money_with_wings',
    clickThrough: true,
  },
  fetch: {
    limit: 25,
    userAgent: 'hardware-scanner-cf/1.0',
  },
  filters: {
    priceFilterEnabled: false,
    minPrice: 0,
    maxPrice: 0,
  },
  storage: {
    maxSeen: 1000,
  },
};

const KV_CONFIG = 'config';
const KV_SEEN = 'seen_posts';
const KV_STATUS = 'status';

// ---------- Reddit + scan logic --------------------------------------------

interface RedditPost {
  id: string;
  title: string;
  permalink: string;
  link_flair_text: string | null;
  subreddit_name_prefixed: string;
}

interface RedditResponse {
  data: { children: Array<{ data: RedditPost }> };
}

interface Match {
  title: string;
  url: string;
  sub: string;
  price: number | null;
  priceText: string | null;
  matchedAt: string;
}

interface Status {
  lastRunAt: string | null;
  lastRunDurationMs: number;
  lastRunMatchCount: number;
  totalRuns: number;
  totalMatches: number;
  lastError: string | null;
  recentMatches: Match[];
}

const DEFAULT_STATUS: Status = {
  lastRunAt: null,
  lastRunDurationMs: 0,
  lastRunMatchCount: 0,
  totalRuns: 0,
  totalMatches: 0,
  lastError: null,
  recentMatches: [],
};

function extractPrice(title: string): { value: number | null; text: string | null } {
  const m = title.match(/\$[\d,]+(?:\.\d{2})?/);
  if (!m) return { value: null, text: null };
  const value = Number(m[0].replace(/[$,]/g, ''));
  return { value: Number.isFinite(value) ? value : null, text: m[0] };
}

function matches(title: string, cfg: Config): boolean {
  const t = cfg.matching.caseSensitive ? title : title.toLowerCase();
  const norm = (s: string) => (cfg.matching.caseSensitive ? s : s.toLowerCase());

  const kws = cfg.matching.keywords.filter(Boolean);
  if (kws.length === 0) return false;

  const hit =
    cfg.matching.mode === 'all'
      ? kws.every((kw) => t.includes(norm(kw)))
      : kws.some((kw) => t.includes(norm(kw)));
  if (!hit) return false;

  if (cfg.matching.excludeKeywords.some((kw) => kw && t.includes(norm(kw)))) return false;
  if (cfg.matching.excludeWtb && /\b(wtb|want to buy)\b/i.test(title)) return false;

  return true;
}

async function loadConfig(env: Env): Promise<Config> {
  const raw = await env.SCANNER_KV.get(KV_CONFIG);
  if (!raw) return DEFAULT_CONFIG;
  try {
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function loadStatus(env: Env): Promise<Status> {
  const raw = await env.SCANNER_KV.get(KV_STATUS);
  if (!raw) return DEFAULT_STATUS;
  try {
    return { ...DEFAULT_STATUS, ...(JSON.parse(raw) as Partial<Status>) };
  } catch {
    return DEFAULT_STATUS;
  }
}

async function saveStatus(env: Env, s: Status): Promise<void> {
  await env.SCANNER_KV.put(KV_STATUS, JSON.stringify(s));
}

async function scan(env: Env): Promise<{ count: number; matches: Match[]; error?: string }> {
  const start = Date.now();
  const cfg = await loadConfig(env);
  const status = await loadStatus(env);

  if (!cfg.enabled) {
    const next: Status = {
      ...status,
      lastRunAt: new Date().toISOString(),
      lastRunDurationMs: Date.now() - start,
      lastRunMatchCount: 0,
      totalRuns: status.totalRuns + 1,
      lastError: 'scanner disabled',
    };
    await saveStatus(env, next);
    return { count: 0, matches: [] };
  }

  const seenRaw = await env.SCANNER_KV.get(KV_SEEN);
  const seen = new Set<string>(seenRaw ? (JSON.parse(seenRaw) as string[]) : []);
  const newSeen = new Set<string>(seen);
  const found: Match[] = [];
  let lastError: string | null = null;

  const limit = Math.max(1, Math.min(100, cfg.fetch.limit | 0));

  for (const sub of cfg.subreddits.filter(Boolean)) {
    let data: RedditResponse;
    try {
      const res = await fetch(
        `https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=${limit}&raw_json=1`,
        { headers: { 'User-Agent': cfg.fetch.userAgent || 'hardware-scanner-cf/1.0' } },
      );
      if (!res.ok) {
        lastError = `r/${sub}: HTTP ${res.status}`;
        console.error(`Reddit fetch failed for r/${sub}: ${res.status}`);
        continue;
      }
      data = await res.json<RedditResponse>();
    } catch (err) {
      lastError = `r/${sub}: ${(err as Error).message}`;
      console.error(`Error fetching r/${sub}:`, err);
      continue;
    }

    for (const { data: post } of data?.data?.children ?? []) {
      if (seen.has(post.id)) continue;
      newSeen.add(post.id);
      if (!matches(post.title, cfg)) continue;

      const price = extractPrice(post.title);
      if (cfg.filters.priceFilterEnabled) {
        const min = Number(cfg.filters.minPrice) || 0;
        const max = Number(cfg.filters.maxPrice) || 0;
        if (price.value === null) continue;
        if (min > 0 && price.value < min) continue;
        if (max > 0 && price.value > max) continue;
      }

      found.push({
        title: post.title,
        url: `https://reddit.com${post.permalink}`,
        sub: post.subreddit_name_prefixed,
        price: price.value,
        priceText: price.text,
        matchedAt: new Date().toISOString(),
      });

      console.log(`Match found: ${post.title}`);
    }
  }

  const trimmed = [...newSeen].slice(-Math.max(50, cfg.storage.maxSeen | 0));
  await env.SCANNER_KV.put(KV_SEEN, JSON.stringify(trimmed));

  if (cfg.notifications.enabled && cfg.notifications.ntfyUrl) {
    for (const match of found) {
      const lines = [
        match.title,
        match.priceText ? `\u{1F4B0} ${match.priceText}` : 'No price listed',
        match.sub,
      ];
      try {
        const headers: Record<string, string> = {
          Title: cfg.notifications.title,
          Priority: cfg.notifications.priority,
          Tags: cfg.notifications.tags,
          'Content-Type': 'text/plain',
        };
        if (cfg.notifications.clickThrough) headers.Click = match.url;
        await fetch(cfg.notifications.ntfyUrl, {
          method: 'POST',
          headers,
          body: lines.join('\n'),
        });
      } catch (err) {
        lastError = `ntfy: ${(err as Error).message}`;
        console.error('ntfy notification failed:', err);
      }
    }
  }

  const recent = [...found, ...status.recentMatches].slice(0, 25);
  const next: Status = {
    lastRunAt: new Date().toISOString(),
    lastRunDurationMs: Date.now() - start,
    lastRunMatchCount: found.length,
    totalRuns: status.totalRuns + 1,
    totalMatches: status.totalMatches + found.length,
    lastError,
    recentMatches: recent,
  };
  await saveStatus(env, next);

  return { count: found.length, matches: found, error: lastError ?? undefined };
}

// ---------- Config validation / merge --------------------------------------

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function asStringArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  return v.map((x) => String(x ?? '').trim()).filter(Boolean);
}
function asPriority(v: unknown, fallback: Priority): Priority {
  const allowed: Priority[] = ['min', 'low', 'default', 'high', 'max'];
  return allowed.includes(v as Priority) ? (v as Priority) : fallback;
}
function asMatchMode(v: unknown, fallback: MatchMode): MatchMode {
  return v === 'any' || v === 'all' ? v : fallback;
}

function mergeConfig(base: Config, patch: unknown): Config {
  const p = (patch ?? {}) as Partial<Config>;
  const m = (p.matching ?? {}) as Partial<Config['matching']>;
  const n = (p.notifications ?? {}) as Partial<Config['notifications']>;
  const f = (p.fetch ?? {}) as Partial<Config['fetch']>;
  const fl = (p.filters ?? {}) as Partial<Config['filters']>;
  const s = (p.storage ?? {}) as Partial<Config['storage']>;
  return {
    enabled: asBool(p.enabled, base.enabled),
    subreddits: asStringArray(p.subreddits, base.subreddits),
    matching: {
      keywords: asStringArray(m.keywords, base.matching.keywords),
      mode: asMatchMode(m.mode, base.matching.mode),
      caseSensitive: asBool(m.caseSensitive, base.matching.caseSensitive),
      excludeKeywords: asStringArray(m.excludeKeywords, base.matching.excludeKeywords),
      excludeWtb: asBool(m.excludeWtb, base.matching.excludeWtb),
    },
    notifications: {
      enabled: asBool(n.enabled, base.notifications.enabled),
      ntfyUrl: asString(n.ntfyUrl, base.notifications.ntfyUrl),
      title: asString(n.title, base.notifications.title),
      priority: asPriority(n.priority, base.notifications.priority),
      tags: asString(n.tags, base.notifications.tags),
      clickThrough: asBool(n.clickThrough, base.notifications.clickThrough),
    },
    fetch: {
      limit: Math.max(1, Math.min(100, asNumber(f.limit, base.fetch.limit) | 0)),
      userAgent: asString(f.userAgent, base.fetch.userAgent),
    },
    filters: {
      priceFilterEnabled: asBool(fl.priceFilterEnabled, base.filters.priceFilterEnabled),
      minPrice: Math.max(0, asNumber(fl.minPrice, base.filters.minPrice)),
      maxPrice: Math.max(0, asNumber(fl.maxPrice, base.filters.maxPrice)),
    },
    storage: {
      maxSeen: Math.max(50, Math.min(10000, asNumber(s.maxSeen, base.storage.maxSeen) | 0)),
    },
  };
}

// ---------- HTTP routing ---------------------------------------------------

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

function authorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return true;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${env.ADMIN_TOKEN}`;
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/config' && req.method === 'GET') {
    const cfg = await loadConfig(env);
    return json({ config: cfg, defaults: DEFAULT_CONFIG, authRequired: !!env.ADMIN_TOKEN });
  }

  if (path === '/api/config' && req.method === 'PUT') {
    if (!authorized(req, env)) return json({ error: 'unauthorized' }, { status: 401 });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid JSON' }, { status: 400 });
    }
    const merged = mergeConfig(DEFAULT_CONFIG, body);
    await env.SCANNER_KV.put(KV_CONFIG, JSON.stringify(merged));
    return json({ ok: true, config: merged });
  }

  if (path === '/api/config/reset' && req.method === 'POST') {
    if (!authorized(req, env)) return json({ error: 'unauthorized' }, { status: 401 });
    await env.SCANNER_KV.put(KV_CONFIG, JSON.stringify(DEFAULT_CONFIG));
    return json({ ok: true, config: DEFAULT_CONFIG });
  }

  if (path === '/api/scan' && req.method === 'POST') {
    if (!authorized(req, env)) return json({ error: 'unauthorized' }, { status: 401 });
    const result = await scan(env);
    return json({ ok: true, ...result });
  }

  if (path === '/api/status' && req.method === 'GET') {
    const status = await loadStatus(env);
    return json(status);
  }

  return json({ error: 'not found' }, { status: 404 });
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scan(env).then(() => undefined));
  },
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(INDEX_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------- Frontend (inlined) ---------------------------------------------

const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Hardware Scanner — Configuration</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg-0: #0b0e13;
    --bg-1: #11151c;
    --bg-2: #161b25;
    --line: #1f2632;
    --line-2: #2a3344;
    --text: #e6ecf2;
    --muted: #8a93a4;
    --dim: #5b6478;
    --accent: #5cf2c4;
    --accent-2: #7ad7ff;
    --warn: #ffb86b;
    --danger: #ff6b8a;
    --good: #5cf2c4;
    --radius: 10px;
    --radius-sm: 6px;
    --shadow: 0 0 0 1px var(--line), 0 12px 40px -16px rgba(0,0,0,.55);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg-0); color: var(--text); }
  body {
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    min-height: 100vh;
    background-image:
      radial-gradient(1200px 600px at 85% -10%, rgba(92,242,196,.06), transparent 60%),
      radial-gradient(900px 500px at 0% 100%, rgba(122,215,255,.05), transparent 60%);
  }
  ::selection { background: rgba(92,242,196,.25); color: #fff; }

  .shell { max-width: 1180px; margin: 0 auto; padding: 36px 28px 80px; }

  /* Header */
  .top {
    display: flex; align-items: center; justify-content: space-between;
    gap: 24px; padding-bottom: 28px; margin-bottom: 28px;
    border-bottom: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 14px; }
  .logo {
    width: 38px; height: 38px; border-radius: 9px;
    background:
      radial-gradient(120% 120% at 0% 0%, var(--accent) 0%, transparent 55%),
      linear-gradient(135deg, #0f1722 0%, #1a2536 100%);
    box-shadow: inset 0 0 0 1px var(--line-2), 0 0 32px -8px rgba(92,242,196,.6);
    position: relative;
  }
  .logo::after {
    content: ""; position: absolute; inset: 9px;
    border: 1px solid rgba(255,255,255,.18); border-radius: 4px;
    border-top-color: var(--accent);
    animation: spin 6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .brand h1 {
    font-size: 17px; font-weight: 600; letter-spacing: .2px; margin: 0;
  }
  .brand small {
    display: block; color: var(--muted); font-family: 'IBM Plex Mono', monospace;
    font-size: 11px; letter-spacing: .8px; text-transform: uppercase; margin-top: 2px;
  }

  .pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 12px; border-radius: 999px; font-size: 12px;
    background: var(--bg-2); border: 1px solid var(--line);
    color: var(--muted); font-family: 'IBM Plex Mono', monospace;
  }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); box-shadow: 0 0 0 3px rgba(255,255,255,.02); }
  .pill.live .dot { background: var(--good); box-shadow: 0 0 0 3px rgba(92,242,196,.18); animation: pulse 2s infinite; }
  .pill.off  .dot { background: var(--danger); }
  .pill.warn .dot { background: var(--warn); }
  @keyframes pulse { 50% { transform: scale(1.18); } }

  .actions { display: flex; gap: 10px; align-items: center; }

  /* Layout */
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 28px; align-items: start; }
  @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } .sidebar { position: static !important; } }

  /* Cards */
  .card {
    background: linear-gradient(180deg, var(--bg-1), var(--bg-2));
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 22px 24px;
    margin-bottom: 18px;
    box-shadow: var(--shadow);
  }
  .card h2 {
    margin: 0 0 4px; font-size: 13px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 1.4px; color: var(--accent);
    font-family: 'IBM Plex Mono', monospace;
  }
  .card .desc { color: var(--muted); font-size: 13px; margin: 0 0 18px; }

  /* Form rows */
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .row.cols-3 { grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 720px) { .row, .row.cols-3 { grid-template-columns: 1fr; } }

  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
  .field label {
    font-size: 12px; color: var(--muted); letter-spacing: .3px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .field label .hint {
    font-family: 'IBM Plex Mono', monospace; color: var(--dim); font-size: 11px;
  }
  .field .help { color: var(--dim); font-size: 12px; margin-top: 2px; }

  input[type="text"], input[type="url"], input[type="number"], textarea, select {
    background: var(--bg-0); border: 1px solid var(--line); color: var(--text);
    padding: 10px 12px; border-radius: var(--radius-sm); font: inherit;
    font-family: 'IBM Plex Mono', monospace; font-size: 13px;
    transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
    outline: none; width: 100%;
  }
  input:focus, textarea:focus, select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(92,242,196,.14);
    background: #0d1117;
  }
  textarea { resize: vertical; min-height: 88px; line-height: 1.55; }

  /* Range slider */
  input[type="range"] {
    -webkit-appearance: none; appearance: none; width: 100%; background: transparent;
    height: 26px;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    height: 4px; background: var(--line-2); border-radius: 2px;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 16px; height: 16px; background: var(--accent); border-radius: 50%;
    margin-top: -6px; cursor: pointer;
    box-shadow: 0 0 0 4px rgba(92,242,196,.18);
  }
  input[type="range"]::-moz-range-track { height: 4px; background: var(--line-2); border-radius: 2px; }
  input[type="range"]::-moz-range-thumb {
    width: 16px; height: 16px; background: var(--accent); border-radius: 50%;
    border: none; box-shadow: 0 0 0 4px rgba(92,242,196,.18); cursor: pointer;
  }

  /* Toggle */
  .toggle { display: inline-flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; }
  .toggle input { display: none; }
  .toggle .track {
    width: 38px; height: 22px; background: var(--bg-0); border: 1px solid var(--line-2);
    border-radius: 999px; position: relative; transition: all .2s ease;
  }
  .toggle .track::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; background: var(--muted); border-radius: 50%;
    transition: all .2s ease;
  }
  .toggle input:checked + .track { background: rgba(92,242,196,.18); border-color: var(--accent); }
  .toggle input:checked + .track::after { left: 18px; background: var(--accent); box-shadow: 0 0 12px rgba(92,242,196,.6); }
  .toggle .lbl { font-size: 13px; color: var(--text); }

  /* Segmented */
  .seg { display: inline-flex; background: var(--bg-0); border: 1px solid var(--line); border-radius: 999px; padding: 3px; }
  .seg button {
    border: 0; background: transparent; color: var(--muted); padding: 6px 14px;
    border-radius: 999px; font: inherit; font-size: 12px; cursor: pointer;
    font-family: 'IBM Plex Mono', monospace; letter-spacing: .4px;
    transition: all .15s ease;
  }
  .seg button.active { background: var(--accent); color: #06251b; font-weight: 600; }

  /* Tag editor */
  .tags { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px;
    background: var(--bg-0); border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .tag {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--bg-2); border: 1px solid var(--line-2);
    color: var(--text); font-family: 'IBM Plex Mono', monospace; font-size: 12px;
    padding: 4px 8px; border-radius: 6px;
  }
  .tag button {
    background: transparent; color: var(--muted); border: 0; cursor: pointer;
    padding: 0; line-height: 1; font-size: 14px;
  }
  .tag button:hover { color: var(--danger); }
  .tags input {
    flex: 1; min-width: 140px; background: transparent; border: 0; color: var(--text);
    font-family: 'IBM Plex Mono', monospace; font-size: 12px; padding: 4px;
    outline: none;
  }

  /* Buttons */
  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--bg-2); border: 1px solid var(--line-2); color: var(--text);
    padding: 9px 14px; border-radius: 8px; font: inherit; font-size: 13px;
    cursor: pointer; transition: all .15s ease;
    font-family: 'IBM Plex Mono', monospace; letter-spacing: .3px;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary {
    background: var(--accent); color: #06251b; border-color: var(--accent); font-weight: 600;
  }
  .btn.primary:hover { filter: brightness(1.05); color: #06251b; }
  .btn.ghost { background: transparent; }
  .btn.danger:hover { color: var(--danger); border-color: var(--danger); }
  .btn[disabled] { opacity: .5; cursor: not-allowed; }

  /* Sidebar */
  .sidebar { position: sticky; top: 24px; }
  .stat {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 10px 0; border-bottom: 1px dashed var(--line);
  }
  .stat:last-child { border: 0; }
  .stat .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .8px; font-family: 'IBM Plex Mono', monospace; }
  .stat .v { color: var(--text); font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
  .stat .v.accent { color: var(--accent); }

  .matches { max-height: 360px; overflow: auto; margin-top: 6px; }
  .match {
    padding: 10px 0; border-bottom: 1px solid var(--line);
  }
  .match:last-child { border: 0; }
  .match a {
    color: var(--text); text-decoration: none; font-size: 13px; line-height: 1.4;
    display: block;
  }
  .match a:hover { color: var(--accent); }
  .match .meta {
    display: flex; gap: 10px; margin-top: 4px;
    color: var(--muted); font-size: 11px; font-family: 'IBM Plex Mono', monospace;
  }
  .match .meta .price { color: var(--accent); }

  /* Conditional reveal */
  .conditional {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows .25s ease, opacity .25s ease, margin .25s ease;
    opacity: 0;
  }
  .conditional > .inner { overflow: hidden; }
  .conditional.open { grid-template-rows: 1fr; opacity: 1; margin-top: 8px; }

  /* Toast */
  .toasts { position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 100; }
  .toast {
    padding: 11px 16px; border-radius: 8px; background: var(--bg-2);
    border: 1px solid var(--line-2); color: var(--text); font-size: 13px;
    box-shadow: 0 12px 28px -10px rgba(0,0,0,.6);
    animation: toastIn .25s ease;
  }
  .toast.ok { border-color: var(--accent); }
  .toast.err { border-color: var(--danger); color: var(--danger); }
  @keyframes toastIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  .row-inline { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .footer-bar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 22px; background: var(--bg-2); border: 1px solid var(--line);
    border-radius: var(--radius); margin-top: 8px; gap: 16px; flex-wrap: wrap;
  }
  .footer-bar .left { color: var(--muted); font-size: 12px; font-family: 'IBM Plex Mono', monospace; }

  .divider { height: 1px; background: var(--line); margin: 16px 0; }

  /* Skeleton */
  .skeleton { color: transparent; background: linear-gradient(90deg, var(--line) 0%, var(--line-2) 50%, var(--line) 100%);
    background-size: 200% 100%; animation: sk 1.4s infinite; border-radius: 4px;
  }
  @keyframes sk { to { background-position: -200% 0; } }
</style>
</head>
<body>
  <main class="shell">
    <header class="top">
      <div class="brand">
        <div class="logo"></div>
        <div>
          <h1>Hardware Scanner</h1>
          <small data-testid="brand-tag">cron · reddit · ntfy</small>
        </div>
      </div>
      <div class="actions">
        <span id="enabled-pill" class="pill" data-testid="enabled-pill">
          <span class="dot"></span><span id="enabled-pill-text">loading…</span>
        </span>
        <button class="btn" id="btn-scan" data-testid="btn-scan-now">▷ Run scan now</button>
      </div>
    </header>

    <div class="grid">
      <div>
        <!-- General -->
        <section class="card" data-testid="card-general">
          <h2>01 — General</h2>
          <p class="desc">Master switch for the cron-driven scanner.</p>
          <div class="row-inline">
            <label class="toggle" data-testid="toggle-enabled">
              <input type="checkbox" id="enabled" />
              <span class="track"></span>
              <span class="lbl">Scanner enabled</span>
            </label>
          </div>
        </section>

        <!-- Subreddits -->
        <section class="card" data-testid="card-subreddits">
          <h2>02 — Subreddits</h2>
          <p class="desc">Subreddits to poll. Press <em>Enter</em> or <em>,</em> to add.</p>
          <div class="tags" id="tags-subreddits" data-testid="tags-subreddits"></div>
          <p class="help">Polled with <code>/r/{name}/new.json</code>.</p>
        </section>

        <!-- Matching -->
        <section class="card" data-testid="card-matching">
          <h2>03 — Matching</h2>
          <p class="desc">Define which post titles count as a match.</p>

          <div class="field">
            <label>Match keywords <span class="hint">required</span></label>
            <div class="tags" id="tags-keywords" data-testid="tags-keywords"></div>
          </div>

          <div class="row">
            <div class="field">
              <label>Match mode</label>
              <div class="seg" id="seg-mode" data-testid="seg-mode">
                <button type="button" data-val="any">ANY (or)</button>
                <button type="button" data-val="all">ALL (and)</button>
              </div>
              <p class="help">Whether the title must contain any keyword (OR) or every keyword (AND).</p>
            </div>
            <div class="field">
              <label>Case sensitive</label>
              <label class="toggle" data-testid="toggle-case">
                <input type="checkbox" id="caseSensitive" />
                <span class="track"></span>
                <span class="lbl">Match exact case</span>
              </label>
            </div>
          </div>

          <div class="field">
            <label>Exclude keywords <span class="hint">optional</span></label>
            <div class="tags" id="tags-exclude" data-testid="tags-exclude"></div>
            <p class="help">Skip titles that contain any of these.</p>
          </div>

          <div class="row-inline">
            <label class="toggle" data-testid="toggle-wtb">
              <input type="checkbox" id="excludeWtb" />
              <span class="track"></span>
              <span class="lbl">Exclude “WTB” / “want to buy” posts</span>
            </label>
          </div>
        </section>

        <!-- Filters (price) -->
        <section class="card" data-testid="card-filters">
          <h2>04 — Price filter</h2>
          <p class="desc">Optional price gate parsed from the post title.</p>
          <label class="toggle" data-testid="toggle-priceFilter">
            <input type="checkbox" id="priceFilterEnabled" />
            <span class="track"></span>
            <span class="lbl">Enable price filter</span>
          </label>

          <div class="conditional" id="cond-price">
            <div class="inner">
              <div class="row" style="margin-top:14px">
                <div class="field">
                  <label>Min price <span class="hint">USD · 0 disables</span></label>
                  <input type="number" id="minPrice" min="0" step="1" data-testid="input-minPrice" />
                </div>
                <div class="field">
                  <label>Max price <span class="hint">USD · 0 disables</span></label>
                  <input type="number" id="maxPrice" min="0" step="1" data-testid="input-maxPrice" />
                </div>
              </div>
              <p class="help">Posts without a parseable <code>$###</code> price will be skipped while the filter is on.</p>
            </div>
          </div>
        </section>

        <!-- Notifications -->
        <section class="card" data-testid="card-notifications">
          <h2>05 — Notifications (ntfy)</h2>
          <p class="desc">Push to an ntfy topic when a match is found.</p>
          <label class="toggle" data-testid="toggle-notifications">
            <input type="checkbox" id="notifications-enabled" />
            <span class="track"></span>
            <span class="lbl">Send ntfy notifications</span>
          </label>

          <div class="conditional" id="cond-notifications">
            <div class="inner">
              <div class="field" style="margin-top:14px">
                <label>ntfy URL</label>
                <input type="url" id="ntfyUrl" placeholder="https://ntfy.sh/your-topic" data-testid="input-ntfyUrl" />
              </div>
              <div class="row">
                <div class="field">
                  <label>Title</label>
                  <input type="text" id="notif-title" data-testid="input-notif-title" />
                </div>
                <div class="field">
                  <label>Priority</label>
                  <select id="priority" data-testid="select-priority">
                    <option value="min">min</option>
                    <option value="low">low</option>
                    <option value="default">default</option>
                    <option value="high">high</option>
                    <option value="max">max</option>
                  </select>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <label>Tags <span class="hint">comma-separated</span></label>
                  <input type="text" id="tags" placeholder="gpu,money_with_wings" data-testid="input-tags" />
                </div>
                <div class="field">
                  <label>Click-through</label>
                  <label class="toggle" data-testid="toggle-click">
                    <input type="checkbox" id="clickThrough" />
                    <span class="track"></span>
                    <span class="lbl">Open Reddit URL on tap</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Fetch -->
        <section class="card" data-testid="card-fetch">
          <h2>06 — Fetch</h2>
          <p class="desc">How aggressively to poll Reddit.</p>
          <div class="row">
            <div class="field">
              <label>Posts per subreddit
                <span class="hint" id="limit-val">25</span>
              </label>
              <input type="range" id="limit" min="1" max="100" step="1" data-testid="input-limit" />
            </div>
            <div class="field">
              <label>User-Agent</label>
              <input type="text" id="userAgent" data-testid="input-userAgent" />
            </div>
          </div>
        </section>

        <!-- Storage -->
        <section class="card" data-testid="card-storage">
          <h2>07 — Storage</h2>
          <p class="desc">How many post IDs to remember (de-dupe window).</p>
          <div class="row">
            <div class="field">
              <label>Max seen entries
                <span class="hint" id="maxSeen-val">1000</span>
              </label>
              <input type="range" id="maxSeen" min="50" max="10000" step="50" data-testid="input-maxSeen" />
            </div>
            <div class="field" id="auth-field" style="display:none">
              <label>Admin token <span class="hint">required</span></label>
              <input type="password" id="adminToken" placeholder="bearer token" data-testid="input-adminToken" />
              <p class="help">Stored locally in your browser only.</p>
            </div>
          </div>
        </section>

        <div class="footer-bar">
          <div class="left" id="dirty-state" data-testid="dirty-state">Loading…</div>
          <div class="actions">
            <button class="btn ghost danger" id="btn-reset" data-testid="btn-reset">Reset to defaults</button>
            <button class="btn primary" id="btn-save" data-testid="btn-save">Save configuration</button>
          </div>
        </div>
      </div>

      <aside class="sidebar">
        <section class="card" data-testid="card-status">
          <h2>Live status</h2>
          <p class="desc" style="margin-bottom:6px">Updated each cron run.</p>
          <div id="status-stats">
            <div class="stat"><span class="k">Last run</span><span class="v" id="s-last">—</span></div>
            <div class="stat"><span class="k">Duration</span><span class="v" id="s-dur">—</span></div>
            <div class="stat"><span class="k">Last matches</span><span class="v accent" id="s-lm">—</span></div>
            <div class="stat"><span class="k">Total runs</span><span class="v" id="s-tr">—</span></div>
            <div class="stat"><span class="k">Total matches</span><span class="v accent" id="s-tm">—</span></div>
            <div class="stat"><span class="k">Last error</span><span class="v" id="s-err">—</span></div>
          </div>
        </section>

        <section class="card" data-testid="card-recent">
          <h2>Recent matches</h2>
          <p class="desc">Up to 25 most recent.</p>
          <div class="matches" id="recent-matches">
            <p class="help" style="padding: 10px 0">No matches yet.</p>
          </div>
        </section>
      </aside>
    </div>
  </main>

  <div class="toasts" id="toasts"></div>

<script>
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    config: null,
    defaults: null,
    authRequired: false,
    dirty: false,
  };

  const TOKEN_KEY = 'hwscanner.adminToken';

  // ---------- Toast ----------
  function toast(msg, kind = 'ok', ms = 2400) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind === 'err' ? 'err' : 'ok');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, ms - 200);
    setTimeout(() => el.remove(), ms);
  }

  // ---------- Tag editor ----------
  function buildTagEditor(rootSel, onChange, placeholder) {
    const root = $(rootSel);
    let values = [];

    function render() {
      root.innerHTML = '';
      values.forEach((v, i) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.dataset.testid = 'tag';
        tag.textContent = v;
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.setAttribute('aria-label', 'Remove ' + v);
        x.addEventListener('click', () => {
          values.splice(i, 1); render(); onChange(values.slice());
        });
        tag.appendChild(x);
        root.appendChild(tag);
      });
      const inp = document.createElement('input');
      inp.placeholder = values.length ? '' : (placeholder || 'add…');
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const v = inp.value.trim().replace(/,$/, '');
          if (v && !values.includes(v)) {
            values.push(v); onChange(values.slice());
          }
          inp.value = '';
          render();
          $(rootSel).querySelector('input').focus();
        } else if (e.key === 'Backspace' && !inp.value && values.length) {
          values.pop(); onChange(values.slice()); render();
          $(rootSel).querySelector('input').focus();
        }
      });
      inp.addEventListener('blur', () => {
        const v = inp.value.trim();
        if (v && !values.includes(v)) {
          values.push(v); onChange(values.slice()); render();
        }
      });
      root.appendChild(inp);
    }

    return {
      set(v) { values = Array.isArray(v) ? v.slice() : []; render(); },
      get() { return values.slice(); },
    };
  }

  // ---------- Conditional reveal ----------
  function setReveal(id, open) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('open', !!open);
  }

  // ---------- Form binding ----------
  let tagsSub, tagsKw, tagsEx;

  function markDirty() {
    state.dirty = true;
    $('#dirty-state').textContent = '● Unsaved changes';
    $('#dirty-state').style.color = 'var(--warn)';
  }
  function markClean() {
    state.dirty = false;
    $('#dirty-state').textContent = '✓ Up to date';
    $('#dirty-state').style.color = 'var(--muted)';
  }

  function paint(cfg) {
    $('#enabled').checked = cfg.enabled;
    tagsSub.set(cfg.subreddits);
    tagsKw.set(cfg.matching.keywords);
    tagsEx.set(cfg.matching.excludeKeywords);

    $$('#seg-mode button').forEach((b) =>
      b.classList.toggle('active', b.dataset.val === cfg.matching.mode),
    );
    $('#caseSensitive').checked = cfg.matching.caseSensitive;
    $('#excludeWtb').checked = cfg.matching.excludeWtb;

    $('#priceFilterEnabled').checked = cfg.filters.priceFilterEnabled;
    $('#minPrice').value = cfg.filters.minPrice;
    $('#maxPrice').value = cfg.filters.maxPrice;
    setReveal('cond-price', cfg.filters.priceFilterEnabled);

    $('#notifications-enabled').checked = cfg.notifications.enabled;
    $('#ntfyUrl').value = cfg.notifications.ntfyUrl;
    $('#notif-title').value = cfg.notifications.title;
    $('#priority').value = cfg.notifications.priority;
    $('#tags').value = cfg.notifications.tags;
    $('#clickThrough').checked = cfg.notifications.clickThrough;
    setReveal('cond-notifications', cfg.notifications.enabled);

    $('#limit').value = cfg.fetch.limit;
    $('#limit-val').textContent = cfg.fetch.limit;
    $('#userAgent').value = cfg.fetch.userAgent;

    $('#maxSeen').value = cfg.storage.maxSeen;
    $('#maxSeen-val').textContent = cfg.storage.maxSeen;

    paintEnabledPill(cfg.enabled);
    markClean();
  }

  function paintEnabledPill(on) {
    const pill = $('#enabled-pill');
    const text = $('#enabled-pill-text');
    pill.classList.remove('live', 'off', 'warn');
    if (on) { pill.classList.add('live'); text.textContent = 'Scanning · cron */1m'; }
    else    { pill.classList.add('off');  text.textContent = 'Disabled'; }
  }

  function readForm() {
    return {
      enabled: $('#enabled').checked,
      subreddits: tagsSub.get(),
      matching: {
        keywords: tagsKw.get(),
        mode: $$('#seg-mode button.active')[0]?.dataset.val || 'any',
        caseSensitive: $('#caseSensitive').checked,
        excludeKeywords: tagsEx.get(),
        excludeWtb: $('#excludeWtb').checked,
      },
      notifications: {
        enabled: $('#notifications-enabled').checked,
        ntfyUrl: $('#ntfyUrl').value.trim(),
        title: $('#notif-title').value,
        priority: $('#priority').value,
        tags: $('#tags').value.trim(),
        clickThrough: $('#clickThrough').checked,
      },
      fetch: {
        limit: Number($('#limit').value),
        userAgent: $('#userAgent').value.trim(),
      },
      filters: {
        priceFilterEnabled: $('#priceFilterEnabled').checked,
        minPrice: Number($('#minPrice').value) || 0,
        maxPrice: Number($('#maxPrice').value) || 0,
      },
      storage: {
        maxSeen: Number($('#maxSeen').value),
      },
    };
  }

  // ---------- Status panel ----------
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleString();
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const s = await res.json();
      $('#s-last').textContent = fmtTime(s.lastRunAt);
      $('#s-dur').textContent = (s.lastRunDurationMs || 0) + ' ms';
      $('#s-lm').textContent = s.lastRunMatchCount;
      $('#s-tr').textContent = s.totalRuns;
      $('#s-tm').textContent = s.totalMatches;
      $('#s-err').textContent = s.lastError || 'none';
      $('#s-err').style.color = s.lastError ? 'var(--danger)' : 'var(--muted)';

      const root = $('#recent-matches');
      if (!s.recentMatches || s.recentMatches.length === 0) {
        root.innerHTML = '<p class="help" style="padding: 10px 0">No matches yet.</p>';
      } else {
        root.innerHTML = '';
        s.recentMatches.forEach((m) => {
          const d = document.createElement('div');
          d.className = 'match';
          d.dataset.testid = 'match-row';
          const a = document.createElement('a');
          a.href = m.url; a.target = '_blank'; a.rel = 'noreferrer noopener';
          a.textContent = m.title;
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.innerHTML =
            '<span>' + (m.sub || '') + '</span>' +
            (m.priceText ? '<span class="price">' + m.priceText + '</span>' : '') +
            '<span>' + fmtTime(m.matchedAt) + '</span>';
          d.appendChild(a); d.appendChild(meta);
          root.appendChild(d);
        });
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- API ----------
  function authHeaders() {
    const t = localStorage.getItem(TOKEN_KEY) || $('#adminToken')?.value || '';
    return state.authRequired && t ? { Authorization: 'Bearer ' + t } : {};
  }

  async function loadConfig() {
    const res = await fetch('/api/config');
    const j = await res.json();
    state.config = j.config;
    state.defaults = j.defaults;
    state.authRequired = !!j.authRequired;
    if (state.authRequired) {
      $('#auth-field').style.display = '';
      const t = localStorage.getItem(TOKEN_KEY) || '';
      $('#adminToken').value = t;
    }
    paint(state.config);
  }

  async function saveConfig() {
    const body = readForm();
    if (!body.subreddits.length) return toast('Add at least one subreddit', 'err');
    if (!body.matching.keywords.length) return toast('Add at least one match keyword', 'err');
    if (body.notifications.enabled && !body.notifications.ntfyUrl) return toast('ntfy URL required', 'err');

    if (state.authRequired) {
      const t = $('#adminToken').value.trim();
      if (!t) return toast('Admin token required', 'err');
      localStorage.setItem(TOKEN_KEY, t);
    }
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return toast('Save failed: ' + (err.error || res.status), 'err');
    }
    const j = await res.json();
    state.config = j.config;
    paint(state.config);
    toast('Configuration saved');
  }

  async function resetConfig() {
    if (!confirm('Reset every parameter to defaults?')) return;
    const res = await fetch('/api/config/reset', { method: 'POST', headers: authHeaders() });
    if (!res.ok) return toast('Reset failed', 'err');
    const j = await res.json();
    state.config = j.config;
    paint(state.config);
    toast('Reset to defaults');
  }

  async function runScan() {
    const btn = $('#btn-scan');
    btn.disabled = true; btn.textContent = '◌ Scanning…';
    try {
      const res = await fetch('/api/scan', { method: 'POST', headers: authHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast('Scan failed: ' + (err.error || res.status), 'err');
      } else {
        const j = await res.json();
        toast(j.count + ' match(es) found', j.count > 0 ? 'ok' : 'ok');
        refreshStatus();
      }
    } finally {
      btn.disabled = false; btn.textContent = '▷ Run scan now';
    }
  }

  // ---------- Wire up ----------
  document.addEventListener('DOMContentLoaded', async () => {
    tagsSub = buildTagEditor('#tags-subreddits', () => markDirty(), 'subreddit name');
    tagsKw  = buildTagEditor('#tags-keywords',   () => markDirty(), 'keyword');
    tagsEx  = buildTagEditor('#tags-exclude',    () => markDirty(), 'keyword to exclude');

    $$('#seg-mode button').forEach((b) =>
      b.addEventListener('click', () => {
        $$('#seg-mode button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active'); markDirty();
      }),
    );

    $('#priceFilterEnabled').addEventListener('change', (e) => {
      setReveal('cond-price', e.target.checked); markDirty();
    });
    $('#notifications-enabled').addEventListener('change', (e) => {
      setReveal('cond-notifications', e.target.checked); markDirty();
    });
    $('#enabled').addEventListener('change', (e) => {
      paintEnabledPill(e.target.checked); markDirty();
    });

    $('#limit').addEventListener('input', (e) => { $('#limit-val').textContent = e.target.value; markDirty(); });
    $('#maxSeen').addEventListener('input', (e) => { $('#maxSeen-val').textContent = e.target.value; markDirty(); });

    // generic dirty marker
    [
      '#caseSensitive', '#excludeWtb', '#minPrice', '#maxPrice',
      '#ntfyUrl', '#notif-title', '#priority', '#tags', '#clickThrough',
      '#userAgent',
    ].forEach((sel) => {
      const el = $(sel); if (!el) return;
      el.addEventListener('input', markDirty);
      el.addEventListener('change', markDirty);
    });

    $('#btn-save').addEventListener('click', saveConfig);
    $('#btn-reset').addEventListener('click', resetConfig);
    $('#btn-scan').addEventListener('click', runScan);

    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    await loadConfig();
    await refreshStatus();
    setInterval(refreshStatus, 15000);
  });
})();
</script>
</body>
</html>`;

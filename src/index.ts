interface Env {
  SCANNER_KV: KVNamespace;
}

interface RedditPost {
  id: string;
  title: string;
  permalink: string;
  link_flair_text: string | null;
  subreddit_name_prefixed: string;
}

interface RedditResponse {
  data: {
    children: Array<{ data: RedditPost }>;
  };
}

interface Match {
  title: string;
  url: string;
  sub: string;
  price: string | null;
}

const SUBREDDITS = ['hardwareswap', 'homelabsales'] as const;
const NTFY_TOPIC = 'https://ntfy.alexzaw.dev/gpu-blackwell';
const KV_KEY = 'seen_posts';
const MAX_SEEN = 1000;

const MATCH_KEYWORDS = [
  'rtx pro 2000',
  'rtx pro 4000',
  'rtx pro 5000',
  'rtx pro 6000',
  'pro 2000 blackwell',
  'pro 4000 blackwell',
  'pro 5000 blackwell',
  'pro 6000 blackwell',
] as const;

function isWTS(post: RedditPost): boolean {
  const flair = (post.link_flair_text ?? '').toLowerCase();
  return (
    flair.includes('selling') ||
    flair.includes('wts') ||
    /^\[wts\]/i.test(post.title) ||
    /^\[price.?drop\]/i.test(post.title)
  );
}

function matchesKeyword(title: string): boolean {
  return MATCH_KEYWORDS.some((kw) => title.toLowerCase().includes(kw));
}

function extractPrice(title: string): string | null {
  const m = title.match(/\$[\d,]+(?:\.\d{2})?/);
  return m ? m[0] : null;
}

async function scan(env: Env): Promise<number> {
  const seenRaw = await env.SCANNER_KV.get(KV_KEY);
  const seen = new Set<string>(seenRaw ? (JSON.parse(seenRaw) as string[]) : []);
  const newSeen = new Set<string>(seen);
  const matches: Match[] = [];

  for (const sub of SUBREDDITS) {
    let data: RedditResponse;
    try {
      const res = await fetch(
        `https://www.reddit.com/r/${sub}/new.json?limit=25&raw_json=1`,
        { headers: { 'User-Agent': 'hardware-scanner-cf/1.0' } }
      );
      if (!res.ok) {
        console.error(`Reddit fetch failed for r/${sub}: ${res.status}`);
        continue;
      }
      data = await res.json<RedditResponse>();
    } catch (err) {
      console.error(`Error fetching r/${sub}:`, err);
      continue;
    }

    for (const { data: post } of data?.data?.children ?? []) {
      if (seen.has(post.id)) continue;
      newSeen.add(post.id);
      if (!isWTS(post)) continue;
      if (!matchesKeyword(post.title)) continue;

      matches.push({
        title: post.title,
        url: `https://reddit.com${post.permalink}`,
        sub: post.subreddit_name_prefixed,
        price: extractPrice(post.title),
      });

      console.log(`Match found: ${post.title}`);
    }
  }

  const trimmed = [...newSeen].slice(-MAX_SEEN);
  await env.SCANNER_KV.put(KV_KEY, JSON.stringify(trimmed));

  for (const match of matches) {
    const body = [
      match.title,
      match.price ? `💰 ${match.price}` : 'No price listed',
      match.sub,
    ].join('
');

    try {
      await fetch(NTFY_TOPIC, {
        method: 'POST',
        headers: {
          Title: '🖥️ RTX Pro Blackwell Listed',
          Priority: 'high',
          Tags: 'gpu,money_with_wings',
          Click: match.url,
          'Content-Type': 'text/plain',
        },
        body,
      });
    } catch (err) {
      console.error('ntfy notification failed:', err);
    }
  }

  return matches.length;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scan(env));
  },
  async fetch(_request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const count = await scan(env);
    return new Response(`Scan complete. ${count} match(es) found.`, { status: 200 });
  },
} satisfies ExportedHandler<Env>;
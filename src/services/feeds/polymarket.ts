import { env } from '../../config/env.js';
import { FecMarket } from '../../models/FecMarket.js';
import { setFeedHealth } from './health.js';
import {
  categorizeTitle,
  isDeniedTitle,
  matchGroupId,
  matchTokens,
  parseYesPrice,
} from './normalize.js';

const GAMMA = 'https://gamma-api.polymarket.com';

const QUERIES = [
  'federal reserve',
  'interest rate',
  'FOMC',
  'CPI inflation',
  'recession',
  'S&P 500',
  'Nasdaq',
  'treasury yield',
  'crude oil',
  'unemployment',
];

type PolyEvent = {
  id: string;
  title: string;
  slug?: string;
  endDate?: string;
  markets?: Array<{
    id?: string;
    question?: string;
    outcomePrices?: string;
    volume?: string | number;
    liquidity?: string | number;
    slug?: string;
    endDate?: string;
  }>;
};

type PolyMarket = {
  id: string;
  question: string;
  slug?: string;
  outcomePrices?: string;
  volume?: string | number;
  liquidity?: string | number;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (res.status === 429) throw new Error('HTTP 429 rate limited');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function yesFromOutcomePrices(raw?: string): number {
  try {
    const prices = JSON.parse(raw || '[]') as string[];
    return parseYesPrice(prices[0] || 0);
  } catch {
    return 0;
  }
}

async function upsertMarket(input: {
  externalId: string;
  title: string;
  yesPrice: number;
  volume: number;
  liquidity: number;
  closesAt?: Date;
  url: string;
  query: string;
}): Promise<boolean> {
  if (isDeniedTitle(input.title)) return false;
  const tokens = matchTokens(input.title);
  await FecMarket.findOneAndUpdate(
    { venue: 'polymarket', externalId: input.externalId },
    {
      venue: 'polymarket',
      externalId: input.externalId,
      title: input.title,
      category: categorizeTitle(input.title),
      yesPrice: input.yesPrice,
      volume: input.volume,
      liquidity: input.liquidity,
      closesAt: input.closesAt,
      url: input.url,
      seriesTicker: '',
      matchGroupId: matchGroupId(tokens),
      matchTokens: tokens,
      asOf: new Date(),
      meta: { query: input.query },
    },
    { upsert: true, new: true }
  );
  return true;
}

export async function ingestPolymarket(): Promise<number> {
  const name = 'polymarket';
  try {
    let count = 0;
    const seen = new Set<string>();
    const queries = QUERIES.slice(0, env.polymarketQueryLimit);

    for (const q of queries) {
      try {
        const body = await fetchJson<{ events?: PolyEvent[] }>(
          `${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=8`
        );
        for (const ev of body.events || []) {
          const m0 = ev.markets?.[0];
          const id = m0?.id || `event:${ev.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const title = m0?.question || ev.title;
          const slug = m0?.slug || ev.slug || '';
          const ok = await upsertMarket({
            externalId: String(id),
            title,
            yesPrice: yesFromOutcomePrices(m0?.outcomePrices),
            volume: Number(m0?.volume || 0) || 0,
            liquidity: Number(m0?.liquidity || 0) || 0,
            closesAt: m0?.endDate || ev.endDate ? new Date(m0?.endDate || ev.endDate || '') : undefined,
            url: slug
              ? `https://polymarket.com/event/${slug}`
              : `https://polymarket.com`,
            query: q,
          });
          if (ok) count++;
        }
      } catch (e) {
        console.warn(`[polymarket] search "${q}":`, e instanceof Error ? e.message : e);
      }
    }

    // Fallback: tagged / keyword scan if search yielded little
    if (count < 5) {
      const markets = await fetchJson<PolyMarket[]>(
        `${GAMMA}/markets?active=true&closed=false&limit=40`
      );
      for (const m of markets) {
        if (seen.has(m.id)) continue;
        if (isDeniedTitle(m.question)) continue;
        // keep only if looks financial
        const cat = categorizeTitle(m.question);
        if (cat === 'other_financial' && !/\b(fed|rate|cpi|gdp|oil|nasdaq|s&p|treasury|inflation)\b/i.test(m.question)) {
          continue;
        }
        seen.add(m.id);
        const ok = await upsertMarket({
          externalId: m.id,
          title: m.question,
          yesPrice: yesFromOutcomePrices(m.outcomePrices),
          volume: Number(m.volume || 0) || 0,
          liquidity: Number(m.liquidity || 0) || 0,
          closesAt: m.endDate ? new Date(m.endDate) : undefined,
          url: m.slug ? `https://polymarket.com/market/${m.slug}` : 'https://polymarket.com',
          query: 'markets-fallback',
        });
        if (ok) count++;
      }
    }

    setFeedHealth({
      name,
      enabled: true,
      lastSuccessAt: new Date().toISOString(),
      lastCount: count,
      lastError: undefined,
    });
    console.log(`[polymarket] upserted=${count}`);
    return count;
  } catch (e) {
    setFeedHealth({
      name,
      enabled: true,
      lastError: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}

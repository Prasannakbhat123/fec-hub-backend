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

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const CATEGORIES = ['Economics', 'Financials'] as const;

type KalshiSeries = { ticker: string; title?: string; category?: string };
type KalshiMarket = {
  ticker: string;
  title: string;
  status?: string;
  event_ticker?: string;
  last_price_dollars?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  volume_fp?: string;
  volume_24h_fp?: string;
  liquidity_dollars?: string;
  close_time?: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string, attempt = 0): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 429) {
    if (attempt >= 3) throw new Error('HTTP 429 rate limited');
    await sleep(800 * (attempt + 1));
    return fetchJson<T>(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function listSeries(category: string, take: number): Promise<KalshiSeries[]> {
  // Kalshi may ignore/limit poorly; request a page then slice client-side
  const params = new URLSearchParams({ limit: String(Math.min(take, 100)), category });
  const body = await fetchJson<{ series?: KalshiSeries[] }>(
    `${KALSHI_BASE}/series?${params}`
  );
  return (body.series || []).slice(0, take);
}

async function listMarketsForSeries(seriesTicker: string): Promise<KalshiMarket[]> {
  const params = new URLSearchParams({
    limit: '12',
    series_ticker: seriesTicker,
  });
  const body = await fetchJson<{ markets?: KalshiMarket[] }>(
    `${KALSHI_BASE}/markets?${params}`
  );
  return (body.markets || []).filter(
    (m) => !m.status || m.status === 'active' || m.status === 'open'
  );
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
      await sleep(120);
    }
  }
  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export async function ingestKalshi(): Promise<number> {
  const name = 'kalshi';
  try {
    const perCat = Math.max(1, Math.ceil(env.kalshiSeriesLimit / CATEGORIES.length));
    const series: KalshiSeries[] = [];
    for (const cat of CATEGORIES) {
      const chunk = await listSeries(cat, perCat);
      series.push(...chunk);
      await sleep(200);
    }
    const capped = series.slice(0, env.kalshiSeriesLimit);
    console.log(`[kalshi] series=${capped.length} (capped), fetching markets…`);

    const rows = await mapPool(capped, 3, async (s) => {
      if (!s.ticker) return { series: s, markets: [] as KalshiMarket[] };
      try {
        const markets = await listMarketsForSeries(s.ticker);
        return { series: s, markets };
      } catch (e) {
        console.warn(`[kalshi] series ${s.ticker}:`, e instanceof Error ? e.message : e);
        return { series: s, markets: [] as KalshiMarket[] };
      }
    });

    let count = 0;
    const seen = new Set<string>();
    const ops = [];

    for (const row of rows) {
      const s = row.series;
      for (const m of row.markets) {
        if (!m.ticker || seen.has(m.ticker)) continue;
        if (isDeniedTitle(m.title) || isDeniedTitle(s.title || '')) continue;
        seen.add(m.ticker);

        const yes = parseYesPrice(
          m.last_price_dollars || m.yes_bid_dollars || m.yes_ask_dollars || 0
        );
        const tokens = matchTokens(m.title);
        const volume = Number(m.volume_fp || m.volume_24h_fp || 0) || 0;
        const liquidity = Number(m.liquidity_dollars || 0) || 0;

        ops.push({
          updateOne: {
            filter: { venue: 'kalshi' as const, externalId: m.ticker },
            update: {
              $set: {
                venue: 'kalshi' as const,
                externalId: m.ticker,
                title: m.title,
                category: categorizeTitle(m.title, s.title || s.category || ''),
                yesPrice: yes,
                volume,
                liquidity,
                closesAt: m.close_time ? new Date(m.close_time) : undefined,
                url: `https://kalshi.com/markets/${m.ticker.toLowerCase()}`,
                seriesTicker: s.ticker,
                matchGroupId: matchGroupId(tokens),
                matchTokens: tokens,
                asOf: new Date(),
                meta: {
                  status: m.status,
                  eventTicker: m.event_ticker,
                  seriesTitle: s.title,
                  seriesCategory: s.category,
                },
              },
            },
            upsert: true,
          },
        });
        count++;
      }
    }

    if (ops.length) {
      await FecMarket.bulkWrite(ops, { ordered: false });
    }

    setFeedHealth({
      name,
      enabled: true,
      lastSuccessAt: new Date().toISOString(),
      lastCount: count,
      lastError: undefined,
    });
    console.log(`[kalshi] upserted=${count}`);
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

import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '../../config/env.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_VERSION = 'v2';

const ArticleSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  url: z.string().url(),
  imageUrl: z.string().url().optional().nullable(),
  source: z.string().optional().nullable(),
  publishedAt: z.string().optional().nullable(),
  relevance: z.number().min(0).max(100),
  lean: z.enum(['yes', 'no', 'neutral']),
  leanScore: z.number().min(-100).max(100),
});

const TimelineItemSchema = z.object({
  date: z.string().min(1),
  event: z.string().min(1),
});

const CrossVenueMatchSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(100),
});

const IntelSchema = z.object({
  brief: z.string().min(1),
  resolution: z.string().default(''),
  drivers: z.array(z.string().min(1)).max(6).default([]),
  timeline: z.array(TimelineItemSchema).max(6).default([]),
  counterargument: z.string().default(''),
  marketLean: z.number().min(-100).max(100),
  confidence: z.number().min(0).max(100).default(50),
  staleRisk: z.enum(['low', 'medium', 'high']).default('medium'),
  articles: z.array(ArticleSchema).max(8),
  crossVenueMatches: z.array(CrossVenueMatchSchema).max(5).default([]),
});

export type MarketIntelArticle = z.infer<typeof ArticleSchema>;
export type MarketIntelPayload = z.infer<typeof IntelSchema>;

export type MarketIntelResult = MarketIntelPayload & {
  marketId: string;
  cached: boolean;
};

export class IntelError extends Error {
  status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.name = 'IntelError';
    this.status = status;
  }
}

type CacheEntry = { expiresAt: number; payload: MarketIntelPayload };

const cache = new Map<string, CacheEntry>();

export type MarketIntelCandidate = {
  id: string;
  title: string;
  venue: string;
  yesPrice: number;
};

export type MarketIntelInput = {
  id: string;
  title: string;
  category: string;
  venue: string;
  yesPrice: number;
  closesAt?: Date | string | null;
  candidates?: MarketIntelCandidate[];
};

function cacheKey(id: string) {
  return `${CACHE_VERSION}:${id}`;
}

function extractOutputText(response: OpenAI.Responses.Response): string {
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && part.text) chunks.push(part.text);
    }
  }
  if (chunks.length) return chunks.join('\n');
  const fallback = (response as { output_text?: string }).output_text;
  return typeof fallback === 'string' ? fallback : '';
}

function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new IntelError('OpenAI returned non-JSON intel payload', 502);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function sanitizeArticles(articles: MarketIntelArticle[]): MarketIntelArticle[] {
  const seen = new Set<string>();
  const out: MarketIntelArticle[] = [];
  for (const a of articles) {
    let url: string;
    try {
      url = new URL(a.url).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);

    let imageUrl: string | undefined;
    if (a.imageUrl) {
      try {
        imageUrl = new URL(a.imageUrl).toString();
      } catch {
        imageUrl = undefined;
      }
    }

    out.push({
      ...a,
      url,
      imageUrl: imageUrl ?? null,
      source: a.source || null,
      publishedAt: a.publishedAt || null,
      relevance: Math.round(Math.min(100, Math.max(0, a.relevance))),
      leanScore: Math.round(Math.min(100, Math.max(-100, a.leanScore))),
    });
    if (out.length >= 8) break;
  }
  return out;
}

function sanitizeMatches(
  matches: z.infer<typeof CrossVenueMatchSchema>[],
  allowedIds: Set<string>
) {
  const seen = new Set<string>();
  const out: z.infer<typeof CrossVenueMatchSchema>[] = [];
  for (const m of matches) {
    if (!allowedIds.has(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      reason: m.reason.trim(),
      confidence: Math.round(Math.min(100, Math.max(0, m.confidence))),
    });
    if (out.length >= 5) break;
  }
  return out;
}

export async function getMarketIntel(market: MarketIntelInput): Promise<MarketIntelResult> {
  if (!env.openaiApiKey) {
    throw new IntelError('OPENAI_API_KEY is not configured', 503);
  }

  const key = cacheKey(market.id);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return { marketId: market.id, cached: true, ...hit.payload };
  }

  const client = new OpenAI({ apiKey: env.openaiApiKey });
  const yesCents = Math.round(market.yesPrice * 100);
  const closes =
    market.closesAt != null
      ? new Date(market.closesAt).toISOString().slice(0, 10)
      : 'unknown';
  const candidates = (market.candidates || []).slice(0, 24);
  const allowedIds = new Set(candidates.map((c) => c.id));

  const candidateBlock =
    candidates.length > 0
      ? `\nOpposite-venue candidates (pick only true same/similar events; use exact id strings):\n${candidates
          .map(
            (c) =>
              `- id=${c.id} | ${c.venue} | YES=${Math.round(c.yesPrice * 100)}¢ | ${c.title}`
          )
          .join('\n')}`
      : '\nNo opposite-venue candidates provided. Return crossVenueMatches as [].';

  const prompt = `You are researching a financial prediction-market contract for a read-only hub.

Contract:
- Title: ${market.title}
- Category: ${market.category}
- Venue: ${market.venue}
- Current YES price: ${yesCents}¢ (0–100)
- Closes: ${closes}
${candidateBlock}

Use web search for recent, relevant news and analysis about this outcome.
Return ONLY valid JSON (no markdown) matching this shape:
{
  "brief": "2-4 sentence overview of the latest context",
  "resolution": "Plain English: what YES means and how this likely settles",
  "drivers": ["3-5 short catalysts that move this market"],
  "timeline": [{"date": "YYYY-MM-DD or Month YYYY", "event": "upcoming catalyst"}],
  "counterargument": "Strongest case against the lean (1-3 sentences)",
  "marketLean": <-100 to 100; positive = supports YES, negative = supports NO>,
  "confidence": <0-100 how strong the evidence is>,
  "staleRisk": "low" | "medium" | "high",
  "articles": [
    {
      "title": "string",
      "summary": "1-2 sentences",
      "url": "https://...",
      "imageUrl": null,
      "source": "publisher name or null",
      "publishedAt": "ISO date string or null",
      "relevance": <0-100>,
      "lean": "yes" | "no" | "neutral",
      "leanScore": <-100 to 100>
    }
  ],
  "crossVenueMatches": [
    { "id": "exact candidate id", "reason": "why same/similar event", "confidence": <0-100> }
  ]
}

Rules:
- Include 4–8 real articles with working https URLs from reputable sources.
- Prefer recent coverage. Set imageUrl to null unless you have a real URL.
- drivers: concrete catalysts (data releases, meetings, headlines), not vague filler.
- timeline: only real upcoming dates you can justify; else [].
- crossVenueMatches: only ids from the candidate list; empty if none truly match.
- confidence is evidence strength, separate from marketLean direction.
- staleRisk high if coverage is old or already priced in.
- Scores must reflect evidence, not invent certainty.
- This is not financial advice.`;

  let response: OpenAI.Responses.Response;
  try {
    response = await client.responses.create({
      model: 'gpt-4.1-mini',
      tools: [{ type: 'web_search' }],
      input: prompt,
      temperature: 0.2,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'OpenAI request failed';
    throw new IntelError(msg, 502);
  }

  const rawText = extractOutputText(response);
  if (!rawText) {
    throw new IntelError('OpenAI returned empty intel', 502);
  }

  let parsed: unknown;
  try {
    parsed = parseJsonLoose(rawText);
  } catch (err) {
    if (err instanceof IntelError) throw err;
    throw new IntelError('Failed to parse OpenAI intel JSON', 502);
  }

  const validated = IntelSchema.safeParse(parsed);
  if (!validated.success) {
    throw new IntelError('OpenAI intel failed schema validation', 502);
  }

  const payload: MarketIntelPayload = {
    brief: validated.data.brief.trim(),
    resolution: validated.data.resolution.trim(),
    drivers: validated.data.drivers.map((d) => d.trim()).filter(Boolean).slice(0, 6),
    timeline: validated.data.timeline
      .map((t) => ({ date: t.date.trim(), event: t.event.trim() }))
      .filter((t) => t.date && t.event)
      .slice(0, 6),
    counterargument: validated.data.counterargument.trim(),
    marketLean: Math.round(Math.min(100, Math.max(-100, validated.data.marketLean))),
    confidence: Math.round(Math.min(100, Math.max(0, validated.data.confidence))),
    staleRisk: validated.data.staleRisk,
    articles: sanitizeArticles(validated.data.articles),
    crossVenueMatches: sanitizeMatches(validated.data.crossVenueMatches, allowedIds),
  };

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload });

  return { marketId: market.id, cached: false, ...payload };
}

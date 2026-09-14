import { Router } from 'express';
import { FecMarket, CATEGORIES } from '../models/FecMarket.js';
import { getFeedHealth } from '../services/feeds/health.js';
import { runIngestOnce } from '../services/feeds/runner.js';
import { getMarketIntel, IntelError } from '../services/openai/marketIntel.js';

export const marketsRouter = Router();

marketsRouter.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const venue = String(req.query.venue || '').trim();
    const category = String(req.query.category || '').trim();
    const limit = Math.min(Number(req.query.limit) || 80, 200);

    const filter: Record<string, unknown> = {};
    if (venue === 'kalshi' || venue === 'polymarket') filter.venue = venue;
    if (category && (CATEGORIES as readonly string[]).includes(category)) {
      filter.category = category;
    }
    if (q) {
      filter.$or = [
        { title: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
        { matchTokens: q.toLowerCase() },
      ];
    }

    const markets = await FecMarket.find(filter)
      .sort({ volume: -1, asOf: -1 })
      .limit(limit)
      .lean();

    res.json({
      markets: markets.map((m) => ({
        id: String(m._id),
        venue: m.venue,
        externalId: m.externalId,
        title: m.title,
        category: m.category,
        yesPrice: m.yesPrice,
        volume: m.volume,
        liquidity: m.liquidity,
        closesAt: m.closesAt,
        url: m.url,
        matchGroupId: m.matchGroupId,
        asOf: m.asOf,
      })),
      count: markets.length,
    });
  } catch (e) {
    next(e);
  }
});

marketsRouter.get('/:id/intel', async (req, res, next) => {
  try {
    const market = await FecMarket.findById(req.params.id).lean();
    if (!market) {
      res.status(404).json({ error: 'Market not found' });
      return;
    }

    const oppositeVenue = market.venue === 'kalshi' ? 'polymarket' : 'kalshi';
    const tokens = (market.matchTokens || []).slice(0, 3);

    const [tokenMatches, topOpposite] = await Promise.all([
      tokens.length >= 2
        ? FecMarket.find({
            venue: oppositeVenue,
            matchTokens: { $in: tokens },
          })
            .sort({ volume: -1 })
            .limit(12)
            .lean()
        : Promise.resolve([]),
      FecMarket.find({ venue: oppositeVenue, category: market.category })
        .sort({ volume: -1 })
        .limit(16)
        .lean(),
    ]);

    const byId = new Map<string, (typeof topOpposite)[number]>();
    for (const row of [...tokenMatches, ...topOpposite]) {
      byId.set(String(row._id), row);
    }
    const candidates = Array.from(byId.values())
      .slice(0, 24)
      .map((m) => ({
        id: String(m._id),
        title: m.title,
        venue: m.venue,
        yesPrice: m.yesPrice,
      }));

    const intel = await getMarketIntel({
      id: String(market._id),
      title: market.title,
      category: market.category,
      venue: market.venue,
      yesPrice: market.yesPrice,
      closesAt: market.closesAt,
      candidates,
    });

    res.json(intel);
  } catch (e) {
    if (e instanceof IntelError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    next(e);
  }
});

marketsRouter.get('/:id', async (req, res, next) => {
  try {
    const market = await FecMarket.findById(req.params.id).lean();
    if (!market) {
      res.status(404).json({ error: 'Market not found' });
      return;
    }

    const related =
      market.matchGroupId && market.matchGroupId !== 'ungrouped'
        ? await FecMarket.find({
            matchGroupId: market.matchGroupId,
            _id: { $ne: market._id },
          })
            .limit(8)
            .lean()
        : [];

    // Also pull opposite-venue soft matches by shared tokens
    const tokens = (market.matchTokens || []).slice(0, 4);
    let heuristic: typeof related = [];
    if (tokens.length >= 2) {
      heuristic = await FecMarket.find({
        venue: { $ne: market.venue },
        _id: { $ne: market._id },
        matchTokens: { $all: tokens.slice(0, 2) },
      })
        .limit(6)
        .lean();
    }

    const byId = new Map<string, (typeof related)[number]>();
    for (const r of [...related, ...heuristic]) {
      byId.set(String(r._id), r);
    }
    const compare = Array.from(byId.values());

    res.json({
      market: {
        id: String(market._id),
        venue: market.venue,
        externalId: market.externalId,
        title: market.title,
        category: market.category,
        yesPrice: market.yesPrice,
        volume: market.volume,
        liquidity: market.liquidity,
        closesAt: market.closesAt,
        url: market.url,
        matchGroupId: market.matchGroupId,
        matchTokens: market.matchTokens,
        asOf: market.asOf,
        meta: market.meta,
      },
      compare: compare.map((m) => ({
        id: String(m._id),
        venue: m.venue,
        externalId: m.externalId,
        title: m.title,
        category: m.category,
        yesPrice: m.yesPrice,
        volume: m.volume,
        url: m.url,
        matchGroupId: m.matchGroupId,
      })),
    });
  } catch (e) {
    next(e);
  }
});

export const healthRouter = Router();

healthRouter.get('/feeds', (_req, res) => {
  res.json({ feeds: getFeedHealth() });
});

healthRouter.post('/refresh', async (_req, res, next) => {
  try {
    const result = await runIngestOnce();
    res.json({ ok: true, ...result, feeds: getFeedHealth() });
  } catch (e) {
    next(e);
  }
});

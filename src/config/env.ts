import 'dotenv/config';

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const env = {
  mongoUri: process.env.MONGO_URI || '',
  port: num('PORT', 4100),
  frontendOrigins: (process.env.FRONTEND_ORIGIN || 'http://localhost:5174')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  feedPollIntervalMs: num('FEED_POLL_INTERVAL_MS', 300_000),
  kalshiSeriesLimit: num('KALSHI_SERIES_LIMIT', 24),
  polymarketQueryLimit: num('POLYMARKET_QUERY_LIMIT', 8),
};

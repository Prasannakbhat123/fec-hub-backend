import express from 'express';
import cors from 'cors';
import { connectDb } from './db/connect.js';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error.js';
import { marketsRouter, healthRouter } from './routes/markets.js';
import { startFeedScheduler } from './services/feeds/runner.js';

async function main() {
  await connectDb();

  const app = express();
  const corsOrigin = env.frontendOrigins.length > 0 ? env.frontendOrigins : true;
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'fec-hub' }));
  app.use('/v1/markets', marketsRouter);
  app.use('/v1/health', healthRouter);

  app.use(errorHandler);

  startFeedScheduler();

  app.listen(env.port, '0.0.0.0', () => {
    console.log(`[fec-hub] API listening on port ${env.port}`);
  });
}

main().catch((err) => {
  console.error('[fec-hub] fatal', err);
  process.exit(1);
});

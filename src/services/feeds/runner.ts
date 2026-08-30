import { env } from '../../config/env.js';
import { ingestKalshi } from './kalshi.js';
import { ingestPolymarket } from './polymarket.js';

let running = false;

export async function runIngestOnce(): Promise<{ kalshi: number; polymarket: number }> {
  if (running) {
    console.log('[feeds] ingest already running, skip');
    return { kalshi: 0, polymarket: 0 };
  }
  running = true;
  try {
    console.log('[feeds] ingest start');
    // Sequential so one slow venue does not stall the other indefinitely in Promise.all
    const polymarket = await ingestPolymarket();
    const kalshi = await ingestKalshi();
    console.log(`[feeds] ingest done kalshi=${kalshi} polymarket=${polymarket}`);
    return { kalshi, polymarket };
  } finally {
    running = false;
  }
}

export function startFeedScheduler(): void {
  void runIngestOnce();
  setInterval(() => {
    void runIngestOnce();
  }, env.feedPollIntervalMs);
  console.log(`[feeds] scheduler every ${env.feedPollIntervalMs}ms`);
}

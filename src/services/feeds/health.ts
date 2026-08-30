export type FeedHealth = {
  name: string;
  enabled: boolean;
  lastSuccessAt?: string;
  lastError?: string;
  lastCount?: number;
};

const health = new Map<string, FeedHealth>();

export function setFeedHealth(h: FeedHealth): void {
  health.set(h.name, { ...health.get(h.name), ...h });
}

export function getFeedHealth(): FeedHealth[] {
  return Array.from(health.values());
}

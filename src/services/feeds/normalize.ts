import type { FecCategory } from '../../models/FecMarket.js';

const DENY =
  /\b(nba|nfl|mlb|nhl|soccer|football|tennis|ufc|boxing|premier league|world cup|oscar|grammy|emmy|celebrity|trump|biden|harris|election|democrat|republican|senate race|presidential|oscar|super bowl)\b/i;

const RATES =
  /\b(fed|fomc|interest rate|rate cut|rate hike|sofr|treasury|yield|central bank|monetary|cpi|inflation|pce)\b/i;
const MACRO =
  /\b(gdp|recession|unemployment|jobs|nfp|payroll|debt|deficit|permits|ifo|macro)\b/i;
const EQUITIES =
  /\b(s&p|spx|nasdaq|dow|stock|equity|ipo|earnings|kpi|share)\b/i;
const ENERGY = /\b(oil|crude|gas|energy|barrel|opec|electricity|power)\b/i;
const FX = /\b(fx|forex|usd|eur|gbp|yen|currency|dollar|euro)\b/i;

export function isDeniedTitle(title: string): boolean {
  return DENY.test(title);
}

export function categorizeTitle(title: string, seriesHint = ''): FecCategory {
  const t = `${title} ${seriesHint}`;
  if (RATES.test(t)) return 'rates';
  if (ENERGY.test(t)) return 'energy';
  if (FX.test(t)) return 'fx';
  if (EQUITIES.test(t)) return 'equities';
  if (MACRO.test(t)) return 'macro';
  return 'other_financial';
}

/** Normalize title into match tokens for cross-venue heuristic pairing. */
export function matchTokens(title: string): string[] {
  const stop = new Set([
    'will',
    'the',
    'a',
    'an',
    'be',
    'of',
    'in',
    'on',
    'at',
    'for',
    'to',
    'by',
    'and',
    'or',
    'above',
    'below',
    'than',
    'before',
    'after',
    'next',
    'this',
    'that',
    'how',
    'many',
    'what',
    'which',
    'who',
    'when',
  ]);
  return title
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 12);
}

export function matchGroupId(tokens: string[]): string {
  const key = [...tokens].sort().slice(0, 5).join('-');
  return key || 'ungrouped';
}

export function parseYesPrice(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n > 1 && n <= 100) return n / 100;
  if (n < 0) return 0;
  if (n > 1) return Math.min(n / 100, 1);
  return n;
}

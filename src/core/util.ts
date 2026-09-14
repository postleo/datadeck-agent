// ─────────────────────────────────────────────────────────────
// DataDeck Agent — value parsing & normalization helpers
// Pure, deterministic functions used by detection and cleaning.
// ─────────────────────────────────────────────────────────────

export const DEFAULT_MISSING_TOKENS = [
  '',
  'na',
  'n/a',
  'null',
  'none',
  'nil',
  '-',
  '--',
  'n.a.',
  'nan',
  'undefined',
];

/** Is a raw cell considered "missing"? */
export function isMissing(raw: string | null, missingTokens = DEFAULT_MISSING_TOKENS): boolean {
  if (raw === null || raw === undefined) return true;
  const t = raw.trim().toLowerCase();
  return missingTokens.includes(t);
}

/** Collapse internal runs of whitespace and trim the ends. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function hasWhitespaceIssue(s: string): boolean {
  return s !== s.trim() || /\s{2,}/.test(s) || /\t/.test(s);
}

// ── Numbers ─────────────────────────────────────────────────

/** Try to read a plain number, tolerating thousands separators. */
export function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '');
  if (s === '' || !/^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function isInteger(raw: string): boolean {
  const s = raw.trim().replace(/,/g, '');
  return /^[-+]?\d+$/.test(s);
}

// ── Currency ────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
  '₹': 'INR',
};

const CURRENCY_CODES = ['USD', 'GBP', 'EUR', 'JPY', 'INR', 'CAD', 'AUD', 'CHF', 'CNY'];

export interface Money {
  amount: number;
  currency: string | null;
}

/** Parse a money-looking string into an amount + currency code. */
export function parseMoney(raw: string): Money | null {
  let s = raw.trim();
  if (s === '') return null;
  let currency: string | null = null;

  // Leading/trailing symbol
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (s.includes(sym)) {
      currency = code;
      s = s.split(sym).join('');
      break;
    }
  }
  // Trailing/leading ISO code, e.g. "1200 USD" or "USD 1200"
  const codeMatch = s.match(new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`, 'i'));
  if (codeMatch) {
    currency = codeMatch[1].toUpperCase();
    s = s.replace(codeMatch[0], '');
  }

  const amount = parseNumber(s.replace(/\s/g, ''));
  if (amount === null) return null;
  // Only call it money if there was a currency marker OR it clearly had grouping/decimals with a symbol.
  return { amount, currency };
}

export function looksLikeCurrency(raw: string): boolean {
  const s = raw.trim();
  if (s === '') return false;
  if (/[$£€¥₹]/.test(s)) return parseMoney(s) !== null;
  if (new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`, 'i').test(s)) return parseMoney(s) !== null;
  return false;
}

// ── Booleans ────────────────────────────────────────────────

const TRUE_TOKENS = ['true', 'yes', 'y', 't'];
const FALSE_TOKENS = ['false', 'no', 'n', 'f'];

export function parseBoolean(raw: string): boolean | null {
  const t = raw.trim().toLowerCase();
  if (TRUE_TOKENS.includes(t)) return true;
  if (FALSE_TOKENS.includes(t)) return false;
  return null;
}

// ── Dates ───────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export interface DateParts {
  year: number;
  month: number; // 1..12, or 0 if unknown
  day: number; // 1..31, or 0 if unknown
  /** True when the numeric day/month order could not be resolved from this value alone. */
  ambiguous: boolean;
  /** The two candidate numeric parts, when the format was N?/N?/YYYY. */
  numericParts?: [number, number, number];
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format DateParts to ISO YYYY-MM-DD (assumes month/day resolved). */
export function toISO(d: DateParts): string {
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/**
 * Parse a date string. Recognizes ISO, textual months, and N/N/YYYY.
 * For the numeric slash/dash form, day/month order is left `ambiguous`
 * when both parts are <= 12 — the caller resolves it per-column.
 */
export function parseDateLoose(raw: string): DateParts | null {
  const s = raw.trim();
  if (s === '') return null;

  // ISO: YYYY-MM-DD (optionally with time)
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day, ambiguous: false };
    }
  }

  // Textual month: "12 Jan 2025", "Jan 12, 2025", "January 12 2025"
  const txt = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (txt) {
    const day = Number(txt[1]);
    const month = MONTHS[txt[2].toLowerCase().slice(0, txt[2].toLowerCase().startsWith('sept') ? 4 : 3)];
    const year = Number(txt[3]);
    if (month && day >= 1 && day <= 31) return { year, month, day, ambiguous: false };
  }
  const txt2 = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (txt2) {
    const month = MONTHS[txt2[1].toLowerCase().slice(0, txt2[1].toLowerCase().startsWith('sept') ? 4 : 3)];
    const day = Number(txt2[2]);
    const year = Number(txt2[3]);
    if (month && day >= 1 && day <= 31) return { year, month, day, ambiguous: false };
  }

  // Numeric with separators: D/M/YYYY, M/D/YYYY, D-M-YYYY, YYYY/M/D
  const num = s.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/);
  if (num) {
    const p1 = Number(num[1]);
    const p2 = Number(num[2]);
    const p3 = Number(num[3]);

    // YYYY first
    if (p1 > 31 && p2 >= 1 && p2 <= 12 && p3 >= 1 && p3 <= 31) {
      return { year: p1, month: p2, day: p3, ambiguous: false };
    }
    // YYYY last
    if (p3 > 31) {
      const year = p3;
      if (p1 > 12 && p2 >= 1 && p2 <= 12) return { year, month: p2, day: p1, ambiguous: false }; // DMY
      if (p2 > 12 && p1 >= 1 && p1 <= 12) return { year, month: p1, day: p2, ambiguous: false }; // MDY
      if (p1 <= 12 && p2 <= 12) {
        // Cannot tell DMY vs MDY from this value alone.
        return { year, month: 0, day: 0, ambiguous: true, numericParts: [p1, p2, p3] };
      }
    }
  }

  return null;
}

/** Resolve an ambiguous numeric date once the column's order is known. */
export function resolveAmbiguousDate(d: DateParts, order: 'DMY' | 'MDY'): DateParts | null {
  if (!d.ambiguous || !d.numericParts) return d;
  const [p1, p2, p3] = d.numericParts;
  if (order === 'DMY') return { year: p3, month: p2, day: p1, ambiguous: false };
  return { year: p3, month: p1, day: p2, ambiguous: false };
}

// ── Stats helpers ───────────────────────────────────────────

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedAsc[base + 1] !== undefined) {
    return sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]);
  }
  return sortedAsc[base];
}

export function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

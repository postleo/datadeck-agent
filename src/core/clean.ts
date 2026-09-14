// ─────────────────────────────────────────────────────────────
// DataDeck Agent — the cleaning step (the "draft" + "check")
// Applies safe auto-fixes, merges duplicates, and flags anything
// genuinely ambiguous for a human. Never deletes/invents data.
// ─────────────────────────────────────────────────────────────
import type {
  Table, Raw, CleanResult, ChangeRecord, FlagRecord, ChangeSummaryItem,
  FixType, CleaningOptions, DatasetProfile, ColumnProfile,
} from './types';
import { profileTable } from './detect';
import {
  isMissing, normalizeWhitespace, hasWhitespaceIssue, DEFAULT_MISSING_TOKENS,
  parseNumber, isInteger, parseMoney, parseBoolean,
  parseDateLoose, resolveAmbiguousDate, toISO, quantile,
} from './util';

const FIX_LABELS: Record<FixType, string> = {
  trim_whitespace: 'Whitespace trimmed / blank markers unified',
  standardize_date: 'Dates standardized to YYYY-MM-DD',
  unify_case: 'Labels/casing made consistent',
  normalize_number: 'Numbers cleaned (grouping removed)',
  convert_currency: 'Currency values normalized/converted',
  merge_duplicates: 'Duplicate rows merged',
};

/** Build a canonical surface form per lowercase key (most frequent wins). */
function buildCanonicalMap(values: string[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const raw of values) {
    const surface = normalizeWhitespace(raw);
    const key = surface.toLowerCase();
    if (!counts.has(key)) counts.set(key, new Map());
    const m = counts.get(key)!;
    m.set(surface, (m.get(surface) ?? 0) + 1);
  }
  const canonical = new Map<string, string>();
  for (const [key, surfaces] of counts) {
    let best = '';
    let bestCount = -1;
    for (const [surface, c] of surfaces) {
      if (c > bestCount) {
        bestCount = c;
        best = surface;
      }
    }
    canonical.set(key, best);
  }
  return canonical;
}

function columnValues(table: Table, index: number, missingTokens: string[]): string[] {
  const out: string[] = [];
  for (const row of table.rows) {
    const v = row[index];
    if (!isMissing(v, missingTokens)) out.push(v as string);
  }
  return out;
}

export function cleanTable(table: Table, options: CleaningOptions = {}): CleanResult {
  const missingTokens = options.missingTokens ?? DEFAULT_MISSING_TOKENS;
  const profile: DatasetProfile = profileTable(table);
  const changes: ChangeRecord[] = [];
  const flags: FlagRecord[] = [];
  const rowTouched = new Set<number>();
  const rowFlagged = new Set<number>();

  // Precompute per-column helpers.
  const canonicalMaps = new Map<number, Map<string, string>>();
  for (const col of profile.columns) {
    if (col.detectedType === 'category' || col.detectedType === 'boolean') {
      canonicalMaps.set(col.index, buildCanonicalMap(columnValues(table, col.index, missingTokens)));
    }
  }

  // Working copy aligned 1:1 with the original rows.
  const work: Raw[][] = table.rows.map((r) => [...r]);

  const record = (c: ChangeRecord) => {
    changes.push(c);
    if (c.rowIndex !== undefined) rowTouched.add(c.rowIndex);
  };
  const flag = (f: FlagRecord) => {
    flags.push(f);
    rowFlagged.add(f.rowIndex);
  };

  for (const col of profile.columns) {
    const ci = col.index;
    for (let ri = 0; ri < work.length; ri++) {
      const original = work[ri][ci];
      if (original === null) continue;

      // A recognized missing marker -> blank (still missing, just unified).
      if (isMissing(original, missingTokens) && original.trim() !== '') {
        record({ type: 'trim_whitespace', column: col.name, rowIndex: ri, before: original, after: '', why: `standardized the missing marker "${original.trim()}" to a blank` });
        work[ri][ci] = null;
        continue;
      }
      if (isMissing(original, missingTokens)) continue;

      // Step 1: whitespace trim (applies to every type).
      let value = original;
      if (hasWhitespaceIssue(value)) {
        const trimmed = normalizeWhitespace(value);
        record({ type: 'trim_whitespace', column: col.name, rowIndex: ri, before: value, after: trimmed, why: 'removed stray or doubled whitespace' });
        value = trimmed;
      }
      // Persist the (possibly trimmed) value now, so a no-op type fix can't lose it.
      work[ri][ci] = value;

      // Step 2: type-specific normalization.
      const out = applyTypeFix(col, value, ri, options, canonicalMaps.get(ci));
      if (out.flag) flag(out.flag);
      if (out.value !== undefined) {
        if (out.value !== value) {
          record({ type: out.type!, column: col.name, rowIndex: ri, before: value, after: out.value, why: out.why! });
        }
        work[ri][ci] = out.value;
      }
    }
  }

  // Value-based flags that need the whole column: outliers.
  flagOutliers(table, work, profile, flag);
  // Missing values in otherwise-complete columns.
  flagMissingInCompleteColumns(table, profile, missingTokens, flag);

  // Merge exact/near duplicate rows (after fixes, so case/space diffs collapse).
  const seen = new Map<string, number>();
  const finalRows: Raw[][] = [];
  for (let ri = 0; ri < work.length; ri++) {
    const key = work[ri].map((c) => (c === null ? '' : c.trim().toLowerCase())).join('\u0001');
    if (seen.has(key)) {
      record({ type: 'merge_duplicates', rowIndex: ri, why: `row is a duplicate of row ${seen.get(key)! + 1}; kept the first copy` });
    } else {
      seen.set(key, ri);
      finalRows.push(work[ri]);
    }
  }

  const cleaned: Table = { headers: [...table.headers], rows: finalRows, source: table.source };

  // Summaries.
  const byType = new Map<FixType, number>();
  for (const c of changes) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  const changeSummary: ChangeSummaryItem[] = [...byType.entries()].map(([type, count]) => ({
    type, label: FIX_LABELS[type], count,
  }));

  const untouched = new Set<number>();
  for (let ri = 0; ri < table.rows.length; ri++) {
    if (!rowTouched.has(ri) && !rowFlagged.has(ri)) untouched.add(ri);
  }

  return {
    cleaned,
    original: table,
    profile,
    changes,
    changeSummary,
    flags,
    untouchedRowCount: untouched.size,
  };
}

interface FixOutcome {
  value?: string;
  type?: FixType;
  why?: string;
  flag?: FlagRecord;
}

function applyTypeFix(
  col: ColumnProfile,
  value: string,
  ri: number,
  options: CleaningOptions,
  canonical?: Map<string, string>,
): FixOutcome {
  switch (col.detectedType) {
    case 'date': {
      const d = parseDateLoose(value);
      if (!d) return {};
      if (d.ambiguous) {
        if (col.dateOrder === 'DMY' || col.dateOrder === 'MDY') {
          const resolved = resolveAmbiguousDate(d, col.dateOrder);
          if (resolved) return { value: toISO(resolved), type: 'standardize_date', why: `reformatted to ISO date using the column's ${col.dateOrder} order` };
        }
        return {
          flag: {
            rowIndex: ri, column: col.name, value, reason: 'ambiguous_date', severity: 'medium',
            why: `the date "${value}" could be read as either day/month or month/day, and the column doesn't make the order clear`,
          },
        };
      }
      return { value: toISO(d), type: 'standardize_date', why: 'reformatted to ISO date (YYYY-MM-DD)' };
    }
    case 'currency': {
      const m = parseMoney(value);
      if (!m) return {};
      const base = options.baseCurrency;
      const rates = options.exchangeRates;
      const colCurrencies = col.currencies ?? [];
      const mixed = colCurrencies.length > 1;
      if (mixed && (!rates || !base)) {
        return {
          flag: {
            rowIndex: ri, column: col.name, value, reason: 'mixed_currency', severity: 'high',
            why: `this column mixes currencies (${colCurrencies.join(', ')}); converting needs exchange rates, so it's left for you`,
          },
        };
      }
      if (m.currency && base && rates && m.currency !== base) {
        const rate = rates[m.currency];
        if (rate) {
          const converted = (m.amount * rate).toFixed(2);
          return { value: converted, type: 'convert_currency', why: `converted ${m.amount} ${m.currency} to ${converted} ${base}` };
        }
      }
      const normalized = m.amount.toFixed(2);
      if (normalized !== value) return { value: normalized, type: 'convert_currency', why: 'removed currency symbol/grouping and normalized the amount' };
      return {};
    }
    case 'integer':
    case 'number': {
      const n = parseNumber(value);
      if (n === null) return {};
      const out = isInteger(value) && col.detectedType === 'integer' ? String(Math.trunc(n)) : String(n);
      if (out !== value) return { value: out, type: 'normalize_number', why: 'removed thousands separators / normalized the number' };
      return {};
    }
    case 'boolean': {
      const b = parseBoolean(value);
      if (b === null) return {};
      const out = b ? 'true' : 'false';
      if (out !== value) return { value: out, type: 'unify_case', why: `standardized the yes/no value to "${out}"` };
      return {};
    }
    case 'category': {
      if (!canonical) return {};
      const key = normalizeWhitespace(value).toLowerCase();
      const canon = canonical.get(key);
      if (canon && canon !== value) return { value: canon, type: 'unify_case', why: `unified the label to the most common spelling "${canon}"` };
      return {};
    }
    default:
      return {};
  }
}

function flagOutliers(
  table: Table,
  work: Raw[][],
  profile: DatasetProfile,
  flag: (f: FlagRecord) => void,
): void {
  for (const col of profile.columns) {
    if (!['integer', 'number', 'currency'].includes(col.detectedType)) continue;
    const pairs: { ri: number; v: number }[] = [];
    for (let ri = 0; ri < work.length; ri++) {
      const cell = work[ri][col.index];
      if (cell === null) continue;
      const n = parseNumber(cell);
      if (n !== null) pairs.push({ ri, v: n });
    }
    if (pairs.length < 8) continue;
    const sorted = pairs.map((p) => p.v).sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    if (iqr === 0) continue;
    const lo = q1 - 3 * iqr;
    const hi = q3 + 3 * iqr;
    for (const p of pairs) {
      if (p.v < lo || p.v > hi) {
        flag({
          rowIndex: p.ri, column: col.name, value: String(p.v), reason: 'possible_outlier', severity: 'low',
          why: `${p.v} sits far outside the usual range for "${col.name}" (typical values are roughly ${Math.round(lo)}–${Math.round(hi)})`,
        });
      }
    }
  }
}

function flagMissingInCompleteColumns(
  table: Table,
  profile: DatasetProfile,
  missingTokens: string[],
  flag: (f: FlagRecord) => void,
): void {
  for (const col of profile.columns) {
    if (col.detectedType === 'empty') continue;
    if (col.fillRate < 0.9 || col.fillRate >= 1) continue;
    for (let ri = 0; ri < table.rows.length; ri++) {
      const v = table.rows[ri][col.index];
      if (isMissing(v, missingTokens)) {
        flag({
          rowIndex: ri, column: col.name, value: '', reason: 'missing_in_complete_column', severity: 'medium',
          why: `"${col.name}" is filled in for ${Math.round(col.fillRate * 100)}% of rows, but this one is blank`,
        });
      }
    }
  }
}

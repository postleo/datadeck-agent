// ─────────────────────────────────────────────────────────────
// DataDeck Agent — detection / profiling
// Builds an honest picture of a table before anything is changed.
// ─────────────────────────────────────────────────────────────
import type { Table, ColumnProfile, ColumnType, DatasetProfile } from './types';
import {
  isMissing,
  isInteger,
  parseNumber,
  looksLikeCurrency,
  parseMoney,
  parseBoolean,
  parseDateLoose,
  hasWhitespaceIssue,
  DEFAULT_MISSING_TOKENS,
} from './util';

function columnValues(table: Table, index: number): string[] {
  const out: string[] = [];
  for (const row of table.rows) {
    const v = row[index];
    if (!isMissing(v)) out.push((v as string));
  }
  return out;
}

/** Decide the day/month order for a date column by scanning all values. */
function inferDateOrder(values: string[]): 'ISO' | 'DMY' | 'MDY' | 'ambiguous' {
  let sawDMY = false;
  let sawMDY = false;
  let sawISO = false;
  let sawAmbiguous = false;
  for (const v of values) {
    const d = parseDateLoose(v);
    if (!d) continue;
    if (!d.ambiguous && d.numericParts === undefined) {
      // Could be ISO or textual; treat 4-digit-first as ISO signal.
      if (/^\d{4}[/\-.]/.test(v.trim())) sawISO = true;
      continue;
    }
    if (d.ambiguous) {
      sawAmbiguous = true;
    } else if (d.numericParts) {
      // resolved numeric — figure out which order it implied
      const [p1, p2] = d.numericParts;
      if (p1 > 12) sawDMY = true;
      else if (p2 > 12) sawMDY = true;
    }
  }
  if (sawDMY && !sawMDY) return 'DMY';
  if (sawMDY && !sawDMY) return 'MDY';
  if (sawISO && !sawAmbiguous && !sawDMY && !sawMDY) return 'ISO';
  if (sawAmbiguous || (sawDMY && sawMDY)) return 'ambiguous';
  return 'ISO';
}

function classifyColumn(name: string, index: number, values: string[], totalRows: number): ColumnProfile {
  const total = totalRows;
  const nonMissing = values.length;
  const missing = total - nonMissing;
  const uniqueSet = new Set(values.map((v) => v.trim().toLowerCase()));
  const sampleValues = values.slice(0, 5);
  const formatIssues: string[] = [];

  if (nonMissing === 0) {
    return {
      name, index, detectedType: 'empty', typeConfidence: 1,
      total, missing, fillRate: 0, unique: 0, sampleValues, formatIssues,
    };
  }

  // Count how many values match each type.
  let dateCount = 0, currencyCount = 0, intCount = 0, numCount = 0, boolCount = 0;
  const currencies = new Set<string>();
  let whitespaceIssues = 0;

  for (const v of values) {
    if (hasWhitespaceIssue(v)) whitespaceIssues++;
    if (parseDateLoose(v)) dateCount++;
    if (looksLikeCurrency(v)) {
      currencyCount++;
      const m = parseMoney(v);
      if (m?.currency) currencies.add(m.currency);
    }
    if (isInteger(v)) intCount++;
    else if (parseNumber(v) !== null) numCount++;
    if (parseBoolean(v) !== null) boolCount++;
  }

  const frac = (n: number) => n / nonMissing;
  let detectedType: ColumnType = 'text';
  let typeConfidence = 0.5;

  if (frac(boolCount) >= 0.95 && uniqueSet.size <= 3) {
    detectedType = 'boolean';
    typeConfidence = frac(boolCount);
  } else if (frac(currencyCount) >= 0.6) {
    detectedType = 'currency';
    typeConfidence = frac(currencyCount);
  } else if (frac(dateCount) >= 0.7) {
    detectedType = 'date';
    typeConfidence = frac(dateCount);
  } else if (frac(intCount) >= 0.9) {
    detectedType = 'integer';
    typeConfidence = frac(intCount);
  } else if (frac(intCount + numCount) >= 0.9) {
    detectedType = 'number';
    typeConfidence = frac(intCount + numCount);
  } else if (uniqueSet.size <= Math.max(20, nonMissing * 0.2) && uniqueSet.size < nonMissing) {
    detectedType = 'category';
    typeConfidence = 0.7;
  } else {
    detectedType = 'text';
    typeConfidence = 0.6;
  }

  const profile: ColumnProfile = {
    name, index, detectedType, typeConfidence: Math.round(typeConfidence * 100) / 100,
    total, missing, fillRate: Math.round((nonMissing / total) * 100) / 100,
    unique: uniqueSet.size, sampleValues, formatIssues,
  };

  // Format-issue notes
  if (whitespaceIssues > 0) {
    formatIssues.push(`${whitespaceIssues} value(s) have stray or doubled whitespace`);
  }
  if (detectedType === 'date') {
    profile.dateOrder = inferDateOrder(values);
    if (profile.dateOrder === 'ambiguous') {
      formatIssues.push('mixed or ambiguous date formats (day/month order unclear)');
    } else {
      // Note when dates appear in more than one written style.
      const styles = new Set(values.map((v) => v.trim().replace(/\d/g, '#')));
      if (styles.size > 1) formatIssues.push('dates written in more than one format');
    }
  }
  if (detectedType === 'currency') {
    profile.currencies = [...currencies];
    if (currencies.size > 1) {
      formatIssues.push(`more than one currency present (${[...currencies].join(', ')})`);
    }
  }
  if (detectedType === 'category') {
    // Detect case/label inconsistency: same value in different casings.
    const surfaceByKey = new Map<string, Set<string>>();
    for (const v of values) {
      const key = v.trim().toLowerCase();
      if (!surfaceByKey.has(key)) surfaceByKey.set(key, new Set());
      surfaceByKey.get(key)!.add(v.trim());
    }
    let inconsistent = 0;
    for (const set of surfaceByKey.values()) if (set.size > 1) inconsistent++;
    if (inconsistent > 0) {
      formatIssues.push(`${inconsistent} label(s) written inconsistently (e.g. different casing)`);
    }
  }

  return profile;
}

/** Count duplicate rows (exact after whitespace/case normalization). */
export function countDuplicateRows(table: Table): number {
  const seen = new Set<string>();
  let dups = 0;
  for (const row of table.rows) {
    const key = row.map((c) => (c === null ? '' : c.trim().toLowerCase())).join('\u0001');
    if (seen.has(key)) dups++;
    else seen.add(key);
  }
  return dups;
}

/** Build the full dataset profile. */
export function profileTable(table: Table): DatasetProfile {
  const columns = table.headers.map((h, i) => classifyColumn(h, i, columnValues(table, i), table.rows.length));
  const totalCells = table.rows.length * table.headers.length;
  const missingCells = columns.reduce((a, c) => a + c.missing, 0);
  return {
    rowCount: table.rows.length,
    columnCount: table.headers.length,
    columns,
    missingCells,
    totalCells,
    duplicateRowCount: countDuplicateRows(table),
  };
}

export { DEFAULT_MISSING_TOKENS };

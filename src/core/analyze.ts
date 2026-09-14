// ─────────────────────────────────────────────────────────────
// DataDeck Agent — pre-analysis (the "first look")
// Summary stats, distributions, and correlations. No heatmaps —
// relationships are returned as a ranked, labeled list.
// ─────────────────────────────────────────────────────────────
import type {
  Table, DatasetProfile, PreAnalysis, ColumnAnalysis, NumericStats,
  CategoryCount, CorrelationPair, ColumnType,
} from './types';
import { isMissing, parseNumber, mean, median, stdDev, quantile, round } from './util';

function numericColumnValues(table: Table, index: number): { ri: number; v: number }[] {
  const out: { ri: number; v: number }[] = [];
  for (let ri = 0; ri < table.rows.length; ri++) {
    const cell = table.rows[ri][index];
    if (cell === null || isMissing(cell)) continue;
    const n = parseNumber(cell);
    if (n !== null) out.push({ ri, v: n });
  }
  return out;
}

function numericStats(values: number[], missing: number): NumericStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    missing,
    min: sorted.length ? round(sorted[0], 4) : 0,
    max: sorted.length ? round(sorted[sorted.length - 1], 4) : 0,
    mean: round(mean(values), 4),
    median: round(median(values), 4),
    stdDev: round(stdDev(values), 4),
  };
}

function histogram(values: number[], buckets = 10): CategoryCount[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    return [{ value: String(round(min, 2)), count: values.length, share: 1 }];
  }
  const width = (max - min) / buckets;
  const counts = new Array(buckets).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx >= buckets) idx = buckets - 1;
    counts[idx]++;
  }
  return counts.map((count, i) => {
    const lo = min + i * width;
    const hi = lo + width;
    return {
      value: `${round(lo, 2)}–${round(hi, 2)}`,
      count,
      share: round(count / values.length, 4),
    };
  });
}

function topCategories(table: Table, index: number, limit = 12): { items: CategoryCount[]; unique: number } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const row of table.rows) {
    const cell = row[index];
    if (cell === null || isMissing(cell)) continue;
    const key = cell.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const items = sorted.slice(0, limit).map(([value, count]) => ({
    value, count, share: total ? round(count / total, 4) : 0,
  }));
  return { items, unique: counts.size };
}

/** Pearson correlation for two aligned numeric series. */
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

export function analyze(cleaned: Table, profile?: DatasetProfile): PreAnalysis {
  // Re-profile the cleaned table so analysis reflects the post-clean state.
  const columns: ColumnAnalysis[] = [];
  const numericSeries = new Map<string, Map<number, number>>(); // column -> (rowIndex -> value)
  const prof = profile;

  cleaned.headers.forEach((name, index) => {
    const colProfile = prof?.columns.find((c) => c.name === name && c.index === index);
    const type: ColumnType = colProfile?.detectedType ?? guessType(cleaned, index);
    const missing = countMissing(cleaned, index);
    const isNumeric = ['integer', 'number', 'currency'].includes(type);

    if (isNumeric) {
      const pairs = numericColumnValues(cleaned, index);
      const values = pairs.map((p) => p.v);
      const stats = numericStats(values, missing);
      const dist = histogram(values);
      // outliers via IQR
      const sorted = [...values].sort((a, b) => a - b);
      const q1 = quantile(sorted, 0.25);
      const q3 = quantile(sorted, 0.75);
      const iqr = q3 - q1;
      const outliers: number[] = [];
      if (iqr > 0) {
        const lo = q1 - 3 * iqr;
        const hi = q3 + 3 * iqr;
        for (const p of pairs) if (p.v < lo || p.v > hi) outliers.push(p.ri);
      }
      const seriesMap = new Map<number, number>();
      for (const p of pairs) seriesMap.set(p.ri, p.v);
      numericSeries.set(name, seriesMap);

      columns.push({
        name, type, missing, unique: new Set(values).size,
        numeric: stats, distribution: dist, distributionKind: 'histogram',
        outlierRowIndexes: outliers.length ? outliers : undefined,
      });
    } else {
      const { items, unique } = topCategories(cleaned, index);
      columns.push({
        name, type, missing, unique,
        distribution: items, distributionKind: 'categories',
      });
    }
  });

  // Correlations across numeric columns.
  const numericNames = [...numericSeries.keys()];
  const correlations: CorrelationPair[] = [];
  for (let i = 0; i < numericNames.length; i++) {
    for (let j = i + 1; j < numericNames.length; j++) {
      const a = numericSeries.get(numericNames[i])!;
      const b = numericSeries.get(numericNames[j])!;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [ri, av] of a) {
        if (b.has(ri)) {
          xs.push(av);
          ys.push(b.get(ri)!);
        }
      }
      if (xs.length >= 3) {
        const r = round(pearson(xs, ys), 3);
        if (Number.isFinite(r)) correlations.push({ a: numericNames[i], b: numericNames[j], r });
      }
    }
  }
  correlations.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  const highlights = buildHighlights(columns, correlations, cleaned.rows.length);

  return { columns, correlations: correlations.slice(0, 15), highlights };
}

function guessType(table: Table, index: number): ColumnType {
  let num = 0, total = 0;
  for (const row of table.rows) {
    const c = row[index];
    if (c === null || isMissing(c)) continue;
    total++;
    if (parseNumber(c) !== null) num++;
  }
  if (total === 0) return 'empty';
  return num / total >= 0.9 ? 'number' : 'text';
}

function countMissing(table: Table, index: number): number {
  let m = 0;
  for (const row of table.rows) if (row[index] === null || isMissing(row[index])) m++;
  return m;
}

function buildHighlights(columns: ColumnAnalysis[], correlations: CorrelationPair[], rowCount: number): string[] {
  const out: string[] = [];
  // Near-empty columns
  for (const c of columns) {
    const fill = rowCount ? 1 - c.missing / rowCount : 0;
    if (fill < 0.5) out.push(`"${c.name}" is more than half empty (only ${Math.round(fill * 100)}% filled).`);
  }
  // Strong relationships
  const strong = correlations.filter((c) => Math.abs(c.r) >= 0.7);
  for (const c of strong.slice(0, 3)) {
    const dir = c.r > 0 ? 'move together' : 'move in opposite directions';
    out.push(`"${c.a}" and "${c.b}" strongly ${dir} (correlation ${c.r}).`);
  }
  // Outliers
  for (const c of columns) {
    if (c.outlierRowIndexes && c.outlierRowIndexes.length) {
      out.push(`"${c.name}" has ${c.outlierRowIndexes.length} value(s) far outside the usual range.`);
    }
  }
  // Lopsided categories
  for (const c of columns) {
    if (c.distributionKind === 'categories' && c.distribution.length) {
      const top = c.distribution[0];
      if (top.share >= 0.8 && c.unique > 1) {
        out.push(`"${c.name}" is dominated by one value ("${top.value}" is ${Math.round(top.share * 100)}% of rows).`);
      }
    }
  }
  if (out.length === 0) out.push('Nothing unusual jumped out — the data looks evenly shaped.');
  return out;
}

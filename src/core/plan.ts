// ─────────────────────────────────────────────────────────────
// DataDeck Agent — AI-driven cleaning plan
//
// This is what makes DataDeck a real agent rather than a chat
// wrapper: the MODEL reasons about the data and produces a
// per-column plan (semantic category maps, column meaning, date
// order, currency target, validation rules, semantic anomalies).
// The functions here are the agent's HANDS — they execute the
// decisions the model made. They do not decide anything themselves.
// ─────────────────────────────────────────────────────────────
import type {
  Table, Raw, CleanResult, ChangeRecord, FlagRecord, ChangeSummaryItem, FixType, DatasetProfile,
} from './types';
import { profileTable } from './detect';
import {
  isMissing, normalizeWhitespace, hasWhitespaceIssue, DEFAULT_MISSING_TOKENS,
  parseNumber, parseMoney, parseDateLoose, resolveAmbiguousDate, toISO,
} from './util';

/** A validation rule the model attaches to a column (its judgement of what's valid). */
export interface ValidationRule {
  kind: 'nonempty' | 'regex' | 'range' | 'one_of';
  pattern?: string;
  min?: number;
  max?: number;
  allowed?: string[];
  /** Plain-language reason shown when a row fails. */
  message?: string;
}

/** The model's decision for a single column. */
export interface ColumnPlan {
  /** What the column means, in plain words (the model's inference). Informational. */
  meaning?: string;
  /** Trim/normalize whitespace (default true). */
  trim?: boolean;
  /** Standardize any dates in this column to ISO (YYYY-MM-DD). */
  toISODate?: boolean;
  /** How to read ambiguous numeric dates in this column. */
  dateOrder?: 'DMY' | 'MDY' | 'ISO';
  /** SEMANTIC category resolution: normalized-lowercase value -> canonical value.
   *  e.g. {"usa":"United States","u.s.a.":"United States","us":"United States"} */
  categoryMap?: Record<string, string>;
  /** Text case to unify to. */
  case?: 'title' | 'upper' | 'lower';
  /** Normalize plain numbers (strip grouping). */
  normalizeNumber?: boolean;
  /** Convert money in this column to this currency (needs `rates`). */
  currencyTarget?: string;
  /** A validation rule; failing rows are flagged (never deleted). */
  validate?: ValidationRule;
}

export interface CleaningPlan {
  /** Per-column decisions, keyed by the column's header name. */
  columns?: Record<string, ColumnPlan>;
  /** Merge duplicate rows. If keys given, dupes are decided on those columns only. */
  dedupe?: { enabled?: boolean; keys?: string[] };
  /** Exchange rates keyed by currency code (for any column with currencyTarget). */
  rates?: Record<string, number>;
  /** Values (case-insensitive) treated as missing. */
  missingTokens?: string[];
  /** The model's short summary of its reasoning (informational). */
  notes?: string;
}

const FIX_LABELS: Record<FixType, string> = {
  trim_whitespace: 'Whitespace trimmed / blank markers unified',
  standardize_date: 'Dates standardized to YYYY-MM-DD',
  unify_case: 'Labels/categories resolved & casing unified',
  normalize_number: 'Numbers cleaned (grouping removed)',
  convert_currency: 'Currency values normalized/converted',
  merge_duplicates: 'Duplicate rows merged',
};

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function validateValue(rule: ValidationRule, value: string): boolean {
  switch (rule.kind) {
    case 'nonempty':
      return value.trim() !== '';
    case 'regex':
      try { return new RegExp(rule.pattern ?? '').test(value); } catch { return true; }
    case 'range': {
      const n = parseNumber(value);
      if (n === null) return false;
      if (rule.min !== undefined && n < rule.min) return false;
      if (rule.max !== undefined && n > rule.max) return false;
      return true;
    }
    case 'one_of':
      return (rule.allowed ?? []).includes(value);
    default:
      return true;
  }
}

/** Execute the model's cleaning plan against a table. Deterministic; records everything. */
export function applyPlan(table: Table, plan: CleaningPlan): CleanResult {
  const missingTokens = plan.missingTokens ?? DEFAULT_MISSING_TOKENS;
  const rates = plan.rates ?? {};
  const profile: DatasetProfile = profileTable(table);
  const changes: ChangeRecord[] = [];
  const flags: FlagRecord[] = [];
  const rowTouched = new Set<number>();
  const rowFlagged = new Set<number>();
  const work: Raw[][] = table.rows.map((r) => [...r]);

  const record = (c: ChangeRecord) => { changes.push(c); if (c.rowIndex !== undefined) rowTouched.add(c.rowIndex); };
  const flag = (f: FlagRecord) => { flags.push(f); rowFlagged.add(f.rowIndex); };

  table.headers.forEach((name, ci) => {
    const cp = plan.columns?.[name];
    if (!cp) return; // columns the model didn't plan are passed through untouched
    const trim = cp.trim !== false;
    // Normalize the model's category-map keys so matching is case/space-insensitive
    // (the model often writes keys like "U.S.A." or "UK" rather than lowercased).
    const catLookup = cp.categoryMap
      ? new Map(Object.entries(cp.categoryMap).map(([k, v]) => [normalizeWhitespace(k).toLowerCase(), v]))
      : null;

    for (let ri = 0; ri < work.length; ri++) {
      const original = work[ri][ci];
      if (original === null) { runValidation(cp, name, ri, '', flag); continue; }
      if (isMissing(original, missingTokens)) { runValidation(cp, name, ri, '', flag); if (original.trim() !== '') { record({ type: 'trim_whitespace', column: name, rowIndex: ri, before: original, after: '', why: 'standardized a missing marker to a blank' }); work[ri][ci] = null; } continue; }

      let value = original;
      if (trim && hasWhitespaceIssue(value)) {
        const t = normalizeWhitespace(value);
        record({ type: 'trim_whitespace', column: name, rowIndex: ri, before: value, after: t, why: 'removed stray/doubled whitespace' });
        value = t;
      }
      work[ri][ci] = value;

      // SEMANTIC category resolution (the model's mapping).
      if (catLookup) {
        const canon = catLookup.get(normalizeWhitespace(value).toLowerCase());
        if (canon && canon !== value) {
          record({ type: 'unify_case', column: name, rowIndex: ri, before: value, after: canon, why: `resolved "${value}" to "${canon}" (agent's mapping)` });
          value = canon; work[ri][ci] = value;
        }
      }

      // Dates -> ISO, using the model's chosen order.
      if (cp.toISODate || cp.dateOrder) {
        const d = parseDateLoose(value);
        if (d) {
          if (d.ambiguous) {
            if (cp.dateOrder === 'DMY' || cp.dateOrder === 'MDY') {
              const r = resolveAmbiguousDate(d, cp.dateOrder);
              if (r) { const iso = toISO(r); if (iso !== value) { record({ type: 'standardize_date', column: name, rowIndex: ri, before: value, after: iso, why: `reformatted to ISO using the agent's ${cp.dateOrder} reading` }); value = iso; work[ri][ci] = iso; } }
            } else {
              flag({ rowIndex: ri, column: name, value, reason: 'ambiguous_date', severity: 'medium', why: `"${value}" is an ambiguous date and the agent did not set an order for this column` });
            }
          } else {
            const iso = toISO(d);
            if (iso !== value) { record({ type: 'standardize_date', column: name, rowIndex: ri, before: value, after: iso, why: 'reformatted to ISO (YYYY-MM-DD)' }); value = iso; work[ri][ci] = iso; }
          }
        }
      }

      // Currency conversion / normalization.
      if (cp.currencyTarget) {
        const m = parseMoney(value);
        if (m) {
          let out: string | null = null; let why = '';
          if (m.currency && m.currency !== cp.currencyTarget && rates[m.currency]) {
            out = (m.amount * rates[m.currency]).toFixed(2); why = `converted ${m.amount} ${m.currency} to ${out} ${cp.currencyTarget}`;
          } else if (m.currency && m.currency !== cp.currencyTarget) {
            flag({ rowIndex: ri, column: name, value, reason: 'mixed_currency', severity: 'high', why: `value is in ${m.currency} but target is ${cp.currencyTarget}, and no exchange rate was provided` });
          } else {
            out = m.amount.toFixed(2); why = 'removed currency symbol/grouping';
          }
          if (out !== null && out !== value) { record({ type: 'convert_currency', column: name, rowIndex: ri, before: value, after: out, why }); value = out; work[ri][ci] = out; }
        }
      }

      // Plain number normalization.
      if (cp.normalizeNumber) {
        const n = parseNumber(value);
        if (n !== null && String(n) !== value) { record({ type: 'normalize_number', column: name, rowIndex: ri, before: value, after: String(n), why: 'removed grouping / normalized number' }); value = String(n); work[ri][ci] = String(n); }
      }

      // Case unification (skip if a categoryMap already set a canonical form).
      if (cp.case && !cp.categoryMap) {
        const out = cp.case === 'upper' ? value.toUpperCase() : cp.case === 'lower' ? value.toLowerCase() : titleCase(value);
        if (out !== value) { record({ type: 'unify_case', column: name, rowIndex: ri, before: value, after: out, why: `unified case to ${cp.case}` }); value = out; work[ri][ci] = out; }
      }

      runValidation(cp, name, ri, value, flag);
    }
  });

  // Duplicate merge.
  if (plan.dedupe?.enabled) {
    const keyIdx = plan.dedupe.keys?.length
      ? plan.dedupe.keys.map((k) => table.headers.indexOf(k)).filter((i) => i >= 0)
      : table.headers.map((_, i) => i);
    const seen = new Map<string, number>();
    const finalRows: Raw[][] = [];
    for (let ri = 0; ri < work.length; ri++) {
      const key = keyIdx.map((i) => (work[ri][i] === null ? '' : (work[ri][i] as string).trim().toLowerCase())).join('\u0001');
      if (seen.has(key)) record({ type: 'merge_duplicates', rowIndex: ri, why: `duplicate of row ${seen.get(key)! + 1}; kept the first` });
      else { seen.set(key, ri); finalRows.push(work[ri]); }
    }
    return finish(table, { headers: [...table.headers], rows: finalRows, source: table.source }, profile, changes, flags, rowTouched, rowFlagged);
  }

  return finish(table, { headers: [...table.headers], rows: work, source: table.source }, profile, changes, flags, rowTouched, rowFlagged);
}

function runValidation(cp: ColumnPlan, name: string, ri: number, value: string, flag: (f: FlagRecord) => void): void {
  if (!cp.validate) return;
  if (!validateValue(cp.validate, value)) {
    flag({ rowIndex: ri, column: name, value, reason: 'failed_validation', severity: 'medium', why: cp.validate.message ?? `failed the ${cp.validate.kind} rule the agent set for "${name}"` });
  }
}

function finish(
  original: Table, cleaned: Table, profile: DatasetProfile,
  changes: ChangeRecord[], flags: FlagRecord[], rowTouched: Set<number>, rowFlagged: Set<number>,
): CleanResult {
  const byType = new Map<FixType, number>();
  for (const c of changes) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  const changeSummary: ChangeSummaryItem[] = [...byType.entries()].map(([type, count]) => ({ type, label: FIX_LABELS[type], count }));
  let untouched = 0;
  for (let ri = 0; ri < original.rows.length; ri++) if (!rowTouched.has(ri) && !rowFlagged.has(ri)) untouched++;
  return { cleaned, original, profile, changes, changeSummary, flags, untouchedRowCount: untouched };
}

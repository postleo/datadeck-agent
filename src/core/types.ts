// ─────────────────────────────────────────────────────────────
// DataDeck Agent — core data model
// ─────────────────────────────────────────────────────────────

/** A raw parsed cell. Everything comes in as a string (or null when empty). */
export type Raw = string | null;

/** A parsed table: headers plus rows aligned to those headers. */
export interface Table {
  headers: string[];
  rows: Raw[][];
  /** Where the data came from, e.g. a filename or sheet name. */
  source?: string;
}

export type ColumnType =
  | 'integer'
  | 'number'
  | 'currency'
  | 'date'
  | 'boolean'
  | 'category'
  | 'text'
  | 'empty';

export interface ColumnProfile {
  name: string;
  index: number;
  detectedType: ColumnType;
  /** 0..1 — how confident the detector is about the type. */
  typeConfidence: number;
  total: number;
  missing: number;
  fillRate: number;
  unique: number;
  sampleValues: string[];
  /** Plain-language descriptions of formatting problems found. */
  formatIssues: string[];
  /** For dates: the day/month order we inferred, if any. */
  dateOrder?: 'ISO' | 'DMY' | 'MDY' | 'ambiguous';
  /** For currency: the currency codes/symbols seen. */
  currencies?: string[];
}

export interface DatasetProfile {
  rowCount: number;
  columnCount: number;
  columns: ColumnProfile[];
  missingCells: number;
  totalCells: number;
  duplicateRowCount: number;
}

export type FixType =
  | 'trim_whitespace'
  | 'standardize_date'
  | 'unify_case'
  | 'normalize_number'
  | 'convert_currency'
  | 'merge_duplicates';

export interface ChangeRecord {
  type: FixType;
  column?: string;
  rowIndex?: number;
  before?: string;
  after?: string;
  /** Plain-language reason. */
  why: string;
}

export type FlagReason =
  | 'ambiguous_date'
  | 'unmappable_category'
  | 'possible_outlier'
  | 'mixed_currency'
  | 'missing_in_complete_column'
  | 'failed_validation'
  | 'semantic_anomaly';

export interface FlagRecord {
  rowIndex: number;
  column: string;
  value: string;
  reason: FlagReason;
  /** Plain-language explanation of why this needs a human. */
  why: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ChangeSummaryItem {
  type: FixType;
  label: string;
  count: number;
}

export interface CleanResult {
  /** The cleaned table (fixes applied, exact/near duplicates merged). */
  cleaned: Table;
  /** The original, untouched table. */
  original: Table;
  profile: DatasetProfile;
  changes: ChangeRecord[];
  changeSummary: ChangeSummaryItem[];
  flags: FlagRecord[];
  /** Rows left alone entirely (no changes and no flags). */
  untouchedRowCount: number;
}

// ── Pre-analysis ────────────────────────────────────────────

export interface NumericStats {
  count: number;
  missing: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
}

export interface CategoryCount {
  value: string;
  count: number;
  share: number;
}

export interface ColumnAnalysis {
  name: string;
  type: ColumnType;
  missing: number;
  unique: number;
  numeric?: NumericStats;
  /** For numeric: histogram buckets. For category/text: top values. */
  distribution: CategoryCount[];
  distributionKind: 'histogram' | 'categories';
  outlierRowIndexes?: number[];
}

export interface CorrelationPair {
  a: string;
  b: string;
  /** Pearson correlation, -1..1. */
  r: number;
}

export interface PreAnalysis {
  columns: ColumnAnalysis[];
  correlations: CorrelationPair[];
  highlights: string[];
}

export interface CleaningOptions {
  /** Target output date format is always ISO (YYYY-MM-DD). */
  /** Optional exchange rates keyed by currency code, relative to `baseCurrency`. */
  exchangeRates?: Record<string, number>;
  /** The currency to convert money columns into, when rates are available. */
  baseCurrency?: string;
  /** Values (case-insensitive) treated as "missing". */
  missingTokens?: string[];
}

// ─────────────────────────────────────────────────────────────
// DataDeck Agent — embeddable clean function
//
// A single entry point that runs the agent's in-process cleaning +
// pre-analysis engine and returns the FULL result (cleaned rows,
// column profiles, change log, flags, correlations, and per-column
// distributions) in a plain-JSON shape.
//
// This is bundled to a single ESM file (dist/embed.mjs) so the
// DataDeck web backend (plain JavaScript) can import and call the
// real agent engine in-process — no second service, no credentials.
// ─────────────────────────────────────────────────────────────
import DataDeck from './sdk/index';
import type { Table } from './core/types';

function tableToObjects(table: Table): Record<string, string>[] {
  return table.rows.map((row) => {
    const obj: Record<string, string> = {};
    table.headers.forEach((h, i) => {
      obj[h] = row[i] == null ? '' : String(row[i]);
    });
    return obj;
  });
}

export interface CleanEngineResult {
  headline: string;
  source: string;
  rowsIn: number;
  rowsOut: number;
  columnCount: number;
  changesMade: number;
  itemsFlagged: number;
  untouchedRows: number;
  duplicateRowCount: number;
  missingCells: number;
  totalCells: number;
  columnProfiles: Array<{
    name: string; detectedType: string; fillRate: number; unique: number;
    missing: number; total: number; formatIssues: string[]; dateOrder?: string; currencies?: string[];
  }>;
  cleanedHeaders: string[];
  cleanedRows: Record<string, string>[];
  originalRows: Record<string, string>[];
  changeSummary: Array<{ type: string; label: string; count: number }>;
  changes: Array<{ type: string; column?: string; rowIndex?: number; before?: string; after?: string; why: string }>;
  flags: Array<{ rowIndex: number; column: string; value: string; reason: string; why: string; severity: string }>;
  analysis: {
    highlights: string[];
    correlations: Array<{ a: string; b: string; r: number }>;
    columns: Array<{
      name: string; type: string; missing: number; unique: number;
      numeric: unknown; distribution: Array<{ value: string; count: number; share: number }>;
      distributionKind: string; outlierRowIndexes?: number[];
    }>;
  };
}

/** Run the agent's cleaning + pre-analysis engine on a file buffer. */
export async function cleanBuffer(
  input: Buffer | string,
  filename: string,
  sheet?: string,
): Promise<CleanEngineResult> {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'base64');
  const result = await DataDeck.clean(buffer, filename, {}, sheet);
  const { clean, analysis } = result;

  return {
    headline: DataDeck.headline(result),
    source: clean.original.source ?? filename,
    rowsIn: clean.original.rows.length,
    rowsOut: clean.cleaned.rows.length,
    columnCount: clean.profile.columnCount,
    changesMade: clean.changes.length,
    itemsFlagged: clean.flags.length,
    untouchedRows: clean.untouchedRowCount,
    duplicateRowCount: clean.profile.duplicateRowCount,
    missingCells: clean.profile.missingCells,
    totalCells: clean.profile.totalCells,
    columnProfiles: clean.profile.columns.map((c) => ({
      name: c.name, detectedType: c.detectedType, fillRate: c.fillRate, unique: c.unique,
      missing: c.missing, total: c.total, formatIssues: c.formatIssues,
      dateOrder: c.dateOrder, currencies: c.currencies,
    })),
    cleanedHeaders: clean.cleaned.headers,
    cleanedRows: tableToObjects(clean.cleaned),
    originalRows: tableToObjects(clean.original),
    changeSummary: clean.changeSummary,
    changes: clean.changes.slice(0, 500),
    flags: clean.flags,
    analysis: {
      highlights: analysis.highlights,
      correlations: analysis.correlations,
      columns: analysis.columns.map((c) => ({
        name: c.name, type: c.type, missing: c.missing, unique: c.unique,
        numeric: c.numeric ?? null, distribution: c.distribution,
        distributionKind: c.distributionKind, outlierRowIndexes: c.outlierRowIndexes,
      })),
    },
  };
}

export default cleanBuffer;

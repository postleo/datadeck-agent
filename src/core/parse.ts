// ─────────────────────────────────────────────────────────────
// DataDeck Agent — file parsing (CSV & Excel -> Table)
// CSV via papaparse (sync); Excel via exceljs (async).
// ─────────────────────────────────────────────────────────────
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import type { Table, Raw } from './types';

/** Detect a supported file kind from a filename. */
export function detectKind(filename: string): 'csv' | 'excel' | 'unknown' {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) return 'csv';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.xlsm')) return 'excel';
  return 'unknown';
}

function cleanCell(v: unknown): Raw {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s;
}

/** Parse CSV/TSV text into a Table. */
export function parseCsv(text: string, source?: string): Table {
  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
  });
  const data = (result.data as unknown as string[][]).filter((r) => Array.isArray(r));
  if (data.length === 0) return { headers: [], rows: [], source };

  const headers = data[0].map((h, i) => (h && String(h).trim() !== '' ? String(h).trim() : `column_${i + 1}`));
  const rows: Raw[][] = data.slice(1).map((r) => {
    const row: Raw[] = [];
    for (let i = 0; i < headers.length; i++) row.push(cleanCell(r[i]));
    return row;
  });
  return { headers, rows, source };
}

/** Convert an exceljs cell value to a raw string (or null). */
function excelCellToRaw(value: ExcelJS.CellValue): Raw {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    // Hyperlink cell: { text, hyperlink }
    if (typeof v.text === 'string') return v.text;
    // Rich text: { richText: [{ text }] }
    if (Array.isArray(v.richText)) return v.richText.map((r: { text?: string }) => r.text ?? '').join('');
    // Formula cell: { formula, result }
    if ('result' in v && v.result !== undefined && v.result !== null) {
      const r = v.result;
      return r instanceof Date ? r.toISOString().slice(0, 10) : String(r);
    }
    if ('error' in v) return String(v.error);
    return null;
  }
  return String(value);
}

/** Parse an Excel workbook (Buffer) into a Table. */
export async function parseExcel(buffer: Buffer, sheetName?: string, source?: string): Promise<Table> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = (sheetName ? wb.getWorksheet(sheetName) : undefined) ?? wb.worksheets[0];
  const sheetLabel = ws?.name ?? '';
  if (!ws || ws.rowCount === 0) {
    return { headers: [], rows: [], source: source ? `${source}#${sheetLabel}` : sheetLabel };
  }

  const width = ws.columnCount;
  const aoa: Raw[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const vals: Raw[] = [];
    for (let c = 1; c <= width; c++) vals.push(excelCellToRaw(row.getCell(c).value));
    aoa.push(vals);
  }
  if (aoa.length === 0) return { headers: [], rows: [], source: source ? `${source}#${sheetLabel}` : sheetLabel };

  const headerRow = aoa[0];
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    const h = headerRow[i];
    headers.push(h && String(h).trim() !== '' ? String(h).trim() : `column_${i + 1}`);
  }
  // Data rows: drop rows that are entirely empty.
  const rows: Raw[][] = aoa
    .slice(1)
    .filter((r) => r.some((c) => c !== null && String(c).trim() !== ''));

  return { headers, rows, source: source ? `${source}#${sheetLabel}` : sheetLabel };
}

/** List sheet names in an Excel workbook. */
export async function listSheets(buffer: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => ws.name);
}

/** Parse any supported file buffer into a Table, by filename. */
export async function parseFile(buffer: Buffer, filename: string, sheetName?: string): Promise<Table> {
  const kind = detectKind(filename);
  if (kind === 'excel') return parseExcel(buffer, sheetName, filename);
  if (kind === 'csv') return parseCsv(buffer.toString('utf8'), filename);
  // Fall back to CSV parsing for unknown text.
  return parseCsv(buffer.toString('utf8'), filename);
}

/** Serialize a Table back to CSV text. */
export function tableToCsv(table: Table): string {
  const rows = [table.headers, ...table.rows.map((r) => r.map((c) => (c === null ? '' : c)))];
  return Papa.unparse(rows, { quotes: true });
}

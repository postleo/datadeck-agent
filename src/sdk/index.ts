// ─────────────────────────────────────────────────────────────
// DataDeck Agent — integration SDK (developer kit)
//
// Two ways to integrate:
//   1) In-process: import { DataDeck } and call the engine directly
//      (no server, no credentials — pure deterministic cleaning).
//   2) Over HTTP: use DataDeckClient to talk to a running API server.
// ─────────────────────────────────────────────────────────────
import { profileTable } from '../core/detect';
import { parseFile, listSheets as listSheetsCore, tableToCsv, detectKind } from '../core/parse';
import {
  runPipelineOnBuffer,
  runPipelineOnPath,
  bundleZip,
  writeArtifacts,
  headline,
  type PipelineResult,
} from '../core/pipeline';
import { buildSummaryJson } from '../core/report';
import type {
  CleaningOptions,
  DatasetProfile,
  CleanResult,
  PreAnalysis,
} from '../core/types';

// Re-export the public types so integrators get full typing.
export type {
  CleaningOptions, DatasetProfile, CleanResult, PreAnalysis,
} from '../core/types';
export type { PipelineResult } from '../core/pipeline';
export type { BundleFiles } from '../core/zip';

// ── 1) In-process SDK ───────────────────────────────────────

export const DataDeck = {
  /** Inspect a file buffer without changing it. */
  async profile(buffer: Buffer, filename: string, sheet?: string): Promise<DatasetProfile> {
    const table = await parseFile(buffer, filename, sheet);
    return profileTable(table);
  },

  /** List sheet names in an Excel workbook buffer. */
  async sheets(buffer: Buffer, filename = 'workbook.xlsx'): Promise<string[]> {
    if (detectKind(filename) !== 'excel') return [];
    return listSheetsCore(buffer);
  },

  /** Clean + analyze a file buffer. Returns the full result (clean, analysis, artifacts). */
  clean(buffer: Buffer, filename: string, options: CleaningOptions = {}, sheet?: string): Promise<PipelineResult> {
    return runPipelineOnBuffer(buffer, filename, options, sheet);
  },

  /** Clean + analyze a file on disk. */
  cleanPath(filePath: string, options: CleaningOptions = {}, sheet?: string): Promise<PipelineResult> {
    return runPipelineOnPath(filePath, options, sheet);
  },

  /** Build the ZIP bundle (Buffer) from a pipeline result. */
  toZip(result: PipelineResult): Promise<Buffer> {
    return bundleZip(result);
  },

  /** Write all artifacts + the ZIP to a directory. */
  write(result: PipelineResult, outDir: string, baseName?: string) {
    return writeArtifacts(result, outDir, baseName);
  },

  /** A compact machine-readable summary of a result. */
  summary(result: PipelineResult): Record<string, unknown> {
    return { headline: headline(result), ...buildSummaryJson(result.clean, result.analysis) };
  },

  /** Serialize a cleaned result's table back to CSV text. */
  toCsv(result: PipelineResult): string {
    return tableToCsv(result.clean.cleaned);
  },

  headline,
};

// ── 2) HTTP client ──────────────────────────────────────────

export interface DataDeckClientOptions {
  /** Base URL of a running DataDeck Agent API, e.g. http://localhost:8787 */
  baseUrl: string;
  /** Optional fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface CleanQuery {
  sheet?: string;
  base?: string;
  rates?: Record<string, number>;
}

/** Talks to a running DataDeck Agent HTTP API. */
export class DataDeckClient {
  private baseUrl: string;
  private _fetch: typeof fetch;

  constructor(options: DataDeckClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this._fetch = options.fetch ?? fetch;
  }

  private form(file: Uint8Array | Blob, filename: string): FormData {
    const fd = new FormData();
    const blob = file instanceof Blob ? file : new Blob([file as unknown as BlobPart]);
    fd.append('file', blob, filename);
    return fd;
  }

  private query(q?: CleanQuery): string {
    if (!q) return '';
    const p = new URLSearchParams();
    if (q.sheet) p.set('sheet', q.sheet);
    if (q.base) p.set('base', q.base);
    if (q.rates) p.set('rates', JSON.stringify(q.rates));
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  async health(): Promise<{ ok: boolean; service: string; version: string }> {
    const res = await this._fetch(`${this.baseUrl}/health`);
    return res.json() as Promise<{ ok: boolean; service: string; version: string }>;
  }

  async profile(file: Uint8Array | Blob, filename: string, sheet?: string): Promise<DatasetProfile> {
    const res = await this._fetch(`${this.baseUrl}/profile${this.query({ sheet })}`, {
      method: 'POST',
      body: this.form(file, filename),
    });
    if (!res.ok) throw new Error(`profile failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<DatasetProfile>;
  }

  async sheets(file: Uint8Array | Blob, filename: string): Promise<string[]> {
    const res = await this._fetch(`${this.baseUrl}/sheets`, { method: 'POST', body: this.form(file, filename) });
    if (!res.ok) throw new Error(`sheets failed: ${res.status}`);
    const data = (await res.json()) as { sheets: string[] };
    return data.sheets;
  }

  /** Clean + analyze, returning the JSON summary. */
  async clean(file: Uint8Array | Blob, filename: string, q?: CleanQuery): Promise<Record<string, unknown>> {
    const res = await this._fetch(`${this.baseUrl}/clean${this.query(q)}`, {
      method: 'POST',
      body: this.form(file, filename),
    });
    if (!res.ok) throw new Error(`clean failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  /** Clean + analyze, returning the ZIP bundle bytes. */
  async bundle(file: Uint8Array | Blob, filename: string, q?: CleanQuery): Promise<Uint8Array> {
    const res = await this._fetch(`${this.baseUrl}/clean/bundle${this.query(q)}`, {
      method: 'POST',
      body: this.form(file, filename),
    });
    if (!res.ok) throw new Error(`bundle failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export default DataDeck;

// ─────────────────────────────────────────────────────────────
// DataDeck Agent — ZIP packaging
// Bundles the cleaned file + both reports into one download.
// ─────────────────────────────────────────────────────────────
import JSZip from 'jszip';
import type { CleanResult, PreAnalysis } from './types';
import { tableToCsv } from './parse';
import {
  renderCleaningReportHtml,
  renderAnalysisReportHtml,
  renderMarkdownSummary,
  buildSummaryJson,
} from './report';

export interface BundleFiles {
  'cleaned.csv': string;
  'cleaning-report.html': string;
  'analysis-report.html': string;
  'summary.md': string;
  'summary.json': string;
}

/** Produce every artifact as text (handy for surfaces that don't need a ZIP). */
export function buildArtifacts(result: CleanResult, analysis: PreAnalysis): BundleFiles {
  return {
    'cleaned.csv': tableToCsv(result.cleaned),
    'cleaning-report.html': renderCleaningReportHtml(result),
    'analysis-report.html': renderAnalysisReportHtml(analysis),
    'summary.md': renderMarkdownSummary(result, analysis),
    'summary.json': JSON.stringify(buildSummaryJson(result, analysis), null, 2),
  };
}

/** Build the ZIP bundle as a Node Buffer. */
export async function buildZip(result: CleanResult, analysis: PreAnalysis): Promise<Buffer> {
  const files = buildArtifacts(result, analysis);
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

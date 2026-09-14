// ─────────────────────────────────────────────────────────────
// DataDeck Agent — the pipeline orchestrator
// Draft -> Check -> Organize -> Follow up, in one call.
// This is pure, deterministic, and needs NO LLM or credentials.
// ─────────────────────────────────────────────────────────────
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CleanResult, PreAnalysis, CleaningOptions } from './types';
import { parseFile, detectKind, listSheets } from './parse';
import { cleanTable } from './clean';
import { applyPlan, type CleaningPlan } from './plan';
import { analyze } from './analyze';
import { buildArtifacts, buildZip, type BundleFiles } from './zip';

export interface PipelineResult {
  clean: CleanResult;
  analysis: PreAnalysis;
  artifacts: BundleFiles;
}

/** Run the whole thing on an in-memory file buffer. */
export async function runPipelineOnBuffer(
  buffer: Buffer,
  filename: string,
  options: CleaningOptions = {},
  sheetName?: string,
): Promise<PipelineResult> {
  const table = await parseFile(buffer, filename, sheetName);
  if (table.headers.length === 0) {
    throw new Error(`Could not read any columns from "${filename}". Is it a valid CSV or Excel file?`);
  }
  const clean = cleanTable(table, options);
  const analysis = analyze(clean.cleaned, clean.profile);
  const artifacts = buildArtifacts(clean, analysis);
  return { clean, analysis, artifacts };
}

/** Run the pipeline on a file path (auto mode). */
export async function runPipelineOnPath(
  filePath: string,
  options: CleaningOptions = {},
  sheetName?: string,
): Promise<PipelineResult> {
  const buffer = await fs.readFile(filePath);
  return await runPipelineOnBuffer(buffer, path.basename(filePath), options, sheetName);
}

/** Run the AGENT'S plan on an in-memory buffer (agentic mode — the model decided the plan). */
export async function runPlanOnBuffer(
  buffer: Buffer,
  filename: string,
  plan: CleaningPlan,
  sheetName?: string,
): Promise<PipelineResult> {
  const table = await parseFile(buffer, filename, sheetName);
  if (table.headers.length === 0) {
    throw new Error(`Could not read any columns from "${filename}". Is it a valid CSV or Excel file?`);
  }
  const clean = applyPlan(table, plan);
  const analysis = analyze(clean.cleaned, clean.profile);
  const artifacts = buildArtifacts(clean, analysis);
  return { clean, analysis, artifacts };
}

/** Run the agent's plan on a file path. */
export async function runPlanOnPath(
  filePath: string,
  plan: CleaningPlan,
  sheetName?: string,
): Promise<PipelineResult> {
  const buffer = await fs.readFile(filePath);
  return runPlanOnBuffer(buffer, path.basename(filePath), plan, sheetName);
}

/** Build the ZIP bundle from a pipeline result. */
export async function bundleZip(result: PipelineResult): Promise<Buffer> {
  return buildZip(result.clean, result.analysis);
}

/** Write all artifacts (and the ZIP) to an output directory. Returns the written paths. */
export async function writeArtifacts(
  result: PipelineResult,
  outDir: string,
  baseName = 'dataset',
): Promise<{ files: string[]; zip: string }> {
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(result.artifacts)) {
    const target = path.join(outDir, name);
    await fs.writeFile(target, content, 'utf8');
    written.push(target);
  }
  const zipBuf = await bundleZip(result);
  const zipPath = path.join(outDir, `${baseName}-datadeck.zip`);
  await fs.writeFile(zipPath, zipBuf);
  return { files: written, zip: zipPath };
}

/** A compact, human-readable one-liner summary (for CLI/Telegram headers). */
export function headline(result: PipelineResult): string {
  const { clean } = result;
  const flagged = clean.flags.length;
  const flagPart = flagged === 0
    ? 'nothing needs your review 🎉'
    : `${flagged} item(s) need your review`;
  return `Cleaned ${clean.original.rows.length} → ${clean.cleaned.rows.length} rows across ${clean.profile.columnCount} columns · ${clean.changes.length} changes · ${flagPart}.`;
}

export { detectKind, listSheets };

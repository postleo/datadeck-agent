// ─────────────────────────────────────────────────────────────
// DataDeck Agent — Strands tools (the agent's HANDS)
//
// These are granular on purpose so the MODEL drives the cleaning:
//   profile_dataset  -> understand the data
//   inspect_columns  -> see the actual messy values (to reason about them)
//   apply_cleaning_plan -> execute the plan the MODEL decided (semantic
//                          category maps, column meaning, date order,
//                          currency, validation rules)
//   quick_auto_clean -> deterministic fallback (no reasoning)
//   list_sheets      -> Excel sheets
// ─────────────────────────────────────────────────────────────
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { profileTable } from '../core/detect';
import { parseFile, listSheets as listSheetsCore, detectKind } from '../core/parse';
import { runPipelineOnPath, runPlanOnPath, writeArtifacts, headline } from '../core/pipeline';
import { FLAG_TITLES } from '../core/report';
import { isMissing } from '../core/util';
import type { FlagReason } from '../core/types';
import type { CleaningPlan } from '../core/plan';

async function readBuffer(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath);
}

/** Understand a file's shape (types, missing, duplicates, format issues, samples). */
export const profileDataset = tool({
  name: 'profile_dataset',
  description:
    'Inspect a CSV/Excel file and report its shape: for each column its detected type, fill rate, unique count, sample values, and formatting problems. Use this FIRST to understand the data before deciding how to clean it.',
  inputSchema: z.object({
    path: z.string().describe('Path to the CSV/Excel file'),
    sheet: z.string().optional().describe('Excel sheet name'),
  }),
  callback: async ({ path: filePath, sheet }) => {
    const table = await parseFile(await readBuffer(filePath), path.basename(filePath), sheet);
    if (table.headers.length === 0) return `Could not read any columns from "${filePath}".`;
    const profile = profileTable(table);
    const lines = [
      `File: ${path.basename(filePath)} — ${profile.rowCount} rows, ${profile.columnCount} columns. Missing ${profile.missingCells}/${profile.totalCells}; duplicate rows ${profile.duplicateRowCount}.`,
      'Columns:',
      ...profile.columns.map(
        (c) => `  • ${c.name} [type≈${c.detectedType}, ${Math.round(c.fillRate * 100)}% filled, ${c.unique} unique] samples: ${c.sampleValues.slice(0, 4).join(' | ')}${c.formatIssues.length ? ' — issues: ' + c.formatIssues.join('; ') : ''}`,
      ),
      'Next: for any column whose values look inconsistent (e.g. categories, mixed labels), call inspect_columns to see the actual distinct values, then build a cleaning plan.',
    ];
    return lines.join('\n');
  },
});

/** See the actual distinct values in columns — so the model can reason and build semantic maps. */
export const inspectColumns = tool({
  name: 'inspect_columns',
  description:
    "List the distinct values (with counts) in one or more columns, so you can reason about what they mean and build a semantic category map (e.g. decide that 'USA', 'U.S.A.' and 'United States' are the same). Use before mapping categories or setting validation rules.",
  inputSchema: z.object({
    path: z.string(),
    sheet: z.string().optional(),
    columns: z.array(z.string()).optional().describe('Column names to inspect (default: all)'),
    limit: z.number().optional().describe('Max distinct values per column (default 40)'),
  }),
  callback: async ({ path: filePath, sheet, columns, limit }) => {
    const table = await parseFile(await readBuffer(filePath), path.basename(filePath), sheet);
    if (table.headers.length === 0) return `Could not read any columns from "${filePath}".`;
    const cap = limit ?? 40;
    const targets = columns?.length ? columns : table.headers;
    const out: string[] = [];
    for (const name of targets) {
      const ci = table.headers.indexOf(name);
      if (ci < 0) { out.push(`(column "${name}" not found)`); continue; }
      const counts = new Map<string, number>();
      for (const row of table.rows) {
        const v = row[ci];
        if (v === null || isMissing(v)) continue;
        const key = v.trim();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const shown = sorted.slice(0, cap).map(([v, c]) => `${JSON.stringify(v)}×${c}`).join(', ');
      out.push(`${name} (${counts.size} distinct): ${shown}${sorted.length > cap ? ' …' : ''}`);
    }
    return out.join('\n');
  },
});

const validateSchema = z.object({
  kind: z.enum(['nonempty', 'regex', 'range', 'one_of']),
  pattern: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  allowed: z.array(z.string()).optional(),
  message: z.string().optional(),
});

const columnPlanSchema = z.object({
  meaning: z.string().optional().describe('What this column means, in plain words (your inference)'),
  trim: z.boolean().optional(),
  toISODate: z.boolean().optional().describe('Standardize dates in this column to ISO (YYYY-MM-DD)'),
  dateOrder: z.enum(['DMY', 'MDY', 'ISO']).optional().describe('How to read ambiguous numeric dates here'),
  categoryMap: z.record(z.string(), z.string()).optional()
    .describe('Semantic mapping: lowercased raw value -> canonical value, e.g. {"usa":"United States","us":"United States"}'),
  case: z.enum(['title', 'upper', 'lower']).optional(),
  normalizeNumber: z.boolean().optional(),
  currencyTarget: z.string().optional().describe('Convert money to this currency code (needs rates)'),
  validate: validateSchema.optional().describe('A rule; rows failing it are flagged, never deleted'),
});

const planSchema = z.object({
  columns: z.record(z.string(), columnPlanSchema).optional(),
  dedupe: z.object({ enabled: z.boolean().optional(), keys: z.array(z.string()).optional() }).optional(),
  rates: z.record(z.string(), z.number()).optional().describe('Exchange rates by currency code'),
  missingTokens: z.array(z.string()).optional(),
  notes: z.string().optional().describe('Your short reasoning summary'),
});

/** Execute the model's own cleaning plan. This is the primary, agentic path. */
export const applyCleaningPlan = tool({
  name: 'apply_cleaning_plan',
  description:
    'Execute YOUR cleaning plan on the file: per-column decisions you reasoned out — semantic category maps, date order, currency target, case, and validation rules. Applies them safely (flags, never deletes ambiguous/invalid rows), runs a pre-analysis, and writes the cleaned file + reports + ZIP. This is the main tool — decide the plan yourself after profiling/inspecting.',
  inputSchema: z.object({
    path: z.string(),
    sheet: z.string().optional(),
    outDir: z.string().optional().describe('Output directory (default ./out)'),
    plan: planSchema,
  }),
  callback: async ({ path: filePath, sheet, outDir, plan }) => {
    const result = await runPlanOnPath(filePath, plan as unknown as CleaningPlan, sheet);
    const written = await writeArtifacts(result, outDir ?? process.env.DATADECK_OUT_DIR ?? './out', path.basename(filePath).replace(/\.[^.]+$/, ''));
    return summarize(result, written);
  },
});

/** Deterministic fallback: clean with auto-detection, no reasoning. */
export const quickAutoClean = tool({
  name: 'quick_auto_clean',
  description:
    'Fallback only: run the deterministic auto-cleaner (no reasoning, fixed rules) and write outputs. Prefer building your own plan with apply_cleaning_plan; use this only for a fast pass or when the user explicitly asks for a plain auto-clean.',
  inputSchema: z.object({
    path: z.string(),
    sheet: z.string().optional(),
    outDir: z.string().optional(),
  }),
  callback: async ({ path: filePath, sheet, outDir }) => {
    const result = await runPipelineOnPath(filePath, {}, sheet);
    const written = await writeArtifacts(result, outDir ?? process.env.DATADECK_OUT_DIR ?? './out', path.basename(filePath).replace(/\.[^.]+$/, ''));
    return summarize(result, written);
  },
});

export const listSheets = tool({
  name: 'list_sheets',
  description: 'List the sheet names in an Excel workbook.',
  inputSchema: z.object({ path: z.string() }),
  callback: async ({ path: filePath }) => {
    if (detectKind(filePath) !== 'excel') return `"${path.basename(filePath)}" is not an Excel file.`;
    return `Sheets: ${(await listSheetsCore(await readBuffer(filePath))).join(', ')}`;
  },
});

function summarize(result: Awaited<ReturnType<typeof runPlanOnPath>>, written: { files: string[]; zip: string }): string {
  const byReason = new Map<FlagReason, number>();
  for (const f of result.clean.flags) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
  const lines = [headline(result), '', 'What changed:'];
  if (result.clean.changeSummary.length === 0) lines.push('  • nothing needed fixing');
  for (const c of [...result.clean.changeSummary].sort((a, b) => b.count - a.count)) lines.push(`  • ${c.label}: ${c.count}`);
  lines.push('', 'Needs your review:');
  if (byReason.size === 0) lines.push('  • nothing — no ambiguous/invalid rows');
  for (const [r, c] of byReason) lines.push(`  • ${FLAG_TITLES[r]}: ${c}`);
  lines.push('', 'First look:');
  for (const h of result.analysis.highlights) lines.push(`  • ${h}`);
  lines.push('', 'Outputs:');
  for (const f of written.files) lines.push(`  • ${f}`);
  lines.push(`  • ${written.zip} (ZIP)`);
  return lines.join('\n');
}

/** All DataDeck tools, ready to hand to an Agent. */
export const dataDeckTools = [profileDataset, inspectColumns, applyCleaningPlan, quickAutoClean, listSheets];

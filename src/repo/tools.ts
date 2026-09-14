// ─────────────────────────────────────────────────────────────
// DataDeck Agent — repo tools (the agent's HANDS for a repo run)
//
// The repo run is AGENT-ORCHESTRATED: the model profiles the data, inspects
// the messy columns, REASONS a cleaning plan, and then calls deliver_project
// with that plan to produce the whole project folder + site + email + deploy.
//
// This reuses profile_dataset / inspect_columns from the standard toolset, and
// adds one delivery tool. There is intentionally NO deterministic auto-clean
// tool here — a repo run must be reasoned by the model or it fails loudly.
// ─────────────────────────────────────────────────────────────
import path from 'node:path';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { profileDataset, inspectColumns } from '../tools/index';
import type { CleaningPlan } from '../core/plan';
import { deliverProject } from './deliver';

// Mirror of the plan schema in ../tools/index.ts (kept local; that one isn't exported).
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
    .describe('Semantic mapping: raw value -> canonical value, e.g. {"usa":"United States","us":"United States"}'),
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

/**
 * Execute the model's own plan AND deliver the whole project: cleaned data,
 * reports, a multipage HTML site, an optional Vercel deploy, a styled email,
 * and a manifest — all into `outDir`. This is the final step of a repo run.
 */
export const deliverProjectTool = tool({
  name: 'deliver_project',
  description:
    'Run YOUR cleaning plan on the dataset and deliver the full project into outDir: cleaned CSV, cleaning + analysis reports, summary, ZIP bundle, a multipage HTML site, an optional Vercel deploy, and a styled task-report email. Call this ONCE, last, after you have profiled the file, inspected messy columns, and reasoned a per-column plan. Pass the EXACT path, outDir, and datasetName you were given.',
  inputSchema: z.object({
    path: z.string().describe('Path to the source dataset (use the exact path you were given)'),
    outDir: z.string().describe('Project output folder (use the exact outDir you were given)'),
    datasetName: z.string().describe('Friendly dataset name for the reports/email'),
    sheet: z.string().optional().describe('Excel sheet name, if applicable'),
    plan: planSchema.describe('The per-column cleaning plan you reasoned out'),
  }),
  callback: async ({ path: filePath, outDir, datasetName, sheet, plan }) => {
    const manifest = await deliverProject({
      file: filePath,
      projectDir: outDir,
      plan: plan as unknown as CleaningPlan,
      datasetName,
      sheet,
    });
    const lines = [
      `Delivered project "${manifest.project}".`,
      manifest.headline,
      `Data health: ${manifest.quality}/100.`,
      `Deliverables in ${path.basename(outDir)}/: ${manifest.deliverables.join(', ')}.`,
      manifest.site.deployed ? `Site deployed: ${manifest.site.url}` : `Site built (not deployed: ${manifest.site.deployError}).`,
      manifest.email.sent ? `Email sent via ${manifest.email.provider}.` : `Email prepared (not sent: ${manifest.email.error}).`,
      'The project is complete — do not call any more tools.',
    ];
    return lines.join('\n');
  },
});

/** Tools for an agent-orchestrated repo run. Profile → inspect → reason → deliver. */
export const repoAgentTools = [profileDataset, inspectColumns, deliverProjectTool];

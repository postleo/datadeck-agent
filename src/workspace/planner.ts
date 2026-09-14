// ─────────────────────────────────────────────────────────────
// DataDeck Agent — Workspace planner (agent reasons a plan for a HUMAN to confirm)
//
// The Workspace is the guided, human-in-the-loop side of DataDeck. Unlike the
// headless repo runner (which reasons AND delivers on its own), here the agent
// only PROPOSES a cleaning plan: it profiles the data, inspects the messy
// columns, factors in what the user said they want to learn, and calls the
// propose_plan tool to hand back a per-column plan plus a plain-language recap.
// A person then reviews/edits/confirms it before anything is executed.
//
// Still agent-driven: the PLAN is the model's reasoning, not a script. If no
// model is available or the agent doesn't propose a plan, this throws — the
// API surfaces an honest error. There is NO deterministic planning fallback.
// ─────────────────────────────────────────────────────────────
import path from 'node:path';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { createAgent, messageText } from '../agent/agent';
import { profileDataset, inspectColumns } from '../tools/index';
import type { CleaningPlan } from '../core/plan';

// Mirror of the plan schema (the one in ../tools/index.ts isn't exported).
const validateSchema = z.object({
  kind: z.enum(['nonempty', 'regex', 'range', 'one_of']),
  pattern: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  allowed: z.array(z.string()).optional(),
  message: z.string().optional(),
});

const columnPlanSchema = z.object({
  meaning: z.string().optional().describe('What this column means, in plain words'),
  trim: z.boolean().optional(),
  toISODate: z.boolean().optional(),
  dateOrder: z.enum(['DMY', 'MDY', 'ISO']).optional(),
  categoryMap: z.record(z.string(), z.string()).optional(),
  case: z.enum(['title', 'upper', 'lower']).optional(),
  normalizeNumber: z.boolean().optional(),
  currencyTarget: z.string().optional(),
  validate: validateSchema.optional(),
});

const planSchema = z.object({
  columns: z.record(z.string(), columnPlanSchema).optional(),
  dedupe: z.object({ enabled: z.boolean().optional(), keys: z.array(z.string()).optional() }).optional(),
  rates: z.record(z.string(), z.number()).optional(),
  missingTokens: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

const PLANNER_SYSTEM = `You are the **DataDeck Agent** working in the Workspace — a guided mode where a
PERSON will review your plan before anything runs. Your job is to PROPOSE (not execute) the best
cleaning plan for this dataset, taking the user's stated goals into account.

Work in this order:
1. Call profile_dataset on the file to learn its shape, types, missing values, and format issues.
2. For EVERY column that looks inconsistent (categories, mixed labels, messy dates, currency,
   casing, etc.), call inspect_columns to see the actual distinct values, then REASON about them.
3. Call propose_plan ONCE with a per-column plan, then stop and give a one-paragraph summary.

The plan.columns entries must carry REAL operations, not just a "meaning" string:
  • categoryMap to merge variants of the same category into one canonical value;
  • toISODate + dateOrder for date columns;
  • currencyTarget (+ a top-level "rates" map) for money;
  • case to unify label casing; normalizeNumber for grouped numbers;
  • validate ("nonempty"/"regex"/"range"/"one_of") where a column has an obvious valid range/format.
Put a short plain-language 'notes' summary in the plan. Prioritize whatever the user said they want
to learn. NEVER delete or invent data — questionable values get a validate rule (flagged), not removed.
Do not ask questions; propose the best plan you can. Call propose_plan exactly once.`;

export interface PlanRecapItem { column: string; actions: string[]; }
export interface PlanRecap {
  notes: string;
  columns: PlanRecapItem[];
  dedupe: boolean;
  rates: Record<string, number>;
  deliverables: { name: string; label: string }[];
}

export interface ProposeResult {
  plan: CleaningPlan;
  recap: PlanRecap;
  agentSummary: string;
}

/** The set of deliverables a Workspace run will produce (shown in the recap). */
export const WORKSPACE_DELIVERABLES = [
  { name: 'cleaned.csv', label: 'Cleaned dataset (CSV)' },
  { name: 'cleaning-report.html', label: 'Cleaning report (what changed + what was flagged)' },
  { name: 'analysis-report.html', label: 'Analysis report (first look at the data)' },
  { name: 'summary.md', label: 'Plain-text summary' },
  { name: 'site/index.html', label: 'Interactive multipage site' },
  { name: 'bundle.zip', label: 'Everything, zipped' },
];

/** Turn a machine plan into a human-readable recap of what will happen per column. */
function buildRecap(plan: CleaningPlan): PlanRecap {
  const columns: PlanRecapItem[] = [];
  for (const [name, cp] of Object.entries(plan.columns ?? {})) {
    const actions: string[] = [];
    if (cp.categoryMap && Object.keys(cp.categoryMap).length) {
      const n = new Set(Object.values(cp.categoryMap)).size;
      actions.push(`Merge variant labels into ${n} canonical value${n === 1 ? '' : 's'}`);
    }
    if (cp.toISODate || cp.dateOrder) actions.push(`Standardize dates to ISO${cp.dateOrder ? ` (read as ${cp.dateOrder})` : ''}`);
    if (cp.currencyTarget) actions.push(`Convert/normalize money to ${cp.currencyTarget}`);
    if (cp.normalizeNumber) actions.push('Clean number formatting');
    if (cp.case) actions.push(`Unify text case to ${cp.case}`);
    if (cp.trim !== false) actions.push('Trim stray whitespace');
    if (cp.validate) actions.push(`Flag rows failing the ${cp.validate.kind} rule (never deleted)`);
    if (actions.length) columns.push({ column: name, actions });
  }
  return {
    notes: plan.notes ?? 'A per-column cleaning plan reasoned from your data and goals.',
    columns,
    dedupe: !!plan.dedupe?.enabled,
    rates: plan.rates ?? {},
    deliverables: WORKSPACE_DELIVERABLES,
  };
}

/**
 * Have the agent reason a cleaning plan for this dataset + goals, and return it
 * for a human to confirm. Throws if the agent can't produce a plan (no fallback).
 */
export async function proposePlan(file: string, goals: string, datasetName?: string): Promise<ProposeResult> {
  const name = datasetName || path.basename(file);
  const captured: { plan?: CleaningPlan } = {};

  // A propose_plan tool that RECORDS the plan instead of executing it.
  const proposePlanTool = tool({
    name: 'propose_plan',
    description:
      'Hand back YOUR reasoned per-column cleaning plan for the user to review. This does NOT run anything — it only records the plan. Call once, after profiling and inspecting.',
    inputSchema: z.object({ plan: planSchema.describe('The per-column cleaning plan you reasoned out') }),
    callback: async ({ plan }) => {
      captured.plan = plan as unknown as CleaningPlan;
      const cols = plan.columns ? Object.keys(plan.columns).length : 0;
      return `Plan recorded (${cols} column${cols === 1 ? '' : 's'} planned). Stop now and summarize it for the user.`;
    },
  });

  const agent = createAgent({
    tools: [profileDataset, inspectColumns, proposePlanTool],
    systemPrompt: PLANNER_SYSTEM,
    printer: false,
  });

  const prompt = [
    `Propose the best cleaning plan for this dataset.`,
    `- File path: ${file}`,
    `- Dataset name: ${name}`,
    `- What the user wants to learn from it: ${goals?.trim() ? goals.trim() : '(not specified — use your best judgement for a general clean + first look)'}`,
    ``,
    `Profile it, inspect the messy columns, then call propose_plan once with your plan.`,
  ].join('\n');

  const result = await agent.invoke(prompt);
  const agentSummary = messageText(result.lastMessage);

  if (!captured.plan) {
    const hint = agentSummary ? ` The agent said: "${agentSummary.slice(0, 200)}"` : '';
    throw new Error(`The agent finished without proposing a plan. Nothing was changed. Please try again.${hint}`);
  }
  return { plan: captured.plan, recap: buildRecap(captured.plan), agentSummary };
}

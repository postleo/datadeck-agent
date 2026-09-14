// ─────────────────────────────────────────────────────────────
// DataDeck Agent — repo run, ORCHESTRATED BY THE AGENT
//
// This is the important part: the ORCHESTRATION is the model's job, not a
// script. We hand the model the repo tools (profile_dataset, inspect_columns,
// deliver_project) and a headless system prompt, then let IT decide how to
// understand the data, what the cleaning plan should be, and when to deliver.
//
// The runner only: (1) builds the agent, (2) tells it which file/outDir to
// work on, (3) checks afterwards that a delivered manifest actually landed.
// If the model isn't available or the run doesn't produce a manifest, this
// reports failure — run.ts then writes an honest failure notice. No fallback.
// ─────────────────────────────────────────────────────────────
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createAgent, messageText } from '../agent/agent';
import { repoAgentTools } from './tools';

const REPO_SYSTEM = `You are the **DataDeck Agent** running headless inside a code repository.
A dataset was dropped into an inbox folder. Your job is to fully understand it, decide how to
clean it by REASONING (never blind rules), and deliver a complete project — autonomously, with
no human in the loop. You must finish the whole job in this one run.

Work in this exact order:
1. Call profile_dataset on the file to learn its shape, types, missing values, and format issues.
2. For EVERY column whose values look inconsistent (categories, mixed labels, messy dates,
   currency, casing, etc.), call inspect_columns to see the actual distinct values, then REASON
   about what they mean.
3. Build a per-column plan and call deliver_project ONCE with it, plus the EXACT path, outDir,
   and datasetName you were given.
4. After deliver_project returns, stop. Reply with a one-paragraph summary of what you did.

CRITICAL — the plan must contain the ACTUAL operations, not just descriptions:
Each entry in plan.columns must carry the real transformation you decided for that column, using
these fields (not just a "meaning" string):
  • categoryMap — to merge variants of the same category into one canonical value.
  • toISODate + dateOrder ("DMY"/"MDY"/"ISO") — to standardize a date column.
  • currencyTarget (+ a top-level "rates" map) — to normalize/convert money.
  • case ("title"/"upper"/"lower") — to unify label casing.
  • normalizeNumber — to strip grouping from plain numbers.
  • validate — a rule ("nonempty"/"regex"/"range"/"one_of"); failing rows are flagged, not deleted.
A plan that only sets "meaning", or that trims whitespace and nothing else, means you did NOT do
your job. If you inspected a messy column, the plan MUST include an operation that fixes it.

Worked example of a good plan argument (adapt to the real columns/values you see):
{
  "columns": {
    "country":    { "categoryMap": { "usa": "United States", "u.s.a.": "United States", "uk": "United Kingdom" } },
    "order_date": { "toISODate": true, "dateOrder": "DMY" },
    "amount":     { "currencyTarget": "USD" },
    "status":     { "case": "title" }
  },
  "rates": { "EUR": 1.08, "GBP": 1.27, "USD": 1 },
  "notes": "Merged country name variants, standardized dates to ISO (DMY), converted money to USD, title-cased status."
}

Rules:
- NEVER delete or invent data. Ambiguous or invalid values must be flagged (via validate),
  not guessed. This is core to DataDeck.
- Do not ask questions — there is nobody to answer. Make the best-reasoned decision and proceed.
- Call deliver_project exactly once, and only after profiling and inspecting.`;

export interface AgentRunResult {
  ok: boolean;
  /** The agent's final text (for logs). */
  text?: string;
  /** Populated when the run did not produce a delivered manifest. */
  error?: string;
}

/**
 * Let the AI agent orchestrate the full processing of one dataset into projectDir.
 * Returns ok:true only if the agent actually wrote a delivered manifest.
 */
export async function runAgentOnDataset(
  file: string,
  projectDir: string,
  datasetName: string,
): Promise<AgentRunResult> {
  let text: string | undefined;
  try {
    const agent = createAgent({
      tools: repoAgentTools,
      systemPrompt: REPO_SYSTEM,
      printer: false,
    });

    const prompt = [
      `Process this dataset end to end and deliver the project.`,
      `- File path: ${file}`,
      `- Output folder (outDir): ${projectDir}`,
      `- Dataset name: ${datasetName}`,
      ``,
      `Profile it, inspect the messy columns, reason a per-column cleaning plan, then call`,
      `deliver_project once with that plan and these exact path/outDir/datasetName values.`,
    ].join('\n');

    const result = await agent.invoke(prompt);
    text = messageText(result.lastMessage);
  } catch (err) {
    return { ok: false, error: `agent error: ${(err as Error).message}`, text };
  }

  // Verify the agent actually delivered — a manifest with status "delivered".
  try {
    const raw = await fs.readFile(path.join(projectDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as { status?: string };
    if (manifest.status === 'delivered') return { ok: true, text };
    return { ok: false, error: `manifest present but status="${manifest.status ?? 'unknown'}"`, text };
  } catch {
    return {
      ok: false,
      error: 'the agent finished without calling deliver_project (no delivered manifest was written)',
      text,
    };
  }
}

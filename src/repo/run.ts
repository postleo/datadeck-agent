// ─────────────────────────────────────────────────────────────
// DataDeck Agent — repo runner (AGENT-ORCHESTRATED)
//
// Embed this in a repo. When a user drops a CSV/Excel file into the inbox
// folder (default ./inbox) and pushes, this runner, for each dataset:
//   1. creates a project folder under ./projects/<name>-<hash>/,
//   2. hands the file to the AI AGENT, which REASONS a cleaning plan and
//      delivers the whole project (cleaned data, reports, summary, ZIP,
//      a multipage HTML site, an optional Vercel deploy, a styled email),
//   3. records a manifest.
//
// The AGENT does the orchestration — not this script. This runner only finds
// datasets, sets up folders, checks a model is available, and verifies the
// agent delivered. There is NO deterministic fallback: if no model is
// configured or the agent fails, it writes an honest FAILURE NOTICE
// (FAILED.md + failed manifest + a failure email) so the user knows something
// didn't work — it never silently rule-cleans the data.
//
// Idempotent: a dataset that already has a *delivered* manifest is skipped; a
// previously *failed* dataset is retried.
// ─────────────────────────────────────────────────────────────
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectIdFor, writeFailure } from './deliver';
import { runAgentOnDataset } from './agentRunner';

const INBOX = process.env.INBOX_DIR || 'inbox';
const PROJECTS = process.env.PROJECTS_DIR || 'projects';
const DATASET_RE = /\.(csv|tsv|xlsx|xls)$/i;

/** Which provider (if any) has usable credentials right now. */
function detectModel(): { available: boolean; provider?: string; reason: string } {
  const provider = (process.env.DATADECK_PROVIDER || 'google').toLowerCase();
  if (provider === 'bedrock') {
    const hasAws = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
    return hasAws
      ? { available: true, provider: 'bedrock', reason: 'Amazon Bedrock credentials present' }
      : { available: false, reason: 'DATADECK_PROVIDER=bedrock but no AWS credentials (AWS_ACCESS_KEY_ID / AWS_PROFILE) are set' };
  }
  const hasKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  return hasKey
    ? { available: true, provider: 'google', reason: 'Gemini API key present' }
    : { available: false, reason: 'no AI model configured — set GEMINI_API_KEY (Gemini) or configure Amazon Bedrock (DATADECK_PROVIDER=bedrock + AWS credentials)' };
}

/** Has this dataset already been delivered? (delivered manifest present) */
async function alreadyDelivered(projectDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'manifest.json'), 'utf8');
    return (JSON.parse(raw) as { status?: string }).status === 'delivered';
  } catch {
    return false;
  }
}

interface Outcome { project: string; status: 'delivered' | 'skipped' | 'failed'; note: string; }

async function processOne(file: string, model: ReturnType<typeof detectModel>): Promise<Outcome> {
  const datasetName = path.basename(file);
  const projectId = await projectIdFor(file);
  const projectDir = path.join(PROJECTS, projectId);

  if (await alreadyDelivered(projectDir)) {
    return { project: projectId, status: 'skipped', note: 'already delivered — skipped' };
  }

  // No model → this is an AI agent; it cannot run. Emit a failure notice.
  if (!model.available) {
    await writeFailure(file, projectDir, 'model check', model.reason, datasetName);
    return { project: projectId, status: 'failed', note: `no model — failure notice written (${model.reason})` };
  }

  // Hand it to the agent to orchestrate.
  const run = await runAgentOnDataset(file, projectDir, datasetName);
  if (run.ok) {
    return { project: projectId, status: 'delivered', note: `agent-orchestrated via ${model.provider}` };
  }

  // Agent ran but did not deliver → failure notice, NO deterministic fallback.
  await writeFailure(file, projectDir, 'agent run', run.error || 'the agent did not complete the delivery', datasetName);
  return { project: projectId, status: 'failed', note: `agent did not deliver — failure notice written (${run.error})` };
}

async function main(): Promise<void> {
  const entries = await fs.readdir(INBOX).catch(() => {
    console.error(`[repo] inbox folder "${INBOX}" not found — nothing to do.`);
    return [] as string[];
  });
  const datasets = entries.filter((f) => DATASET_RE.test(f)).map((f) => path.join(INBOX, f));
  if (datasets.length === 0) {
    console.log(`[repo] no datasets in ${INBOX}/ — nothing to process.`);
    return;
  }

  const model = detectModel();
  console.log(`[repo] found ${datasets.length} dataset(s) in ${INBOX}/`);
  console.log(model.available
    ? `[repo] model: ${model.provider} — the AI agent will orchestrate each run.`
    : `[repo] model: NONE — ${model.reason}. Datasets will get a failure notice (no deterministic fallback).`);

  let failed = 0;
  for (const file of datasets) {
    try {
      const r = await processOne(file, model);
      const mark = r.status === 'delivered' ? '✓' : r.status === 'skipped' ? '•' : '✗';
      console.log(`[repo] ${mark} ${path.basename(file)} → projects/${r.project} · ${r.note}`);
      if (r.status === 'failed') failed++;
    } catch (err) {
      // Last-resort: even the failure path threw. Still record it, don't rule-clean.
      failed++;
      const projectId = await projectIdFor(file).catch(() => 'unknown');
      console.error(`[repo] ✗ ${path.basename(file)} — unexpected error: ${(err as Error).message}`);
      await writeFailure(file, path.join(PROJECTS, projectId), 'runner', (err as Error).message, path.basename(file)).catch(() => {});
    }
  }

  // Non-zero exit if anything failed, so CI surfaces it — but deliverables/notices are already written.
  if (failed) process.exitCode = 1;
}

main();

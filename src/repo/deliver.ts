// ─────────────────────────────────────────────────────────────
// DataDeck Agent — mechanical delivery (the agent's HANDS)
//
// deliverProject() is the mechanical half of a repo run. It does NOT decide
// anything: it takes the cleaning PLAN the AI agent reasoned out and turns it
// into a delivered project folder — cleaned data, reports, a multipage HTML
// site, an optional Vercel deploy, a styled email, and a manifest.
//
// The agent (see agentRunner.ts) calls this through the deliver_project tool.
// There is NO deterministic fallback: if no model is configured or the agent
// fails, run.ts calls writeFailure() to leave an honest failure notice instead
// of quietly rule-cleaning the data.
// ─────────────────────────────────────────────────────────────
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runPlanOnPath, writeArtifacts, headline, type PipelineResult } from '../core/pipeline';
import type { CleaningPlan } from '../core/plan';
import { buildSite, type SiteMeta } from './site';
import {
  renderEmailHtml, sendEmail, renderTaskReport,
  renderFailureEmailHtml, renderFailureReport,
  type EmailLink, type SendResult,
} from './email';
import { deploySite } from './vercel';

const EMAIL_TO = process.env.EMAIL_TO || '';

// ── shared helpers (used by run.ts and the tool) ──────────────

export function slug(s: string): string {
  return s.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'dataset';
}

export async function contentHash(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  return createHash('sha1').update(buf).digest('hex').slice(0, 8);
}

/** Project id = slug(name) + 8-char content hash — stable & dedupe-friendly. */
export async function projectIdFor(file: string): Promise<string> {
  return `${slug(path.basename(file))}-${await contentHash(file)}`;
}

/** Composite "data health" score (completeness / de-dup / validity) — 0..100. */
export function qualityScore(result: PipelineResult): number {
  const p = result.clean.profile;
  const rowsIn = result.clean.original.rows.length || 1;
  const rowsOut = result.clean.cleaned.rows.length || 1;
  const total = p.totalCells || 1;
  const completeness = 1 - p.missingCells / total;
  const dedup = 1 - p.duplicateRowCount / rowsIn;
  const validity = 1 - Math.min(1, result.clean.flags.length / rowsOut) * 0.5;
  return Math.max(0, Math.min(100, Math.round(100 * (0.4 * completeness + 0.2 * dedup + 0.4 * validity))));
}

/** A blob URL into the repo if running in CI, else a relative path. */
export function repoLink(relFromRoot: string): string {
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF_NAME || process.env.GITHUB_SHA;
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  if (repo && ref) return `${server}/${repo}/blob/${ref}/${relFromRoot}`;
  return relFromRoot; // local run — relative path
}

function nowStamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

// ── delivery ──────────────────────────────────────────────────

export interface DeliverOptions {
  /** Path to the source dataset in the inbox. */
  file: string;
  /** Absolute/relative project output folder (already namespaced by run.ts). */
  projectDir: string;
  /** The cleaning plan the AI agent reasoned out. REQUIRED — this is agentic. */
  plan: CleaningPlan;
  /** Friendly dataset name for reports/email (defaults to the file's basename). */
  datasetName?: string;
  /** Excel sheet, if the agent chose one. */
  sheet?: string;
}

export interface DeliverManifest {
  status: 'delivered';
  project: string;
  source: string;
  datasetName: string;
  generatedAt: string;
  quality: number;
  headline: string;
  plan: { notes?: string; columnsPlanned: number; dedupe: boolean };
  deliverables: string[];
  site: { dir: string; deployed: boolean; url: string | null; deployError: string | null };
  email: { to: string | null; sent: boolean; provider: string; id: string | null; error: string | null };
}

/**
 * Turn the agent's plan into a fully delivered project folder.
 * Returns the manifest it wrote. Assumes projectDir is this dataset's folder.
 */
export async function deliverProject(opts: DeliverOptions): Promise<DeliverManifest> {
  const { file, projectDir, plan } = opts;
  const datasetName = opts.datasetName || path.basename(file);
  const base = slug(path.basename(file));

  // Run the AGENT'S plan (never the deterministic auto-cleaner).
  const result = await runPlanOnPath(file, plan, opts.sheet);
  const quality = qualityScore(result);
  const generatedAt = nowStamp();
  const meta: SiteMeta = { datasetName, quality, generatedAt, sourceFile: path.basename(file) };

  // Folders + core deliverables.
  await fs.mkdir(path.join(projectDir, 'source'), { recursive: true });
  await fs.copyFile(file, path.join(projectDir, 'source', path.basename(file)));
  await writeArtifacts(result, projectDir, base); // cleaned.csv, reports, summary.*, <base>-datadeck.zip

  // Multipage HTML site (the HTML deliverable).
  const siteDir = path.join(projectDir, 'site');
  await fs.mkdir(siteDir, { recursive: true });
  const site = buildSite(result, meta);
  for (const [name, html] of Object.entries(site)) await fs.writeFile(path.join(siteDir, name), html, 'utf8');

  // Optional Vercel deploy of the site.
  const deploy = await deploySite(siteDir);

  // Links to every deliverable.
  const rel = (f: string) => repoLink(path.join(projectDir, f).split(path.sep).join('/'));
  const links: EmailLink[] = [
    { label: 'Cleaned dataset (CSV)', url: rel('cleaned.csv') },
    { label: 'Cleaning report (HTML)', url: rel('cleaning-report.html') },
    { label: 'Analysis report (HTML)', url: rel('analysis-report.html') },
    { label: 'Summary (Markdown)', url: rel('summary.md') },
    { label: 'Full bundle (ZIP)', url: rel(`${base}-datadeck.zip`) },
    { label: 'Interactive site (source)', url: rel('site/index.html') },
  ];

  const c = result.clean;
  const emailData = {
    datasetName,
    headline: headline(result),
    stats: [
      { label: 'Data health', value: `${quality}/100` },
      { label: 'Rows in → out', value: `${c.original.rows.length} → ${c.cleaned.rows.length}` },
      { label: 'Columns', value: c.profile.columnCount },
      { label: 'Changes', value: c.changes.length },
      { label: 'Flagged', value: c.flags.length },
    ],
    links,
    siteUrl: deploy.url,
    generatedAt,
  };

  const emailHtml = renderEmailHtml(emailData);
  await fs.writeFile(path.join(projectDir, 'email.html'), emailHtml, 'utf8');
  const send: SendResult = await sendEmail(EMAIL_TO, `DataDeck — ${datasetName} cleaned & analyzed`, emailHtml);

  await fs.writeFile(
    path.join(projectDir, 'report.md'),
    renderTaskReport(emailData, { project: projectDir, email: send, site: deploy.url }),
    'utf8',
  );

  const manifest: DeliverManifest = {
    status: 'delivered',
    project: path.basename(projectDir),
    source: path.basename(file),
    datasetName,
    generatedAt,
    quality,
    headline: headline(result),
    plan: {
      notes: plan.notes,
      columnsPlanned: plan.columns ? Object.keys(plan.columns).length : 0,
      dedupe: !!plan.dedupe?.enabled,
    },
    deliverables: [
      'cleaned.csv', 'cleaning-report.html', 'analysis-report.html',
      'summary.md', 'summary.json', `${base}-datadeck.zip`, 'site/index.html',
    ],
    site: { dir: 'site', deployed: deploy.deployed, url: deploy.url || null, deployError: deploy.error || null },
    email: { to: EMAIL_TO || null, sent: send.sent, provider: send.provider, id: send.id || null, error: send.error || null },
  };
  await fs.writeFile(path.join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

// ── failure notice (NO deterministic fallback) ────────────────

export interface FailureManifest {
  status: 'failed';
  project: string;
  source: string;
  datasetName: string;
  generatedAt: string;
  stage: string;
  reason: string;
}

/**
 * The agent could not process this dataset (no model configured, or the agent
 * errored). We do NOT silently rule-clean it. Instead we leave an honest
 * failure notice — FAILED.md + a failed manifest — and best-effort email it.
 */
export async function writeFailure(
  file: string,
  projectDir: string,
  stage: string,
  reason: string,
  datasetName = path.basename(file),
): Promise<FailureManifest> {
  const generatedAt = nowStamp();
  await fs.mkdir(projectDir, { recursive: true });

  const manifest: FailureManifest = {
    status: 'failed',
    project: path.basename(projectDir),
    source: path.basename(file),
    datasetName,
    generatedAt,
    stage,
    reason,
  };

  await fs.writeFile(path.join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(projectDir, 'FAILED.md'), renderFailureReport(manifest), 'utf8');

  // Best-effort failure email so the user knows something went wrong.
  const failHtml = renderFailureEmailHtml(manifest);
  await fs.writeFile(path.join(projectDir, 'email.html'), failHtml, 'utf8');
  await sendEmail(EMAIL_TO, `DataDeck — could not process ${datasetName}`, failHtml);

  return manifest;
}

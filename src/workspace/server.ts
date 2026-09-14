// ─────────────────────────────────────────────────────────────
// DataDeck Agent — Workspace API (consumed by the mini web app)
//
// The standalone service behind the Workspace's guided flow:
//   POST /workspace/profile   — upload a dataset; get its profile + a session id
//   POST /workspace/plan      — the AGENT reasons a cleaning plan for you to confirm
//   POST /workspace/run       — execute the confirmed plan; get the deliverables
//   GET  /workspace/run/:id   — fetch a stored run summary (powers the result page)
//   POST /workspace/deliver   — email the deliverables + a link (best-effort)
//   POST /workspace/deploy    — publish the HTML site to Vercel (best-effort)
//   GET  /workspace/file/...  — download any produced deliverable
//
// The mini web app is just a client. Planning is agent-driven (see planner.ts);
// if the agent can't produce a plan, /plan returns an honest error — there is no
// deterministic planning fallback. Email/deploy are optional and best-effort:
// when their credentials aren't configured, the endpoints say so plainly rather
// than pretending they worked.
// ─────────────────────────────────────────────────────────────
import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { profileTable } from '../core/detect';
import { parseFile } from '../core/parse';
import { runPlanOnPath, writeArtifacts, headline } from '../core/pipeline';
import type { CleaningPlan } from '../core/plan';
import { buildSite, type SiteMeta } from '../repo/site';
import { qualityScore, slug } from '../repo/deliver';
import { renderEmailHtml, sendEmail, type EmailLink } from '../repo/email';
import { deploySite } from '../repo/vercel';
import { proposePlan, WORKSPACE_DELIVERABLES } from './planner';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Durable store (survives restarts), so the result page / deliverables persist.
const ROOT = process.env.WORKSPACE_STORE || path.join(process.cwd(), '.workspace-store');
// Public bases for building absolute links in emails (optional).
const PUBLIC_WORKSPACE_URL = (process.env.PUBLIC_WORKSPACE_URL || '').replace(/\/$/, '');
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');

interface Session { id: string; dir: string; file: string; datasetName: string; base: string; }
const sessions = new Map<string, Session>();

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

/** Get a session from memory, or rehydrate it from disk (durable store). */
async function getSession(id: string): Promise<Session | null> {
  if (!id) return null;
  const inMem = sessions.get(id);
  if (inMem) return inMem;
  const metaPath = path.join(ROOT, id, 'meta.json');
  if (!(await exists(metaPath))) return null;
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Session;
    sessions.set(id, meta);
    return meta;
  } catch {
    return null;
  }
}

function hasModel(): boolean {
  return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
}

function fileMeta(req: Request): { buffer: Buffer; name: string } | null {
  const f = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
  return f ? { buffer: f.buffer, name: f.originalname } : null;
}

function absolute(base: string, rel: string): string {
  return base ? `${base}${rel}` : rel;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Open CORS (no cookies; bearerless). The mini app calls this cross-origin in dev.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'datadeck-workspace',
      model: hasModel(),
      email: !!process.env.RESEND_API_KEY,
      deploy: !!process.env.VERCEL_TOKEN,
    });
  });

  // 1) Upload a dataset -> profile it (no changes) -> open a session.
  app.post('/workspace/profile', upload.single('file'), async (req, res, next) => {
    try {
      const f = fileMeta(req);
      if (!f) return res.status(400).json({ error: 'No file uploaded (field "file").' });
      const sheet = typeof req.query.sheet === 'string' ? req.query.sheet : undefined;
      const table = await parseFile(f.buffer, f.name, sheet);
      if (table.headers.length === 0) return res.status(422).json({ error: 'Could not read any columns from the file.' });

      const id = randomUUID();
      const dir = path.join(ROOT, id);
      const base = slug(f.name);
      const filePath = path.join(dir, 'source', f.name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, f.buffer);
      const session: Session = { id, dir, file: filePath, datasetName: f.name, base };
      sessions.set(id, session);
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(session), 'utf8');

      const p = profileTable(table);
      res.json({
        sessionId: id,
        dataset: { name: f.name, rows: p.rowCount, columns: p.columnCount, missingCells: p.missingCells, duplicateRows: p.duplicateRowCount },
        columns: p.columns.map((c) => ({
          name: c.name, type: c.detectedType, fillRate: Math.round(c.fillRate * 100),
          unique: c.unique, samples: c.sampleValues.slice(0, 5), issues: c.formatIssues,
        })),
      });
    } catch (err) { next(err); }
  });

  // 2) The AGENT reasons a cleaning plan for the user to confirm. No fallback.
  app.post('/workspace/plan', async (req, res) => {
    const { sessionId, goals } = req.body || {};
    const s = await getSession(sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found. Upload a dataset first.' });
    if (!hasModel()) {
      return res.status(503).json({
        error: 'No AI model is configured, so the agent cannot reason a plan. DataDeck does not fall back to blind rules — set GEMINI_API_KEY (or configure Bedrock) and try again.',
      });
    }
    try {
      const out = await proposePlan(s.file, String(goals || ''), s.datasetName);
      res.json({ plan: out.plan, recap: out.recap, agentSummary: out.agentSummary });
    } catch (err) {
      res.status(502).json({ error: `The agent could not produce a plan: ${(err as Error).message}` });
    }
  });

  // 3) Execute the confirmed (possibly user-edited) plan -> write all deliverables.
  app.post('/workspace/run', async (req, res, next) => {
    try {
      const { sessionId, plan } = req.body || {};
      const s = await getSession(sessionId);
      if (!s) return res.status(404).json({ error: 'Session not found. Upload a dataset first.' });
      if (!plan || typeof plan !== 'object') return res.status(400).json({ error: 'A confirmed plan is required.' });

      const result = await runPlanOnPath(s.file, plan as CleaningPlan);
      const quality = qualityScore(result);
      const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

      // Core artifacts + multipage site.
      await writeArtifacts(result, s.dir, s.base);
      const siteDir = path.join(s.dir, 'site');
      await fs.mkdir(siteDir, { recursive: true });
      const meta: SiteMeta = { datasetName: s.datasetName, quality, generatedAt, sourceFile: s.datasetName };
      const site = buildSite(result, meta);
      for (const [nm, html] of Object.entries(site)) await fs.writeFile(path.join(siteDir, nm), html, 'utf8');

      const zipName = `${s.base}-datadeck.zip`;
      const fileUrl = (rel: string) => `/workspace/file/${s.id}/${rel}`;
      const nameToRel: Record<string, string> = { 'bundle.zip': zipName };
      const deliverables = WORKSPACE_DELIVERABLES.map((d) => ({
        name: d.name, label: d.label, url: fileUrl(nameToRel[d.name] || d.name),
      }));

      const c = result.clean;
      const payload = {
        runId: s.id,
        datasetName: s.datasetName,
        headline: headline(result),
        quality,
        generatedAt,
        stats: {
          rowsIn: c.original.rows.length, rowsOut: c.cleaned.rows.length,
          columns: c.profile.columnCount, changes: c.changes.length, flagged: c.flags.length,
        },
        changeSummary: c.changeSummary,
        highlights: result.analysis.highlights,
        deliverables,
        reportUrl: fileUrl('analysis-report.html'),
        siteUrl: fileUrl('site/index.html'),
      };
      // Persist the run so the result page + Deck survive restarts.
      await fs.writeFile(path.join(s.dir, 'run.json'), JSON.stringify(payload, null, 2), 'utf8');
      res.json(payload);
    } catch (err) { next(err); }
  });

  // 3b) Fetch a stored run summary (powers the on-app hosted result page).
  app.get('/workspace/run/:id', async (req, res) => {
    const s = await getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Run not found.' });
    try {
      const run = JSON.parse(await fs.readFile(path.join(s.dir, 'run.json'), 'utf8'));
      res.json(run);
    } catch {
      res.status(404).json({ error: 'This session has not been run yet.' });
    }
  });

  // 3c) Email the deliverables + a link to the hosted result page (best-effort, honest).
  app.post('/workspace/deliver', async (req, res) => {
    const { sessionId, email } = req.body || {};
    const s = await getSession(sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'A recipient email is required.' });
    if (!process.env.RESEND_API_KEY) {
      return res.json({ sent: false, provider: 'none', error: 'Email is not configured on the server (no RESEND_API_KEY). Nothing was sent.' });
    }
    let run: {
      datasetName: string; headline: string; quality: number; generatedAt: string;
      stats: { rowsIn: number; rowsOut: number; columns: number; changes: number; flagged: number };
      deliverables: { name: string; label: string; url: string }[];
    };
    try {
      run = JSON.parse(await fs.readFile(path.join(s.dir, 'run.json'), 'utf8'));
    } catch {
      return res.status(400).json({ error: 'Run this dataset before emailing its deliverables.' });
    }
    const links: EmailLink[] = run.deliverables.map((d) => ({ label: d.label, url: absolute(PUBLIC_WORKSPACE_URL, d.url) }));
    const resultLink = PUBLIC_APP_URL ? `${PUBLIC_APP_URL}/r/${s.id}` : undefined;
    const html = renderEmailHtml({
      datasetName: run.datasetName,
      headline: run.headline,
      stats: [
        { label: 'Data health', value: `${run.quality}/100` },
        { label: 'Rows in → out', value: `${run.stats.rowsIn} → ${run.stats.rowsOut}` },
        { label: 'Columns', value: run.stats.columns },
        { label: 'Changes', value: run.stats.changes },
        { label: 'Flagged', value: run.stats.flagged },
      ],
      links,
      siteUrl: resultLink,
      generatedAt: run.generatedAt,
    });
    const out = await sendEmail(email, `DataDeck — ${run.datasetName} is ready`, html);
    res.json(out);
  });

  // 3d) Publish the HTML site to Vercel (best-effort, honest).
  app.post('/workspace/deploy', async (req, res) => {
    const { sessionId } = req.body || {};
    const s = await getSession(sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    const siteDir = path.join(s.dir, 'site');
    if (!(await exists(siteDir))) return res.status(400).json({ error: 'Run this dataset before publishing its site.' });
    const out = await deploySite(siteDir);
    res.json(out);
  });

  // 4) Serve any produced deliverable (including nested site/ files). Path-traversal safe.
  app.get(/^\/workspace\/file\/([^/]+)\/(.+)$/, async (req, res) => {
    const s = await getSession(req.params[0]);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    const target = path.normalize(path.join(s.dir, req.params[1]));
    if (!target.startsWith(s.dir + path.sep)) return res.status(400).json({ error: 'Invalid path.' });
    try {
      const buf = await fs.readFile(target);
      const ext = path.extname(target).toLowerCase();
      const ctype = ext === '.html' ? 'text/html' : ext === '.json' ? 'application/json'
        : ext === '.csv' ? 'text/csv' : ext === '.zip' ? 'application/zip' : ext === '.md' ? 'text/markdown' : 'text/plain';
      res.setHeader('Content-Type', `${ctype}; charset=utf-8`);
      res.send(buf);
    } catch {
      res.status(404).json({ error: 'Deliverable not found (has this session been run yet?).' });
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: err.message });
  });
  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.WORKSPACE_PORT ?? 8790);
  createApp().listen(port, () => {
    console.log(`DataDeck Workspace API on http://localhost:${port} · model ${hasModel() ? 'ready' : 'NOT configured (plan step will error)'} · email ${process.env.RESEND_API_KEY ? 'on' : 'off'} · deploy ${process.env.VERCEL_TOKEN ? 'on' : 'off'}`);
  });
}

// ─────────────────────────────────────────────────────────────
// DataDeck Agent — HTTP API surface (Express)
// Other software (apps like DataDeck/Sift, or your systems) calls
// these endpoints to profile, clean, and download results.
// ─────────────────────────────────────────────────────────────
import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { profileTable } from '../core/detect';
import { parseFile, listSheets, detectKind } from '../core/parse';
import { runPipelineOnBuffer, bundleZip, headline } from '../core/pipeline';
import { buildSummaryJson } from '../core/report';
import type { CleaningOptions } from '../core/types';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function optionsFromQuery(q: Request['query']): CleaningOptions {
  const options: CleaningOptions = {};
  if (typeof q.base === 'string') options.baseCurrency = q.base;
  if (typeof q.rates === 'string') {
    try {
      options.exchangeRates = JSON.parse(q.rates);
    } catch {
      /* ignored — invalid rates are simply not applied */
    }
  }
  return options;
}

function requireFile(req: Request, res: Response): Buffer | null {
  const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
  if (!file) {
    res.status(400).json({ error: 'No file uploaded. Send multipart/form-data with a "file" field.' });
    return null;
  }
  return file.buffer;
}

function fileName(req: Request): string {
  const file = (req as Request & { file?: { originalname: string } }).file;
  return file?.originalname ?? 'upload.csv';
}

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'datadeck-agent', version: '0.1.0' });
  });

  // Inspect a file without changing it.
  app.post('/profile', upload.single('file'), async (req, res) => {
    const buffer = requireFile(req, res);
    if (!buffer) return;
    const sheet = typeof req.query.sheet === 'string' ? req.query.sheet : undefined;
    const table = await parseFile(buffer, fileName(req), sheet);
    if (table.headers.length === 0) {
      res.status(422).json({ error: 'Could not read any columns from the file.' });
      return;
    }
    res.json(profileTable(table));
  });

  // List sheets in an Excel workbook.
  app.post('/sheets', upload.single('file'), async (req, res) => {
    const buffer = requireFile(req, res);
    if (!buffer) return;
    if (detectKind(fileName(req)) !== 'excel') {
      res.json({ sheets: [], note: 'Not an Excel file.' });
      return;
    }
    res.json({ sheets: await listSheets(buffer) });
  });

  // Clean + analyze, returning a JSON summary.
  app.post('/clean', upload.single('file'), async (req, res) => {
    const buffer = requireFile(req, res);
    if (!buffer) return;
    const sheet = typeof req.query.sheet === 'string' ? req.query.sheet : undefined;
    const result = await runPipelineOnBuffer(buffer, fileName(req), optionsFromQuery(req.query), sheet);
    res.json({
      headline: headline(result),
      ...buildSummaryJson(result.clean, result.analysis),
    });
  });

  // Clean + analyze, returning the ZIP bundle for download.
  app.post('/clean/bundle', upload.single('file'), async (req, res) => {
    const buffer = requireFile(req, res);
    if (!buffer) return;
    const sheet = typeof req.query.sheet === 'string' ? req.query.sheet : undefined;
    const result = await runPipelineOnBuffer(buffer, fileName(req), optionsFromQuery(req.query), sheet);
    const zip = await bundleZip(result);
    const base = fileName(req).replace(/\.[^.]+$/, '');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}-datadeck.zip"`);
    res.send(zip);
  });

  // Clean + analyze, returning a single artifact (cleaned.csv / cleaning-report.html / ...).
  app.post('/clean/artifact/:name', upload.single('file'), async (req, res) => {
    const buffer = requireFile(req, res);
    if (!buffer) return;
    const sheet = typeof req.query.sheet === 'string' ? req.query.sheet : undefined;
    const result = await runPipelineOnBuffer(buffer, fileName(req), optionsFromQuery(req.query), sheet);
    const name = req.params.name as keyof typeof result.artifacts;
    const content = result.artifacts[name];
    if (content === undefined) {
      res.status(404).json({ error: `Unknown artifact "${req.params.name}". Options: ${Object.keys(result.artifacts).join(', ')}` });
      return;
    }
    const ctype = name.endsWith('.html') ? 'text/html' : name.endsWith('.json') ? 'application/json' : name.endsWith('.csv') ? 'text/csv' : 'text/plain';
    res.setHeader('Content-Type', `${ctype}; charset=utf-8`);
    res.send(content);
  });

  // Optional conversational endpoint (needs model credentials).
  app.post('/ask', async (req, res) => {
    const message = (req.body?.message ?? '').toString().trim();
    if (!message) {
      res.status(400).json({ error: 'Provide a JSON body: { "message": "..." }' });
      return;
    }
    try {
      const { ask } = await import('../agent/agent');
      const reply = await ask(message);
      res.json({ reply });
    } catch (err) {
      res.status(503).json({
        error: 'The conversational agent is unavailable. It needs model credentials (see .env.example). The /clean, /profile and /sheets endpoints work without them.',
        detail: (err as Error).message,
      });
    }
  });

  // Central error handler (e.g. pipeline parse errors).
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: err.message });
  });

  return app;
}

// Start the server when run directly.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  createApp().listen(port, () => {
    console.log(`DataDeck Agent API listening on http://localhost:${port}`);
    console.log('Try:  curl -F "file=@examples/messy-sample.csv" http://localhost:' + port + '/clean');
  });
}

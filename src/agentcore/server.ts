// ─────────────────────────────────────────────────────────────
// DataDeck Agent — Amazon Bedrock AgentCore Runtime entrypoint
//
// Implements the AgentCore Runtime HTTP contract:
//   • GET  /ping         -> 200 { status: "healthy" }
//   • POST /invocations  -> runs the agent / pipeline, returns JSON
// Listens on 0.0.0.0:8080. Model provider defaults to Gemini.
// ─────────────────────────────────────────────────────────────
import express, { type Request, type Response } from 'express';
import { ask } from '../agent/agent';
import { runPipelineOnBuffer, headline } from '../core/pipeline';
import { buildSummaryJson } from '../core/report';

const app = express();
app.use(express.json({ limit: '25mb' }));

// Health check — AgentCore polls this.
app.get('/ping', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', service: 'datadeck-agent' });
});

// Main entrypoint. Two modes:
//   1) { filename, contentBase64, sheet? } -> deterministic clean + analysis (no model)
//   2) { prompt } -> the conversational Pro Agent (Gemini) decides what to do
app.post('/invocations', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      prompt?: string; input?: string; filename?: string; contentBase64?: string; sheet?: string;
    };

    if (body.contentBase64 && body.filename) {
      const buffer = Buffer.from(body.contentBase64, 'base64');
      const result = await runPipelineOnBuffer(buffer, body.filename, {}, body.sheet);
      res.json({
        mode: 'clean',
        headline: headline(result),
        summary: buildSummaryJson(result.clean, result.analysis),
      });
      return;
    }

    const prompt = (body.prompt ?? body.input ?? '').toString().trim();
    if (!prompt) {
      res.status(400).json({ error: 'Provide { prompt } or { filename, contentBase64 }.' });
      return;
    }
    const output = await ask(prompt);
    res.json({ mode: 'agent', output });
  } catch (err) {
    console.error('invocation error:', (err as Error).stack ?? String(err));
    res.status(500).json({ error: (err as Error).message });
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => {
  console.log(`DataDeck AgentCore runtime listening on :${port} (provider=${process.env.DATADECK_PROVIDER ?? 'google'})`);
});

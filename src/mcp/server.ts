// ─────────────────────────────────────────────────────────────
// DataDeck Agent — MCP server surface
// Presents the agent's abilities as tools any MCP-aware assistant
// (editor, chat tool, or another agent) can call.
//
// Tools accept either a local file `path` or base64 `content`.
// ─────────────────────────────────────────────────────────────
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { profileTable } from '../core/detect';
import { parseFile, listSheets, detectKind } from '../core/parse';
import { runPipelineOnBuffer, writeArtifacts, headline } from '../core/pipeline';
import { renderMarkdownSummary } from '../core/report';

interface Loaded {
  buffer: Buffer;
  filename: string;
}

async function loadInput(input: { path?: string; content?: string; filename?: string }): Promise<Loaded> {
  if (input.path) {
    const buffer = await fs.readFile(input.path);
    return { buffer, filename: path.basename(input.path) };
  }
  if (input.content) {
    return { buffer: Buffer.from(input.content, 'base64'), filename: input.filename ?? 'upload.csv' };
  }
  throw new Error('Provide either "path" (a local file) or "content" (base64) with a "filename".');
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'datadeck-agent', version: '0.1.0' });

  server.registerTool(
    'profile_dataset',
    {
      description:
        'Inspect a CSV/Excel file and report its shape: column types, missing values, duplicates, and formatting problems. Does not change the file.',
      inputSchema: {
        path: z.string().optional().describe('Local path to the file'),
        content: z.string().optional().describe('Base64-encoded file content (alternative to path)'),
        filename: z.string().optional().describe('Filename (used with content to detect the format)'),
        sheet: z.string().optional().describe('Excel sheet name'),
      },
    },
    async ({ path: p, content, filename, sheet }) => {
      const { buffer, filename: name } = await loadInput({ path: p, content, filename });
      const table = await parseFile(buffer, name, sheet);
      if (table.headers.length === 0) return text(`Could not read any columns from "${name}".`);
      const profile = profileTable(table);
      const lines = [
        `${name}: ${profile.rowCount} rows, ${profile.columnCount} columns. Missing ${profile.missingCells}/${profile.totalCells}, duplicates ${profile.duplicateRowCount}.`,
        ...profile.columns.map(
          (c) => `• ${c.name} [${c.detectedType}] ${Math.round(c.fillRate * 100)}% filled, ${c.unique} unique${c.formatIssues.length ? ' — ' + c.formatIssues.join('; ') : ''}`,
        ),
      ];
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'clean_dataset',
    {
      description:
        'Clean a CSV/Excel file (standardize dates, trim whitespace, unify labels/case, normalize numbers/currency, merge duplicates), flag anything ambiguous for human review, run a pre-analysis, and (optionally) write a cleaned file + reports + ZIP. Never deletes or invents data.',
      inputSchema: {
        path: z.string().optional().describe('Local path to the file'),
        content: z.string().optional().describe('Base64-encoded file content'),
        filename: z.string().optional().describe('Filename (used with content)'),
        sheet: z.string().optional().describe('Excel sheet name'),
        outDir: z.string().optional().describe('If set, write the cleaned file, reports, and ZIP into this directory'),
        baseCurrency: z.string().optional().describe('Convert money columns into this currency (needs exchangeRates)'),
        exchangeRates: z.record(z.string(), z.number()).optional().describe('Rates keyed by currency code'),
      },
    },
    async ({ path: p, content, filename, sheet, outDir, baseCurrency, exchangeRates }) => {
      const { buffer, filename: name } = await loadInput({ path: p, content, filename });
      const result = await runPipelineOnBuffer(buffer, name, { baseCurrency, exchangeRates }, sheet);
      let out = renderMarkdownSummary(result.clean, result.analysis);
      out = `${headline(result)}\n\n${out}`;
      if (outDir) {
        const base = name.replace(/\.[^.]+$/, '');
        const written = await writeArtifacts(result, outDir, base);
        out += `\nOutputs written:\n${written.files.map((f) => `- ${f}`).join('\n')}\n- ${written.zip} (ZIP bundle)`;
      }
      return text(out);
    },
  );

  server.registerTool(
    'list_sheets',
    {
      description: 'List the sheet names in an Excel workbook.',
      inputSchema: {
        path: z.string().optional(),
        content: z.string().optional(),
        filename: z.string().optional(),
      },
    },
    async ({ path: p, content, filename }) => {
      const { buffer, filename: name } = await loadInput({ path: p, content, filename });
      if (detectKind(name) !== 'excel') return text(`"${name}" is not an Excel file; it has no sheets.`);
      return text(`Sheets in ${name}: ${(await listSheets(buffer)).join(', ')}`);
    },
  );

  return server;
}

// Run over stdio when invoked directly.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    // MCP uses stdout for protocol messages; log to stderr only.
    console.error('DataDeck Agent MCP server running on stdio.');
  });
}

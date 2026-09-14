#!/usr/bin/env -S npx tsx
// ─────────────────────────────────────────────────────────────
// DataDeck Agent — CLI surface
// Usage:
//   datadeck clean <file> [--out dir] [--sheet name] [--base USD] [--rates '{"EUR":1.08}']
//   datadeck profile <file> [--sheet name]
//   datadeck sheets <file>
//   datadeck chat ["your message"]        (needs model credentials)
// ─────────────────────────────────────────────────────────────
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { runPipelineOnPath, writeArtifacts, headline } from '../core/pipeline';
import { profileTable } from '../core/detect';
import { parseFile, listSheets, detectKind } from '../core/parse';
import { FLAG_TITLES } from '../core/report';
import type { CleaningOptions, FlagReason } from '../core/types';

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags };
}

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  aqua: (s: string) => `\x1b[38;5;43m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[38;5;221m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

function printHelp(): void {
  console.log(`${C.bold('DataDeck Agent')} — a Pro Agent for messy data

${C.bold('Usage')}
  datadeck clean <file> [options]     Clean + analyze a CSV/Excel file, write the bundle
  datadeck profile <file> [--sheet]   Inspect a file without changing it
  datadeck sheets <file>              List sheets in an Excel workbook
  datadeck chat ["message"]           Talk to the Pro Agent (needs model credentials)

${C.bold('clean options')}
  --out <dir>        Output directory (default: ./out)
  --sheet <name>     Excel sheet to read
  --base <CUR>       Target currency to convert into (needs --rates)
  --rates <json>     Exchange rates, e.g. '{"EUR":1.08,"GBP":1.27}'

${C.dim('The clean/profile/sheets commands are fully offline — no credentials needed.')}`);
}

async function cmdClean(args: ParsedArgs): Promise<void> {
  const file = args.positionals[0];
  if (!file) {
    console.error(C.red('Please provide a file: datadeck clean <file>'));
    process.exit(1);
  }
  const options: CleaningOptions = {};
  if (typeof args.flags.base === 'string') options.baseCurrency = args.flags.base;
  if (typeof args.flags.rates === 'string') {
    try {
      options.exchangeRates = JSON.parse(args.flags.rates);
    } catch {
      console.error(C.red('--rates must be valid JSON, e.g. \'{"EUR":1.08}\''));
      process.exit(1);
    }
  }
  const sheet = typeof args.flags.sheet === 'string' ? args.flags.sheet : undefined;
  const outDir = typeof args.flags.out === 'string' ? args.flags.out : './out';

  console.log(C.dim(`Reading ${file}…`));
  const result = await runPipelineOnPath(file, options, sheet);
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const written = await writeArtifacts(result, outDir, base);

  console.log('');
  console.log(C.aqua(C.bold('✓ ' + headline(result))));
  console.log('');

  console.log(C.bold('What changed'));
  if (result.clean.changeSummary.length === 0) console.log('  • nothing needed fixing');
  for (const c of [...result.clean.changeSummary].sort((a, b) => b.count - a.count)) {
    console.log(`  • ${c.label}: ${C.bold(String(c.count))}`);
  }
  console.log('');

  const byReason = new Map<FlagReason, number>();
  for (const f of result.clean.flags) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
  console.log(C.bold('Needs your review'));
  if (byReason.size === 0) console.log('  • nothing — no ambiguous rows 🎉');
  for (const [reason, count] of byReason) console.log(`  • ${C.yellow(FLAG_TITLES[reason])}: ${C.bold(String(count))}`);
  console.log('');

  console.log(C.bold('First look'));
  for (const h of result.analysis.highlights) console.log(`  • ${h}`);
  console.log('');

  console.log(C.bold('Outputs'));
  for (const f of written.files) console.log(`  • ${f}`);
  console.log(`  • ${C.aqua(written.zip)}  ${C.dim('(ZIP bundle)')}`);
}

async function cmdProfile(args: ParsedArgs): Promise<void> {
  const file = args.positionals[0];
  if (!file) {
    console.error(C.red('Please provide a file: datadeck profile <file>'));
    process.exit(1);
  }
  const sheet = typeof args.flags.sheet === 'string' ? args.flags.sheet : undefined;
  const buffer = await fs.readFile(file);
  const table = await parseFile(buffer, path.basename(file), sheet);
  const profile = profileTable(table);
  console.log(C.bold(`${path.basename(file)} — ${profile.rowCount} rows, ${profile.columnCount} columns`));
  console.log(C.dim(`Missing cells: ${profile.missingCells}/${profile.totalCells} · Duplicate rows: ${profile.duplicateRowCount}`));
  console.log('');
  for (const c of profile.columns) {
    const issues = c.formatIssues.length ? C.yellow(' — ' + c.formatIssues.join('; ')) : '';
    console.log(`  ${C.bold(c.name)} ${C.dim('[' + c.detectedType + ']')} ${Math.round(c.fillRate * 100)}% filled, ${c.unique} unique${issues}`);
  }
}

async function cmdSheets(args: ParsedArgs): Promise<void> {
  const file = args.positionals[0];
  if (!file) {
    console.error(C.red('Please provide a file: datadeck sheets <file>'));
    process.exit(1);
  }
  if (detectKind(file) !== 'excel') {
    console.log(`${path.basename(file)} is not an Excel file; it has no sheets.`);
    return;
  }
  const buffer = await fs.readFile(file);
  console.log(`Sheets: ${(await listSheets(buffer)).join(', ')}`);
}

async function cmdChat(args: ParsedArgs): Promise<void> {
  // Lazy import so the offline commands never require the model SDK/credentials.
  const { createAgent } = await import('../agent/agent');
  const agent = createAgent({ printer: true });
  const oneShot = args.positionals.join(' ').trim();

  if (oneShot) {
    await agent.invoke(oneShot);
    return;
  }

  console.log(C.aqua(C.bold('DataDeck Agent — chat')) + C.dim('  (type "exit" to quit)'));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () =>
    rl.question(C.aqua('you › '), async (line) => {
      const msg = line.trim();
      if (msg === 'exit' || msg === 'quit') {
        rl.close();
        return;
      }
      if (msg) {
        try {
          await agent.invoke(msg);
        } catch (err) {
          console.error(C.red(`Agent error: ${(err as Error).message}`));
          console.error(C.dim('The chat surface needs model credentials (see .env.example). The clean/profile commands work offline.'));
        }
      }
      prompt();
    });
  prompt();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
      case 'clean': return await cmdClean(args);
      case 'profile': return await cmdProfile(args);
      case 'sheets': return await cmdSheets(args);
      case 'chat': return await cmdChat(args);
      case 'help':
      case '--help':
      case '-h':
        return printHelp();
      default:
        console.error(C.red(`Unknown command: ${args.command}`));
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(C.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

main();

// ─────────────────────────────────────────────────────────────
// DataDeck Agent — Telegram surface
// Send a messy file to the bot; get back a plain-language summary,
// the flagged items, and the cleaned ZIP bundle — in the chat.
// ─────────────────────────────────────────────────────────────
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { runPipelineOnBuffer, bundleZip, headline } from '../core/pipeline';
import { renderMarkdownSummary, FLAG_TITLES } from '../core/report';
import type { FlagReason } from '../core/types';

const WELCOME = `👋 I'm the *DataDeck Agent* — a Pro Agent for messy data.

Send me a *CSV or Excel file* and I'll:
• clean it (dates, whitespace, labels, numbers, duplicates),
• flag anything I'm unsure about (I never delete or guess),
• run a quick first-look analysis,
• and send back a ZIP with the cleaned file + reports.

Just attach a file to get started.`;

function flagBreakdown(flags: { reason: FlagReason }[]): string {
  const by = new Map<FlagReason, number>();
  for (const f of flags) by.set(f.reason, (by.get(f.reason) ?? 0) + 1);
  if (by.size === 0) return 'Nothing needs your review 🎉';
  return [...by.entries()].map(([r, c]) => `• ${FLAG_TITLES[r]}: ${c}`).join('\n');
}

export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  bot.start((ctx) => ctx.reply(WELCOME, { parse_mode: 'Markdown' }));
  bot.help((ctx) => ctx.reply(WELCOME, { parse_mode: 'Markdown' }));

  bot.on(message('document'), async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name ?? 'upload.csv';
    const lower = name.toLowerCase();
    if (!/\.(csv|tsv|txt|xlsx|xls|xlsm)$/.test(lower)) {
      await ctx.reply(`I can clean CSV or Excel files. "${name}" doesn't look like one — try a .csv or .xlsx.`);
      return;
    }

    await ctx.reply(`Got "${name}". Cleaning it now… 🧹`);
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const res = await fetch(link.href);
      const buffer = Buffer.from(await res.arrayBuffer());

      const result = await runPipelineOnBuffer(buffer, name);

      const summaryText =
        `✅ ${headline(result)}\n\n` +
        `*Needs your review*\n${flagBreakdown(result.clean.flags)}\n\n` +
        `*First look*\n${result.analysis.highlights.map((h) => `• ${h}`).join('\n')}`;
      await ctx.reply(summaryText, { parse_mode: 'Markdown' });

      const zip = await bundleZip(result);
      const base = name.replace(/\.[^.]+$/, '');
      await ctx.replyWithDocument({ source: zip, filename: `${base}-datadeck.zip` });

      // Also send the plain-text summary as a file for easy reading.
      await ctx.replyWithDocument({
        source: Buffer.from(renderMarkdownSummary(result.clean, result.analysis), 'utf8'),
        filename: 'summary.md',
      });
    } catch (err) {
      await ctx.reply(`Sorry — I couldn't process that file. ${(err as Error).message}`);
    }
  });

  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return; // commands handled above
    // Try the conversational agent if credentials are configured; otherwise guide.
    try {
      const { ask } = await import('../agent/agent');
      const reply = await ask(text);
      await ctx.reply(reply || "I didn't catch that — try attaching a file.");
    } catch {
      await ctx.reply('Attach a CSV or Excel file and I\'ll clean it. (The chat brain needs model credentials to answer free-text.)');
    }
  });

  return bot;
}

// Launch when run directly.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and set it in .env (see .env.example).');
    process.exit(1);
  }
  const bot = createBot(token);
  bot.launch().then(() => console.log('DataDeck Agent Telegram bot is running.'));
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

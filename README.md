# DataDeck Agent

**A pre-analysis agent.** Hand it a raw, messy CSV or Excel file and it hands back data you can start analyzing right away — so the run-up to analysis (the wrangling, the sanity-checking, the “what am I even looking at”) is already done for you.

It doesn't just tidy a file. It gets your data to the **starting line of analysis**: consistent, validated, and already characterized — with a plain-language report of everything it changed and a first look at what the data says. It cleans by *meaning* (it knows “USA”, “U.S.A.” and “United States” are the same thing), and when something is genuinely unclear it **flags it for you instead of guessing**.

Use it however suits you: from the command line, as a web service, inside your own code, from your editor, over Telegram, straight from a GitHub repo, or through a guided step-by-step API.

---

## What it does

- **Cleans by meaning** — standardizes dates, trims stray spaces, unifies labels and capitalization, tidies numbers, and normalizes (optionally converts) currencies.
- **Merges duplicate rows.**
- **Flags, never guesses** — ambiguous dates, mixed currencies, likely outliers, and suspicious blanks are held for your review, never deleted or invented.
- **Characterizes your data** — summary statistics, distributions, and the strongest relationships (clean, solid charts — no heatmaps).
- **Documents the run** — every result comes with a report of what changed and what needs a human decision.

## How it works

The agent has **two layers**, and the split is the whole point:

1. **A deterministic engine (the hands).** It parses, applies fixes, flags, characterizes, and packages — but it doesn't *decide*. It has no AI model inside and needs **no credentials or network**, so the readiness step is repeatable and can run offline or in CI.
2. **A reasoning agent (the brain).** An AI model makes the judgement calls rules can't: it works out what each column *means*, decides which messy values are the *same thing*, resolves ambiguity (date order, currency), and sets the validation rules a column should hold to — then drives the engine to carry out the plan it reasoned.

It runs four moves on every file: **Draft** (clean + propose fixes) → **Check** (detect + validate) → **Organize** (standardize, characterize, report, package) → **Follow up** (flag what needs a human).

Cleaning is a series of **gated decisions**, not a bulk overwrite: every value is routed **fix / flag / leave**, and anything risky is held with a short, plain-language reason so what you analyze is *settled, not assumed*.

### How Strands is used

The brain is built on the **[AWS Strands Agents SDK](https://strandsagents.com/)** (TypeScript). A single Strands `Agent` is given a system prompt and a small set of **tools** — the agent calls them in order to reason a per-column plan and execute it:

- `profile_dataset` — understand the file's shape before touching it.
- `inspect_columns` — list the actual distinct values so the model can reason about what they *mean*.
- `apply_cleaning_plan` — execute the model's per-column plan (category maps, date order, currency target, validation rules) via the deterministic engine.
- `quick_auto_clean` — a fast deterministic pass when no reasoning is needed.
- `list_sheets` — enumerate Excel worksheets.

Strands keeps the agent **provider-agnostic**: the model is chosen at runtime behind one builder, so you can point it at Google **Gemini** (the default) or Amazon **Bedrock** without touching the tools or the engine. The reasoning layer is loaded only when needed, which is why the deterministic paths stay credential-free.

## Who it's for

- **Analysts & data scientists** who want the pre-analysis grind gone — open a dataset already oriented.
- **Data & platform engineers** who want a repeatable readiness step in a pipeline or CI (deterministic mode needs no model or network), with reasoning reserved for the messy edge cases.
- **Developers & AI builders** who want to call the capability (API/SDK), wire it into an editor/assistant (MCP), or run it as a hosted service.
- **Ops, finance & support teams** who live in exported spreadsheets and need them made analysis-ready fast, with a clear record of what changed and what to check.

## What you get from each run

| File | What it is |
| --- | --- |
| `cleaned.csv` | your data, cleaned and ready to analyze |
| `cleaning-report.html` | every change made, and everything flagged for review — each with a reason, plus a per-column profile |
| `analysis-report.html` | a first look: key numbers, distributions, and the strongest relationships |
| `summary.md` / `summary.json` | a short recap for people and for other tools |
| `site/` | a small multi-page website of the results (repo mode & Workspace) |
| a `.zip` bundle | all of the above in one download |

## Architecture at a glance

```
                 ┌───────────────────────────────────────────────┐
  your file ──▶  │  Strands Agent (the brain)                    │
                 │  profile_dataset → inspect_columns →          │
                 │  reason a per-column plan → apply_cleaning_plan│
                 │        │  (Gemini by default, Bedrock optional)│
                 └────────┼──────────────────────────────────────┘
                          ▼
                 ┌───────────────────────────────────────────────┐
                 │  Deterministic engine (the hands) — no model,  │
                 │  no credentials:                               │
                 │  parse → detect → clean/apply → analyze →      │
                 │  report → package                              │
                 └───────────────────────────────────────────────┘
                          ▼
        cleaned.csv · cleaning report · analysis report · summaries · ZIP · site
```

Reach it eight ways — **CLI, HTTP API, SDK, MCP, Telegram, GitHub repo mode, a guided Workspace API**, and a **container** you can host (it serves the same engine on port 8080). The deterministic core runs anywhere with no key; the reasoning layer just needs a model key.

---

## Requirements

- **[Node.js](https://nodejs.org) 22 or newer.** Check with `node -v`.
- **(Optional) an AI model key** for the smart features. The plain clean + analysis works with **no key**; the reasoning features (chat, guided planning, repo mode) use a free **Google Gemini** key.

## Install

```bash
git clone https://github.com/<your-account>/datadeck-agent.git
cd datadeck-agent
npm install
```

## Try it in 30 seconds (no key needed)

```bash
npm run demo
```
Cleans the included `examples/messy-sample.csv` into `./out`. Open `out/cleaning-report.html` and `out/analysis-report.html` to see what it did.

## Get your AI key (for the smart features)

1. Go to **https://aistudio.google.com/apikey**, sign in, and **Create API key**.
2. Copy the settings template and paste your key:
   ```bash
   cp .env.example .env
   ```
   In `.env`, set:
   ```
   GEMINI_API_KEY=your-key-here
   DATADECK_MODEL_ID=gemini-flash-latest
   ```
> If you ever see “model not available”, use `DATADECK_MODEL_ID=gemini-flash-latest` — some newer keys can't use older model names.

---

## Ways to use it

Same engine, same promises, eight front doors.

### 1. Command line
```bash
npm run cli -- clean path/to/your-file.csv --out ./out   # clean into ./out
npm run cli -- profile path/to/your-file.csv             # just look (no changes)
npm run cli -- sheets path/to/book.xlsx                  # list Excel sheets
npm run cli -- chat "clean my-file.csv and tell me what needs my review"   # plain English (needs key)
```
`clean` options: `--sheet "Sheet1"`, `--base USD`, `--rates '{"EUR":1.08,"GBP":1.27}'`.

### 2. As a web service (HTTP API)
```bash
npm run api          # http://localhost:8787
curl -F "file=@your-file.csv" http://localhost:8787/clean            # JSON summary
curl -F "file=@your-file.csv" http://localhost:8787/clean/bundle -o results.zip
curl -F "file=@your-file.csv" http://localhost:8787/profile
```
Endpoints: `GET /health`, `POST /profile`, `POST /sheets`, `POST /clean`, `POST /clean/bundle`, `POST /clean/artifact/:name`, `POST /ask` (needs key).

### 3. In your own code (SDK)
```ts
import { DataDeck } from './src/sdk';
const result = await DataDeck.clean(fileBuffer, 'data.csv');
console.log(DataDeck.headline(result));
const zip = await DataDeck.toZip(result);
```
Or point it at a running API with `DataDeckClient({ baseUrl: 'http://localhost:8787' })`.

### 4. In your editor or AI assistant (MCP)
```bash
npm run mcp          # speaks MCP over stdio
```
Config entry:
```json
{ "mcpServers": { "datadeck": { "command": "npx", "args": ["tsx", "src/mcp/server.ts"] } } }
```
Your assistant can call `profile_dataset`, `clean_dataset`, and `list_sheets` on a path or pasted content.

### 5. Telegram bot
1. Message **@BotFather**, create a bot, copy its token.
2. Put it in `.env`: `TELEGRAM_BOT_TOKEN=...`
3. `npm run telegram`, then send the bot a CSV/Excel file — it replies with a summary, the flagged items, and the cleaned ZIP.

### 6. In your GitHub repo (drop-a-file mode)
1. Push this project to your own GitHub repository (the workflow at `.github/workflows/datadeck-agent.yml` is included).
2. On GitHub: **Settings → Secrets and variables → Actions**, add a secret **`GEMINI_API_KEY`**.
3. Add a CSV/Excel file to the **`inbox/`** folder and push it.
4. The agent runs automatically and commits a new folder under **`projects/`** with the cleaned data, reports, and a small website.

Optional secrets `RESEND_API_KEY` (email you the results) and `VERCEL_TOKEN` (publish the website) — see “Optional add-ons”.

### 7. Guided, step-by-step (Workspace API)
Prefer to approve the plan before anything changes?
```bash
npm run workspace     # http://localhost:8790
```
Flow: upload (`/workspace/profile`) → the agent **proposes** a plan (`/workspace/plan`) → you confirm → it runs (`/workspace/run`) → download (`/workspace/file/...`).

### 8. Run it in the cloud (container)
```bash
docker build -t datadeck-agent .
docker run -p 8080:8080 -e GEMINI_API_KEY=your-key datadeck-agent
```
Serves the agent's runtime endpoint on port 8080, ready to sit behind your own hosting or a serverless container platform (it follows the AWS AgentCore runtime contract, `GET /ping` + `POST /invocations`).

---

## Optional add-ons

Entirely optional. If you don't set them up, those steps are simply skipped — the agent tells you honestly rather than pretending.

- **Email the results (Resend).** Create a key at **https://resend.com**, set `RESEND_API_KEY`, and set `EMAIL_FROM` to an address on a domain you've verified with Resend (plus `EMAIL_TO` for repo mode).
- **Publish the website (Vercel).** Set `VERCEL_TOKEN` (and `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`) to put the HTML report online and include the link.

## How it treats your data

- **It reasons about meaning**, not just formatting — that's the difference between a real cleanup and find-and-replace.
- **It never guesses.** Anything genuinely ambiguous is **flagged for your review**, not changed silently.
- **No hidden fallback.** The reasoning features need an AI key. If one isn't set, the agent says so — it won't quietly switch to blunt rules and change your data in ways you didn't choose.
- **Currency is only converted when you provide rates.** Otherwise mixed-currency values are flagged.

## Troubleshooting

- **“model not available to new users”** → set `DATADECK_MODEL_ID=gemini-flash-latest`.
- **Occasional “high demand” / rate-limit messages** → the free tier has limits; wait a moment and retry. The agent reports this honestly instead of faking a result.
- **Excel won't read** → make sure it's a real `.xlsx`/`.xls`; try `npm run cli -- sheets your.xlsx`.
- **`npm run demo` needs no key** — if that works, your install is fine and any remaining issue is just the AI key/config.

## License

Released under the [MIT License](./LICENSE).

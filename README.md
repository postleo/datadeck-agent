# DataDeck Agent

**Hand it a messy spreadsheet — get back clean, analysis-ready data you can trust.**

DataDeck Agent is an AI agent that takes a raw, messy CSV or Excel file and turns it into a tidy dataset, with a plain-language report of everything it changed and a first look at what your data says. It cleans by *meaning* — it understands that “USA”, “U.S.A.” and “United States” are the same thing — and when something is genuinely unclear, it **flags it for you instead of guessing**.

You can use it however suits you: from the command line, as a web service, inside your own code, from your editor, over Telegram, straight from a GitHub repo, or through a guided step-by-step web API.

---

## What it does

- **Cleans by meaning** — standardizes dates, trims stray spaces, unifies labels and capitalization, tidies numbers, and normalizes (optionally converts) currencies.
- **Merges duplicate rows.**
- **Flags, never guesses** — ambiguous dates, mixed currencies, possible outliers, and suspicious blanks are held for your review, never deleted or invented.
- **Gives you a first look** — summary statistics, distributions, and the strongest relationships in your data (clean, solid charts).
- **Explains itself** — every run comes with a report of what changed and what needs a human decision.

## What you get from each run

| File | What it is |
| --- | --- |
| `cleaned.csv` | your data, cleaned and ready to use |
| `cleaning-report.html` | every change made, and everything flagged for review — with reasons |
| `analysis-report.html` | a first look: key numbers, distributions, and relationships |
| `summary.md` / `summary.json` | a short recap for people and for other tools |
| `site/` | a small multi-page website of the results (repo mode & Workspace) |
| a `.zip` bundle | all of the above in one download |

---

## Requirements

- **[Node.js](https://nodejs.org) version 22 or newer.** Check with `node -v`.
- **(Optional) an AI model key** for the smart features. The plain clean + analysis works with **no key at all**; the reasoning features (chat, guided planning, repo mode) use a free **Google Gemini** key.

## Install

```bash
# 1. Get the code
git clone https://github.com/<your-account>/datadeck-agent.git
cd datadeck-agent

# 2. Install dependencies
npm install
```

## Try it in 30 seconds (no key needed)

```bash
npm run demo
```

This cleans the included `examples/messy-sample.csv` and writes the results to `./out`. Open `out/cleaning-report.html` and `out/analysis-report.html` in your browser to see what it did.

---

## Get your AI key (for the smart features)

Most everyday cleaning works without a key. To use the agent's reasoning (the chat, the guided Workspace, and repo mode), get a **free Google Gemini key**:

1. Go to **https://aistudio.google.com/apikey** and sign in.
2. Click **Create API key** and copy it.
3. In the project folder, copy the settings template and paste your key:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and set:
   ```
   GEMINI_API_KEY=your-key-here
   DATADECK_MODEL_ID=gemini-flash-latest
   ```

> Tip: if you ever see “model not available”, set `DATADECK_MODEL_ID=gemini-flash-latest` — some newer keys can't use older model names.

---

## Ways to use it

Pick whichever fits how you work. They all use the same engine and produce the same trustworthy results.

### 1. Command line

```bash
# clean a file into ./out
npm run cli -- clean path/to/your-file.csv --out ./out

# just look at a file (no changes)
npm run cli -- profile path/to/your-file.csv

# list the sheets in an Excel workbook
npm run cli -- sheets path/to/book.xlsx

# ask in plain English (needs your AI key)
npm run cli -- chat "clean my-file.csv and tell me what needs my review"
```
Handy options for `clean`: `--sheet "Sheet1"`, `--base USD`, `--rates '{"EUR":1.08,"GBP":1.27}'`.

### 2. As a web service (HTTP API)

```bash
npm run api          # starts on http://localhost:8787
```
Then, from anywhere:
```bash
# a JSON summary
curl -F "file=@your-file.csv" http://localhost:8787/clean

# download the full bundle
curl -F "file=@your-file.csv" http://localhost:8787/clean/bundle -o results.zip

# just profile it
curl -F "file=@your-file.csv" http://localhost:8787/profile
```
Available: `GET /health`, `POST /profile`, `POST /sheets`, `POST /clean`, `POST /clean/bundle`, `POST /clean/artifact/:name`, and `POST /ask` (needs your AI key).

### 3. In your own code (SDK)

No server needed:
```ts
import { DataDeck } from './src/sdk';

const result = await DataDeck.clean(fileBuffer, 'data.csv');
console.log(DataDeck.headline(result));   // a one-line summary
const zip = await DataDeck.toZip(result); // the full bundle as bytes
```
Or point it at a running API:
```ts
import { DataDeckClient } from './src/sdk';
const client = new DataDeckClient({ baseUrl: 'http://localhost:8787' });
const summary = await client.clean(fileBytes, 'data.csv');
```

### 4. In your editor or AI assistant (MCP)

The agent can appear as tools inside any assistant that supports MCP (the Model Context Protocol).

```bash
npm run mcp          # speaks MCP over stdio
```
Add this to your assistant's MCP config:
```json
{ "mcpServers": { "datadeck": { "command": "npx", "args": ["tsx", "src/mcp/server.ts"] } } }
```
Your assistant can then call `profile_dataset`, `clean_dataset`, and `list_sheets` on a file path or pasted content.

### 5. Telegram bot

1. In Telegram, message **@BotFather**, create a bot, and copy its token.
2. Put the token in `.env`: `TELEGRAM_BOT_TOKEN=...`
3. Start it:
   ```bash
   npm run telegram
   ```
4. Send the bot a CSV or Excel file — it replies with a summary, the flagged items, and the cleaned ZIP, right in the chat.

### 6. In your GitHub repo (drop-a-file mode)

Let the agent clean files automatically whenever you add them to your repository.

1. Push this project to your own GitHub repository (it already includes the workflow at `.github/workflows/datadeck-agent.yml`).
2. In your repo on GitHub, go to **Settings → Secrets and variables → Actions** and add a secret named **`GEMINI_API_KEY`** with your key.
3. Add a CSV/Excel file to the **`inbox/`** folder and push it.
4. The agent runs automatically, then commits a new folder under **`projects/`** with the cleaned data, the reports, and a small website.

Optional: add `RESEND_API_KEY` (email) and `VERCEL_TOKEN` (publish the website) as secrets to have it email you the results and put the report online — see “Optional add-ons” below.

### 7. Guided, step-by-step (Workspace API)

Prefer to review the plan before anything changes? The Workspace API lets the agent **propose** a cleaning plan that you approve before it runs.

```bash
npm run workspace     # starts on http://localhost:8790
```
The flow is: upload a file (`/workspace/profile`) → the agent proposes a plan (`/workspace/plan`) → you confirm → it runs (`/workspace/run`) → download the results (`/workspace/file/...`). This is the same interface used by the DataDeck Workspace web app.

### 8. Run it in the cloud (container)

A `Dockerfile` is included so you can run the agent as a hosted service:
```bash
docker build -t datadeck-agent .
docker run -p 8080:8080 -e GEMINI_API_KEY=your-key datadeck-agent
```
This serves the agent's runtime endpoint on port 8080, ready to sit behind your own hosting or a serverless container platform.

---

## Optional add-ons

These are entirely optional. If you don't set them up, those steps are simply skipped — the agent tells you honestly rather than pretending.

- **Email the results (Resend).** Create a key at **https://resend.com**, set `RESEND_API_KEY`, and set `EMAIL_FROM` to an address on a domain you've verified with Resend (and `EMAIL_TO` for repo mode). The agent will email the report with links to every file.
- **Publish the website (Vercel).** Set `VERCEL_TOKEN` (and `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`) to have the agent put the HTML report online and include the link.

---

## How it treats your data

- **It reasons about meaning**, not just formatting — that's the difference between a real cleanup and a find-and-replace.
- **It never guesses.** Anything genuinely ambiguous (an unreadable date, a mix of currencies with no exchange rate, an odd outlier, a blank in an otherwise-full column) is **flagged for your review**, not changed silently.
- **No hidden fallback.** The reasoning features need an AI key. If one isn't set, the agent says so clearly — it will not quietly switch to blunt rules and change your data in ways you didn't choose.
- **Currency is only converted when you provide rates.** Otherwise mixed-currency values are flagged.

---

## Troubleshooting

- **“model not available to new users”** → set `DATADECK_MODEL_ID=gemini-flash-latest` in `.env` (or as a repo variable for GitHub mode).
- **Occasional “high demand” / rate-limit messages** → the free tier has limits; wait a moment and retry. The agent reports this honestly instead of returning a fake result.
- **Excel file won't read** → make sure it's a real `.xlsx`/`.xls` workbook; try `npm run cli -- sheets your.xlsx` to list its sheets.
- **The plain `npm run demo` needs no key** — if that works, your install is fine and any remaining issue is just the AI key/config.

---

## License

Released under the [MIT License](./LICENSE).

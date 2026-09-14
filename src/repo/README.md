# DataDeck Agent — repo mode

Drop a dataset in a folder, push, and the **AI agent** cleans it, analyzes it,
builds a website, and emails you the results. This folder holds the repo-mode
pieces that wrap the agent for that workflow.

## How it works (agent-orchestrated)

The **model does the orchestration** — this is not a deterministic script that
happens to call an LLM. For each dataset the agent:

1. **profiles** the file (`profile_dataset`),
2. **inspects** the messy columns (`inspect_columns`) and *reasons* about what
   the values mean,
3. decides a per-column **cleaning plan** (semantic category maps, date order,
   currency target, validation rules), and
4. calls **`deliver_project`** once to produce the whole project.

`run.ts` only finds datasets, sets up folders, checks a model is available, and
verifies the agent delivered. The intelligence lives in the model.

### No deterministic fallback

DataDeck is an AI agent. If **no model is configured** or the **agent fails**,
`run.ts` does **not** rule-clean the data. It writes an honest **failure
notice** — `FAILED.md`, a `manifest.json` with `"status": "failed"`, and a
styled failure email — so you know the run needs attention. Failed datasets are
retried on the next run; delivered ones are skipped.

## Files

| File | Role |
| --- | --- |
| `run.ts` | Scanner/entry point. Finds inbox datasets, sets up project folders, checks the model, delegates to the agent, verifies delivery, writes failure notices. **No cleaning logic.** |
| `agentRunner.ts` | Builds the agent with the repo toolset + a headless system prompt, and lets it orchestrate one dataset. |
| `tools.ts` | The repo toolset: `profile_dataset`, `inspect_columns`, and `deliver_project` (executes the model's plan and produces every deliverable). |
| `deliver.ts` | The mechanical hands: runs the agent's plan, writes artifacts, builds the site, deploys, emails, writes the manifest. Also `writeFailure()`. |
| `site.ts` | Builds the multipage HTML site (index / cleaning / analysis / data). |
| `email.ts` | Styled task-report email + failure email (Resend, best-effort) and markdown reports. |
| `vercel.ts` | Best-effort `vercel deploy` of the built site. |

## What lands in `projects/<dataset>-<hash>/`

- `cleaned.csv` — the cleaned dataset
- `cleaning-report.html` — every change + everything flagged for review
- `analysis-report.html` — the pre-analysis / first look
- `summary.md`, `summary.json` — machine + human summaries
- `<dataset>-datadeck.zip` — the full bundle
- `site/` — the **multipage** HTML site (each page multi-section)
- `source/` — a copy of the original file (untouched)
- `email.html` — the exact styled email that was sent
- `report.md` — plain-text task report
- `manifest.json` — machine record (`status: "delivered"`), or a failure record

On failure instead: `FAILED.md` + `manifest.json` with `"status": "failed"`.

## Configuration (env / GitHub secrets & variables)

| Name | Kind | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | secret | Gemini model key (default provider). |
| `DATADECK_PROVIDER` | var | `google` (default) or `bedrock`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | secret/var | Amazon Bedrock (when provider is `bedrock`). |
| `RESEND_API_KEY` | secret | Send the report email via Resend. |
| `EMAIL_TO` / `EMAIL_FROM` | var | Recipient / sender for the email. |
| `VERCEL_TOKEN` | secret | Deploy the HTML site to Vercel. |
| `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | secret | Target the right Vercel project. |
| `INBOX_DIR` / `PROJECTS_DIR` | var | Override the default `inbox` / `projects` folders. |

> Note: email (Resend) and deploy (Vercel) are **third-party services**. They're
> optional and best-effort — if their keys are absent, the agent still writes
> `email.html` and builds the site locally, and simply records that they weren't
> sent/deployed. Nothing is ever logged that would expose a secret value.

## Run it locally

```bash
cd agent
npm ci
export GEMINI_API_KEY=...        # a model is required — no key, no run
export EMAIL_TO=you@example.com  # optional
npm run repo:run                 # scans ../inbox, writes ../projects
```

## GitHub Action

`.github/workflows/datadeck-agent.yml` runs on any push under `inbox/**`,
processes the datasets, and commits the deliverables back to the branch.

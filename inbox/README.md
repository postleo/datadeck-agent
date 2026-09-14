# inbox/ — drop a dataset here

This folder powers **repo mode**. Add a **CSV or Excel** file here (`.csv`, `.tsv`,
`.xlsx`, `.xls`) and push it to GitHub. The DataDeck Agent (via the included
GitHub Action) picks it up automatically and:

1. reads and understands your file,
2. decides how to clean it,
3. creates a project folder under `../projects/<your-file>-<id>/` with the cleaned
   data, a cleaning report, an analysis report, a summary, a ZIP, and a small
   website,
4. optionally emails you the results and publishes the website,
5. commits everything back to your repository.

You need a Google Gemini API key stored as the repository secret
`GEMINI_API_KEY` (see the main README, "Use it in your GitHub repo"). Without a
key configured, the agent leaves an honest note explaining what's missing —
it never quietly guesses at your data.

// ─────────────────────────────────────────────────────────────
// DataDeck Agent — optional Vercel deploy of the HTML deliverable
//
// If VERCEL_TOKEN is set, deploys the given static site directory to Vercel and
// returns the URL. Non-interactive when VERCEL_ORG_ID + VERCEL_PROJECT_ID are
// also set (recommended in CI). If no token, it's skipped — the site is still
// committed to the repo, so a Vercel-connected repo can auto-serve it.
// Never throws; never logs the token.
// ─────────────────────────────────────────────────────────────
import { execFile } from 'node:child_process';

export interface DeployResult { deployed: boolean; url?: string; error?: string; }

export function deploySite(siteDir: string): Promise<DeployResult> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return Promise.resolve({ deployed: false, error: 'VERCEL_TOKEN not set' });

  const args = ['--yes', 'vercel', 'deploy', siteDir, '--prod', '--yes', '--token', token];
  return new Promise((resolve) => {
    const child = execFile('npx', args, { timeout: 180000, env: process.env }, (err, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`;
      const url = (out.match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/g) || []).pop();
      if (url) return resolve({ deployed: true, url });
      resolve({ deployed: false, error: (err ? err.message : 'no deployment URL returned').slice(0, 200) });
    });
    child.on('error', (e) => resolve({ deployed: false, error: e.message }));
  });
}

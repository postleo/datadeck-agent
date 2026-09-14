// ─────────────────────────────────────────────────────────────
// DataDeck Agent — multipage HTML deliverable site
//
// Builds a small, brand-styled, MULTIPAGE site (one section-rich page each for
// Overview, Cleaning, Analysis, and Data) from a pipeline result. This is the
// HTML deliverable that gets committed to the project folder and (optionally)
// deployed to Vercel. Solid colors only (no gradients), Sora, aqua/ink brand.
// ─────────────────────────────────────────────────────────────
import type { PipelineResult } from '../core/pipeline';
import { horizontalBarChart, correlationBarChart } from '../core/charts';
import type { BarDatum } from '../core/charts';

export interface SiteMeta {
  datasetName: string;
  quality: number;
  generatedAt: string;
  sourceFile: string;
}

const NAV = [
  ['index.html', 'Overview'],
  ['cleaning.html', 'Cleaning'],
  ['analysis.html', 'Analysis'],
  ['data.html', 'Data'],
] as const;

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shell(active: string, meta: SiteMeta, body: string): string {
  const nav = NAV.map(([href, label]) =>
    `<a href="${href}" class="${href === active ? 'on' : ''}">${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DataDeck · ${esc(meta.datasetName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--ink:#0C1D1B;--sur:#F4F6F8;--card:#fff;--line:#DDE8E7;--mut:#5C7370;
        --aqua6:#0E9C8E;--aqua5:#17C4B0;--aqua3:#7FE0D2;--aqua1:#DCF5F1;--acc:#F5C948;--err:#D9534F;--warn:#C9821A;}
  *{box-sizing:border-box}
  body{margin:0;font-family:Sora,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--sur);color:var(--ink);line-height:1.55}
  header{background:var(--ink);color:#fff;padding:0}
  .bar{max-width:1040px;margin:0 auto;padding:16px 22px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .logo{width:26px;height:26px;border-radius:7px;background:var(--aqua5);display:inline-block;position:relative;flex:0 0 auto}
  .logo::after{content:"";position:absolute;inset:5px;border-radius:4px;background:var(--ink)}
  .brand{font-weight:700;font-size:17px;letter-spacing:-.02em}
  nav{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap}
  nav a{color:#bfe7e0;text-decoration:none;font-size:13.5px;padding:6px 11px;border-radius:8px}
  nav a:hover{background:rgba(255,255,255,.08);color:#fff}
  nav a.on{background:var(--aqua6);color:#fff;font-weight:600}
  main{max-width:1040px;margin:0 auto;padding:26px 22px 80px}
  h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;color:var(--aqua6);margin:34px 0 10px}
  .sub{color:var(--mut);margin:0 0 18px;font-size:14px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .kpi{font-size:24px;font-weight:700;letter-spacing:-.02em}.kpi.small{font-size:18px}
  .lbl{color:var(--mut);font-size:12px;margin-top:2px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:10px 0}
  table{width:100%;border-collapse:collapse;font-size:13px;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
  th{background:var(--aqua1);color:#0b423c;font-weight:600}
  tr:last-child td{border-bottom:none}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600}
  .pill.flag{background:#FBEFC8;color:#7a5b00}.pill.ok{background:#DCF3E8;color:#157a4b}.pill.q{background:var(--aqua1);color:#0b423c}
  ul.hi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 14px 14px 30px;margin:0}
  ul.hi li{margin:5px 0}
  .old{color:var(--mut);text-decoration:line-through}.new{color:var(--aqua6);font-weight:600}
  .foot{color:var(--mut);font-size:12px;margin-top:40px;border-top:1px solid var(--line);padding-top:14px}
  figure{margin:8px 0 18px}
  .note{border-left:3px solid var(--acc);background:#fffdf5;padding:9px 13px;border-radius:0 8px 8px 0;font-size:13px;color:#5b4a13}
  .scroll{overflow-x:auto}
</style></head><body>
<header><div class="bar"><span class="logo"></span><span class="brand">DataDeck</span>
<nav>${nav}</nav></div></header>
<main>${body}
<div class="foot">${esc(meta.datasetName)} · cleaned by the DataDeck Agent · generated ${esc(meta.generatedAt)} · source <code>${esc(meta.sourceFile)}</code></div>
</main></body></html>`;
}

function kpi(n: string | number, label: string, cls = ''): string {
  return `<div class="card"><div class="kpi ${cls}">${esc(n)}</div><div class="lbl">${esc(label)}</div></div>`;
}

function tableHtml(headers: string[], rows: string[][]): string {
  return `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ── Pages ─────────────────────────────────────────────────────
function pageOverview(r: PipelineResult, meta: SiteMeta): string {
  const c = r.clean;
  const removed = c.original.rows.length - c.cleaned.rows.length;
  const cards = [
    kpi(`${meta.quality}/100`, 'Data health', 'q' as unknown as string),
    kpi(c.original.rows.length, 'Rows in'),
    kpi(c.cleaned.rows.length, 'Rows out'),
    kpi(c.profile.columnCount, 'Columns'),
    kpi(c.changes.length, 'Changes made'),
    kpi(c.flags.length, 'Flagged for review'),
    kpi(removed, 'Duplicates merged'),
  ].join('');
  const hi = r.analysis.highlights.length
    ? `<ul class="hi">${r.analysis.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`
    : '<p class="sub">No highlights.</p>';
  const body = `
<h1>${esc(meta.datasetName)}</h1>
<p class="sub">From a raw upload to an analysis-ready dataset — what the agent did, what it flagged, and a first read of the data.</p>
<div class="cards">${cards}</div>
<h2>Highlights</h2>${hi}
<div class="note" style="margin-top:16px">Every change was applied to a copy of your data; ambiguous values were <b>flagged</b>, not guessed. See <a href="cleaning.html">Cleaning</a> and <a href="review-embedded">Analysis</a>.</div>`;
  return shell('index.html', meta, body);
}

function pageCleaning(r: PipelineResult, meta: SiteMeta): string {
  const c = r.clean;
  const changeRows = [...c.changeSummary].sort((a, b) => b.count - a.count).map((s) => [esc(s.label), String(s.count)]);
  const changeTbl = changeRows.length ? tableHtml(['What changed', 'Count'], changeRows) : '<p class="sub">No automatic changes were needed.</p>';
  const flagRows = c.flags.slice(0, 100).map((f) => [
    String((f.rowIndex ?? 0) + 1), esc(f.column),
    f.value === '' ? '<span class="old">(blank)</span>' : esc(f.value),
    `<span class="pill flag">${esc(f.reason)}</span>`, esc(f.why),
  ]);
  const flagTbl = c.flags.length ? tableHtml(['Row', 'Column', 'Value', 'Reason', 'Why it needs you'], flagRows)
    : '<p class="sub">Nothing was ambiguous — no rows need review. 🎉</p>';
  const colRows = c.profile.columns.map((col) => [
    esc(col.name), esc(col.detectedType), `${Math.round(col.fillRate * 100)}%`, String(col.unique),
    col.formatIssues.length ? esc(col.formatIssues.join('; ')) : '<span class="old">—</span>',
  ]);
  const body = `
<h1>Cleaning report</h1>
<p class="sub">Exactly what happened to <b>${esc(meta.sourceFile)}</b> and why.</p>
<h2>What changed</h2>${changeTbl}
<h2>What needs your review <span class="pill flag">${c.flags.length}</span></h2>
<p class="sub">Ambiguous or invalid values are flagged — never deleted or invented.</p>${flagTbl}
<h2>Columns at a glance</h2>${tableHtml(['Column', 'Detected type', 'Filled', 'Unique', 'Notes'], colRows)}`;
  return shell('cleaning.html', meta, body);
}

function pageAnalysis(r: PipelineResult, meta: SiteMeta): string {
  const a = r.analysis;
  const corr = a.correlations.length ? `<figure>${correlationBarChart(a.correlations)}</figure>`
    : '<p class="sub">Not enough numeric columns for correlations.</p>';
  const colCharts = a.columns.filter((c) => c.distribution?.length).map((c) => {
    const data: BarDatum[] = c.distribution.map((d) => ({
      label: d.value,
      value: d.count,
      display: c.distributionKind === 'histogram' ? String(d.count) : `${d.count} (${Math.round(d.share * 100)}%)`,
    }));
    const title = (c.distributionKind === 'histogram' ? 'Distribution of ' : 'Top values in ') + c.name;
    const stat = c.numeric
      ? `<p class="sub">min ${c.numeric.min} · max ${c.numeric.max} · mean ${c.numeric.mean} · median ${c.numeric.median} · std ${c.numeric.stdDev}</p>`
      : `<p class="sub">${c.unique} unique · ${c.missing} missing</p>`;
    return `<div class="panel"><h2 style="margin-top:0">${esc(c.name)} <span class="pill q">${esc(c.type)}</span></h2>${stat}<figure>${horizontalBarChart(title, data)}</figure></div>`;
  }).join('') || '<p class="sub">No columns to chart.</p>';
  const body = `
<h1>Pre-analysis</h1>
<p class="sub">A first look at the cleaned data — so analysis starts already oriented.</p>
<h2>Relationships between columns</h2>
<p class="sub">Strongest correlations, ranked. Aqua = move together, orange = move in opposite directions.</p>${corr}
<h2>Column by column</h2>${colCharts}`;
  return shell('analysis.html', meta, body);
}

function pageData(r: PipelineResult, meta: SiteMeta): string {
  const t = r.clean.cleaned;
  const N = Math.min(60, t.rows.length);
  const rows = t.rows.slice(0, N).map((row) => row.map((v) => (v === null || v === '' ? '<span class="old">(blank)</span>' : esc(v))));
  const body = `
<h1>Cleaned data</h1>
<p class="sub">First ${N} of ${t.rows.length} cleaned rows. Download the full file: <a href="../cleaned.csv">cleaned.csv</a>.</p>
<h2>Preview</h2>${tableHtml(t.headers, rows)}`;
  return shell('data.html', meta, body);
}

/** Build the full site as { filename -> html }. */
export function buildSite(result: PipelineResult, meta: SiteMeta): Record<string, string> {
  return {
    'index.html': pageOverview(result, meta),
    'cleaning.html': pageCleaning(result, meta),
    'analysis.html': pageAnalysis(result, meta),
    'data.html': pageData(result, meta),
  };
}

// ─────────────────────────────────────────────────────────────
// DataDeck Agent — chart rendering (inline SVG, solid fills only)
// Bar / column / donut charts. Deliberately NO heatmaps or scatter.
// ─────────────────────────────────────────────────────────────

const COLORS = {
  primary: '#17C4B0', // aquamarine
  accent: '#FFD23F', // happy yellow
  negative: '#F5892E', // orange (for negative correlation)
  ink: '#0C1D1B',
  muted: '#456260',
  line: '#DDE8E7',
  surface: '#FFFFFF',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface BarDatum {
  label: string;
  value: number;
  /** Optional value label shown at the end of the bar (defaults to value). */
  display?: string;
  color?: string;
}

/** Horizontal bar chart — reads well for categories and histograms. */
export function horizontalBarChart(title: string, data: BarDatum[], width = 640): string {
  if (data.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="60"><text x="12" y="34" font-family="Inter,system-ui,sans-serif" font-size="13" fill="${COLORS.muted}">No data for "${esc(title)}"</text></svg>`;
  }
  const rowH = 26;
  const padTop = 40;
  const padBottom = 12;
  const labelW = Math.min(180, Math.max(80, ...data.map((d) => d.label.length * 7)));
  const barX = labelW + 16;
  const barMaxW = width - barX - 64;
  const max = Math.max(...data.map((d) => d.value), 1);
  const height = padTop + data.length * rowH + padBottom;

  const bars = data
    .map((d, i) => {
      const y = padTop + i * rowH;
      const w = Math.max(1, (d.value / max) * barMaxW);
      const color = d.color ?? COLORS.primary;
      const disp = d.display ?? String(d.value);
      return `
    <text x="${labelW + 8}" y="${y + 15}" text-anchor="end" font-family="Inter,system-ui,sans-serif" font-size="12" fill="${COLORS.ink}">${esc(clip(d.label, 24))}</text>
    <rect x="${barX}" y="${y + 4}" width="${w}" height="${rowH - 12}" rx="3" fill="${color}"></rect>
    <text x="${barX + w + 6}" y="${y + 15}" font-family="Inter,system-ui,sans-serif" font-size="11" fill="${COLORS.muted}">${esc(disp)}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <rect width="${width}" height="${height}" fill="${COLORS.surface}"></rect>
  <text x="12" y="22" font-family="Inter,system-ui,sans-serif" font-size="14" font-weight="600" fill="${COLORS.ink}">${esc(title)}</text>
  ${bars}
</svg>`;
}

/** Ranked correlation bars — our accessible replacement for a heatmap. */
export function correlationBarChart(
  pairs: { a: string; b: string; r: number }[],
  width = 640,
): string {
  if (pairs.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="60"><text x="12" y="34" font-family="Inter,system-ui,sans-serif" font-size="13" fill="${COLORS.muted}">Not enough numeric columns to compare.</text></svg>`;
  }
  const data: BarDatum[] = pairs.map((p) => ({
    label: `${clip(p.a, 12)} ↔ ${clip(p.b, 12)}`,
    value: Math.abs(p.r),
    display: p.r.toFixed(2),
    color: p.r >= 0 ? COLORS.primary : COLORS.negative,
  }));
  return horizontalBarChart('Strongest relationships (correlation)', data, width);
}

/** Donut chart — share of total for a small number of categories. */
export function donutChart(title: string, data: BarDatum[], size = 220): string {
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 10;
  const inner = r * 0.6;
  const palette = [COLORS.primary, COLORS.accent, COLORS.negative, '#0E9C8E', '#7FE0D2', '#C77F16'];
  let angle = -Math.PI / 2;
  const segments = data
    .map((d, i) => {
      const frac = d.value / total;
      const end = angle + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(end);
      const y2 = cy + r * Math.sin(end);
      const path = `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
      angle = end;
      return `<path d="${path}" fill="${d.color ?? palette[i % palette.length]}"></path>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" role="img" aria-label="${esc(title)}">
  ${segments}
  <circle cx="${cx}" cy="${cy}" r="${inner}" fill="${COLORS.surface}"></circle>
</svg>`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export { COLORS };

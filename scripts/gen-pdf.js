#!/usr/bin/env node
/**
 * Generate PDF report from markdown using WeasyPrint.
 *
 * Usage:
 *   node scripts/gen-pdf.js
 *   node scripts/gen-pdf.js <report.md>
 *   node scripts/gen-pdf.js <report.md> <report.pdf>
 *   node scripts/gen-pdf.js <report.md> --charts
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SKILL_BASE = path.resolve(__dirname, '..');
const DIR = {
  reports: path.join(SKILL_BASE, 'reports'),
  charts: path.join(SKILL_BASE, 'charts'),
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:#f5f5f5;padding:1px 3px;">$1</code>');
}

function resolveChartFile(baseName) {
  if (!fs.existsSync(DIR.charts)) return null;

  const matches = fs.readdirSync(DIR.charts)
    .filter((name) => name === baseName || name.endsWith(`_${baseName}`))
    .sort()
    .reverse();

  if (matches.length === 0) return null;
  return path.join(DIR.charts, matches[0]);
}

function buildChartsHtml() {
  const chartConfigs = [
    { file: 'chart1_global_market.png', title: '附图 1：图表 1', alt: 'Chart 1' },
    { file: 'chart2_seasonal.png', title: '附图 2：图表 2', alt: 'Chart 2' },
    { file: 'chart3_projection.png', title: '附图 3：图表 3', alt: 'Chart 3' },
    { file: 'chart4_market_share.png', title: '附图 4：图表 4', alt: 'Chart 4' },
  ];

  const metadataPath = path.join(DIR.charts, 'metadata.json');
  let metadata = {};
  if (fs.existsSync(metadataPath)) {
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) || {};
    } catch (error) {
      console.warn(`Invalid chart metadata JSON: ${metadataPath}`);
    }
  }

  return chartConfigs
    .map((defaultChart) => {
      const chart = {
        ...defaultChart,
        ...(metadata[defaultChart.file] || {}),
      };
      const chartPath = resolveChartFile(chart.file);
      if (!chartPath) return '';

      const captionHtml = chart.caption
        ? `<p class="chart-caption">${renderInline(chart.caption)}</p>`
        : '';
      const insightHtml = chart.insight
        ? `<div class="highlight-box"><strong>洞察：</strong>${renderInline(chart.insight)}</div>`
        : '';

      return `
<div class="chart-section">
<h2>${renderInline(chart.title)}</h2>
<img src="${pathToFileURL(chartPath).href}" alt="${escapeHtml(chart.alt)}">
${captionHtml}
${insightHtml}
</div>`;
    })
    .filter(Boolean)
    .join('\n');
}

function mdToHtml(md, includeCharts = false) {
  const lines = md.split(/\r?\n/);
  let out = '';
  let i = 0;

  while (i < lines.length) {
    const s = lines[i].trim();

    if (s.startsWith('# ')) {
      out += `<h1 style="color:#2c3e50;font-size:20px;margin:25px 0 12px;">${renderInline(s.slice(2))}</h1>\n`;
      i++;
      continue;
    }
    if (s.startsWith('## ')) {
      out += `<h2 style="color:#2c3e50;font-size:15px;border-bottom:2px solid #4a90d9;padding-bottom:5px;margin:20px 0 10px;page-break-after:avoid;">${renderInline(s.slice(3))}</h2>\n`;
      i++;
      continue;
    }
    if (s.startsWith('### ')) {
      out += `<h3 style="color:#1a1a1a;font-size:13px;margin:15px 0 8px;">${renderInline(s.slice(4))}</h3>\n`;
      i++;
      continue;
    }
    if (s === '---') {
      out += '<hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">\n';
      i++;
      continue;
    }
    if (s.startsWith('|') && s.endsWith('|')) {
      const tableLines = [];
      while (i < lines.length) {
        const ts = lines[i].trim();
        if (!ts.startsWith('|') || !ts.endsWith('|')) break;
        tableLines.push(ts);
        i++;
      }

      const allRows = tableLines
        .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
        .filter((cells) => !cells.every((cell) => /^[-: ]+$/.test(cell)));

      if (allRows.length > 0) {
        const headerCells = allRows[0];
        const bodyRows = allRows.slice(1);

        const thHtml = headerCells
          .map((cell) => `<th style="background:#4a90d9;color:white;font-weight:bold;border:1px solid #ddd;padding:6px 8px;text-align:left;">${renderInline(cell)}</th>`)
          .join('');

        const tbHtml = bodyRows
          .map((cells, rowIndex) => {
            const bg = rowIndex % 2 === 0 ? 'white' : '#f5f9ff';
            const tdCells = cells
              .map((cell) => `<td style="border:1px solid #ddd;padding:5px 7px;background:${bg};">${renderInline(cell)}</td>`)
              .join('');
            return `<tr>${tdCells}</tr>`;
          })
          .join('\n');

        out += '<table style="border-collapse:collapse;width:100%;margin:10px 0;font-size:10px;page-break-inside:avoid;">\n';
        out += `<thead><tr>${thHtml}</tr></thead>\n<tbody>\n${tbHtml}\n</tbody>\n</table>\n`;
      }
      continue;
    }
    if (s.startsWith('- ') || s.startsWith('* ')) {
      const items = [];
      while (i < lines.length) {
        const ts = lines[i].trim();
        if (ts.startsWith('- ') || ts.startsWith('* ')) {
          items.push(`<li style="margin:3px 0;">${renderInline(ts.slice(2))}</li>`);
          i++;
        } else {
          break;
        }
      }
      out += `<ul style="margin:6px 0;padding-left:20px;">\n${items.join('\n')}\n</ul>\n`;
      continue;
    }
    if (!s) {
      i++;
      continue;
    }

    out += `<p style="margin:6px 0;line-height:1.6;">${renderInline(s)}</p>\n`;
    i++;
  }

  if (includeCharts) {
    const chartsHtml = buildChartsHtml();
    if (chartsHtml) {
      out = out.replace('（图表见 PDF 版本）', chartsHtml);
      if (!out.includes(chartsHtml)) {
        out += `\n${chartsHtml}\n`;
      }
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@page { size: A4; margin: 18mm 14mm; }
body {
  font-family: "WenQuanYi Micro Hei", "Microsoft YaHei", "SimHei", Arial, sans-serif;
  font-size: 11px;
  line-height: 1.6;
  color: #333;
  padding: 0;
  margin: 0;
}
h1 { color: #2c3e50; font-size: 20px; margin: 25px 0 12px; }
h2 { color: #2c3e50; font-size: 15px; border-bottom: 2px solid #4a90d9; padding-bottom: 5px; margin: 20px 0 10px; page-break-after: avoid; }
h3 { color: #1a1a1a; font-size: 13px; margin: 15px 0 8px; }
p { margin: 5px 0; line-height: 1.6; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 10px; page-break-inside: avoid; }
th { background: #4a90d9; color: white; font-weight: bold; border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
td { border: 1px solid #ddd; padding: 5px 7px; }
tr:nth-child(even) td { background: #f5f9ff; }
ul { margin: 6px 0; padding-left: 20px; }
li { margin: 3px 0; }
strong { color: #222; }
hr { border: none; border-top: 1px solid #ddd; margin: 10px 0; }
.highlight-box { background: #f0f7ff; border-left: 4px solid #4a90d9; padding: 8px 12px; margin: 8px 0; border-radius: 0 4px 4px 0; font-size: 11px; }
.chart-section { margin: 18px 0; text-align: center; page-break-inside: avoid; }
.chart-section img { max-width: 100%; height: auto; border: 1px solid #eee; border-radius: 4px; }
.chart-caption { font-size: 9px; color: #888; margin-top: 4px; font-style: italic; }
</style>
</head>
<body>${out}</body>
</html>`;
}

function resolveMarkdownInput(inputPath) {
  const initialPath = path.resolve(inputPath);
  const content = fs.readFileSync(initialPath, 'utf8');
  const trimmed = content.trim();

  if (!content.includes('\n') && /\.md$/i.test(trimmed)) {
    const candidate = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(path.dirname(initialPath), trimmed);

    if (fs.existsSync(candidate)) {
      return {
        path: candidate,
        markdown: fs.readFileSync(candidate, 'utf8'),
      };
    }
  }

  return {
    path: initialPath,
    markdown: content,
  };
}

function generatePdf(htmlPath, pdfPath) {
  const pyScript = [
    'import weasyprint',
    `doc = weasyprint.HTML(filename=r"""${htmlPath}""")`,
    `doc.write_pdf(r"""${pdfPath}""")`,
  ].join('\n');

  const commands = process.platform === 'win32'
    ? [
        ['python', ['-c', pyScript]],
        ['py', ['-3', '-c', pyScript]],
      ]
    : [
        ['python3', ['-c', pyScript]],
        ['python', ['-c', pyScript]],
      ];

  let lastError = null;
  for (const [cmd, args] of commands) {
    try {
      execFileSync(cmd, args, { stdio: 'inherit' });
      return;
    } catch (error) {
      lastError = error;
      if (error.code === 'ENOENT') continue;
      break;
    }
  }

  throw lastError || new Error('Unable to invoke Python / WeasyPrint');
}

async function main() {
  const args = process.argv.slice(2);
  const includeCharts = args.includes('--charts');
  const positionalArgs = args.filter((arg) => arg !== '--charts');

  const inputPath = positionalArgs[0]
    ? path.resolve(positionalArgs[0])
    : path.join(DIR.reports, 'latest_report.md');

  if (!fs.existsSync(inputPath)) {
    console.error('File not found:', inputPath);
    process.exit(1);
  }

  const { path: resolvedMdPath, markdown } = resolveMarkdownInput(inputPath);
  const base = path.basename(resolvedMdPath, '.md');
  const pdfPath = positionalArgs[1]
    ? path.resolve(positionalArgs[1])
    : path.join(DIR.reports, `${base}.pdf`);
  const htmlPath = path.join(path.dirname(pdfPath), `${path.basename(pdfPath, '.pdf')}.html`);

  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });

  const html = mdToHtml(markdown, includeCharts);
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('HTML:', htmlPath);

  generatePdf(htmlPath, pdfPath);

  const size = fs.statSync(pdfPath).size;
  console.log('PDF:', pdfPath, `(${(size / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

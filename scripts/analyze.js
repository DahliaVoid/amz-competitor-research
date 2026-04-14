#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SKILL_BASE = path.resolve(__dirname, '..');
const OUTPUT_DIR = {
  data: path.join(SKILL_BASE, 'data'),
  reports: path.join(SKILL_BASE, 'reports'),
  charts: path.join(SKILL_BASE, 'charts'),
  tmp: path.join(SKILL_BASE, 'tmp'),
};

function ts() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .slice(0, 15);
}

function cleanNum(val) {
  if (!val || val === '-') return 0;
  const n = parseFloat(String(val).replace(/[$,%，,\s]/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];

    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (c === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      continue;
    }

    current += c;
  }

  result.push(current.trim());
  return result;
}

function parseCSV(content) {
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const next = content[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (c === ',' && !inQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = '';
      continue;
    }

    if ((c === '\n' || c === '\r') && !inQuotes) {
      if (c === '\r' && next === '\n') {
        i++;
      }

      currentRow.push(currentCell.trim());
      currentCell = '';

      if (currentRow.some((cell) => cell !== '')) {
        rows.push(currentRow);
      }

      currentRow = [];
      continue;
    }

    currentCell += c;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((cell) => cell !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function loadCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const parsedRows = parseCSV(content);

  const headerStart = parsedRows.findIndex((row) =>
    row.some((cell) => String(cell).trim() === 'ASIN')
  );

  if (headerStart === -1) {
    throw new Error('CSV header not found: expected a row containing ASIN');
  }

  const headers = parsedRows[headerStart].map((header) => header.trim());
  const rows = [];

  for (let i = headerStart + 1; i < parsedRows.length; i++) {
    const values = parsedRows[i];

    if (values.length === 0 || values.every((value) => value === '')) {
      continue;
    }

    if (values.length < headers.length) {
      continue;
    }

    const row = {};
    headers.forEach((header, index) => {
      row[header] = (values[index] || '').trim();
    });
    rows.push(row);
  }

  return rows;
}

function analyze(rows) {
  const enriched = rows.map((row) => ({
    asin: row.ASIN || '',
    brand: row['品牌'] || 'Unknown',
    title: row['商品标题'] || '',
    price: cleanNum(row['价格'] || row['价格($)']),
    revenue: cleanNum(row['月销售额'] || row['月销售额($)']),
    sales: cleanNum(row['月销量']),
    days: cleanNum(row['上架天数']),
  }));

  const totalRevenue = enriched.reduce((sum, item) => sum + item.revenue, 0);
  const totalSales = enriched.reduce((sum, item) => sum + item.sales, 0);
  const avgPrice = enriched.length
    ? enriched.reduce((sum, item) => sum + item.price, 0) / enriched.length
    : 0;

  const topProducts = [...enriched]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20);

  const recentProducts = enriched
    .filter((item) => item.days > 0 && item.days <= 180)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20);

  return {
    generatedAt: new Date().toISOString(),
    sourceRowCount: rows.length,
    market: {
      totalSkus: enriched.length,
      totalRevenue,
      totalSales,
      avgPrice,
    },
    topProducts,
    recentProducts,
    titleCorpus: {
      topTitles: topProducts.map((item) => item.title).filter(Boolean),
      recentTitles: recentProducts.map((item) => item.title).filter(Boolean),
    },
  };
}

function writeMarkdown(facts) {
  let md = '# Competitor Facts Layer\n\n';
  md += `- Generated At: ${facts.generatedAt}\n`;
  md += `- Total SKUs: ${facts.market.totalSkus}\n`;
  md += `- Revenue: ${facts.market.totalRevenue}\n`;
  md += `- Sales: ${facts.market.totalSales}\n`;
  md += `- Avg Price: ${facts.market.avgPrice.toFixed(2)}\n\n`;

  md += '## Top Titles\n';
  facts.titleCorpus.topTitles.slice(0, 10).forEach((title) => {
    md += `- ${title}\n`;
  });

  md += '\n## Recent Titles\n';
  facts.titleCorpus.recentTitles.slice(0, 10).forEach((title) => {
    md += `- ${title}\n`;
  });

  return md;
}

function ensureOutputDirs() {
  Object.values(OUTPUT_DIR).forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });
}

function main() {
  const csvArg = process.argv[2];
  if (!csvArg) {
    console.error('Usage: node scripts/analyze.js <csv-path>');
    process.exit(1);
  }

  const csvPath = path.resolve(csvArg);
  const base = path.basename(csvPath, path.extname(csvPath));
  const stamp = ts();

  ensureOutputDirs();

  const jsonPath = path.join(OUTPUT_DIR.data, `${base}_${stamp}_facts.json`);
  const mdPath = path.join(OUTPUT_DIR.reports, `${base}_${stamp}_report.md`);
  const latestMdPath = path.join(OUTPUT_DIR.reports, 'latest_report.md');
  const latestPathRef = path.join(OUTPUT_DIR.reports, 'latest_report.path.txt');

  const rows = loadCSV(csvPath);
  const facts = analyze(rows);
  const markdown = writeMarkdown(facts);

  fs.writeFileSync(jsonPath, JSON.stringify(facts, null, 2), 'utf8');
  fs.writeFileSync(mdPath, markdown, 'utf8');
  fs.writeFileSync(latestMdPath, markdown, 'utf8');
  fs.writeFileSync(latestPathRef, mdPath, 'utf8');

  console.log(mdPath);
}

main();

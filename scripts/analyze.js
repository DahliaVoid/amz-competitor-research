#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SKILL_BASE = path.resolve(__dirname, '..');
const OUTPUT_DIR = {
  data: path.join(SKILL_BASE, 'data'),
  reports: path.join(SKILL_BASE, 'reports'),
  charts: path.join(SKILL_BASE, 'charts'),
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

function pickValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return row[key];
    }
  }
  return '';
}

function bandLabel(price) {
  if (price < 10) return '<$10';
  if (price < 20) return '$10-$19.99';
  if (price < 30) return '$20-$29.99';
  if (price < 50) return '$30-$49.99';
  return '$50+';
}

function analyze(rows) {
  const enriched = rows.map((row) => ({
    asin: pickValue(row, ['ASIN', 'asin']),
    brand: pickValue(row, ['品牌', 'Brand', 'brand']) || 'Unknown',
    title: pickValue(row, ['商品标题', '标题', 'Title', 'title']),
    price: cleanNum(pickValue(row, ['价格', '价格($)', 'Price', 'Price($)', 'price'])),
    revenue: cleanNum(pickValue(row, ['月销售额', '月销售额($)', 'Monthly Revenue', 'Revenue', 'revenue'])),
    sales: cleanNum(pickValue(row, ['月销量', 'Monthly Sales', 'sales'])),
    days: cleanNum(pickValue(row, ['上架天数', 'Days Listed', 'days'])),
    rating: cleanNum(pickValue(row, ['评分', 'Rating', 'rating'])),
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

  const brandMap = new Map();
  enriched.forEach((item) => {
    const key = item.brand || 'Unknown';
    if (!brandMap.has(key)) {
      brandMap.set(key, { brand: key, skuCount: 0, revenue: 0, sales: 0 });
    }
    const current = brandMap.get(key);
    current.skuCount += 1;
    current.revenue += item.revenue;
    current.sales += item.sales;
  });
  const topBrands = [...brandMap.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const bandMap = new Map();
  enriched.forEach((item) => {
    const label = bandLabel(item.price);
    if (!bandMap.has(label)) {
      bandMap.set(label, { band: label, skuCount: 0, totalRevenue: 0, sampleTitles: [] });
    }
    const current = bandMap.get(label);
    current.skuCount += 1;
    current.totalRevenue += item.revenue;
    if (item.title && current.sampleTitles.length < 5) {
      current.sampleTitles.push(item.title);
    }
  });
  const bandOrder = ['<$10', '$10-$19.99', '$20-$29.99', '$30-$49.99', '$50+'];
  const priceBands = bandOrder
    .map((label) => bandMap.get(label))
    .filter(Boolean)
    .map((item) => ({
      ...item,
      avgRevenuePerSku: item.skuCount ? item.totalRevenue / item.skuCount : 0,
    }));

  return {
    generatedAt: new Date().toISOString(),
    sourceRowCount: rows.length,
    market: {
      totalSkus: enriched.length,
      totalRevenue,
      totalSales,
      avgPrice,
      avgRating: enriched.length
        ? enriched.reduce((sum, item) => sum + item.rating, 0) / enriched.length
        : 0,
    },
    brandLandscape: {
      topBrands,
    },
    priceBandOpportunities: priceBands,
    topProducts,
    recentProducts,
    titleCorpus: {
      topTitles: topProducts.map((item) => item.title).filter(Boolean),
      recentTitles: recentProducts.map((item) => item.title).filter(Boolean),
      priceBandSampleTitles: priceBands.reduce((acc, band) => {
        acc[band.band] = band.sampleTitles;
        return acc;
      }, {}),
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
  md += `- Avg Rating: ${facts.market.avgRating.toFixed(2)}\n\n`;

  md += '## Brand Landscape (Top 10)\n';
  md += '| Brand | SKU Count | Revenue | Sales |\n';
  md += '|---|---:|---:|---:|\n';
  facts.brandLandscape.topBrands.forEach((brand) => {
    md += `| ${brand.brand} | ${brand.skuCount} | ${brand.revenue.toFixed(2)} | ${brand.sales.toFixed(2)} |\n`;
  });
  md += '\n';

  md += '## Price Band Opportunities\n';
  md += '| Price Band | SKU Count | Total Revenue | Avg Revenue / SKU |\n';
  md += '|---|---:|---:|---:|\n';
  facts.priceBandOpportunities.forEach((band) => {
    md += `| ${band.band} | ${band.skuCount} | ${band.totalRevenue.toFixed(2)} | ${band.avgRevenuePerSku.toFixed(2)} |\n`;
  });
  md += '\n';

  md += '## Top Titles\n';
  facts.titleCorpus.topTitles.slice(0, 10).forEach((title) => {
    md += `- ${title}\n`;
  });

  md += '\n## Recent Titles\n';
  facts.titleCorpus.recentTitles.slice(0, 10).forEach((title) => {
    md += `- ${title}\n`;
  });

  md += '\n## Price Band Sample Titles\n';
  Object.entries(facts.titleCorpus.priceBandSampleTitles).forEach(([band, titles]) => {
    if (!titles.length) return;
    md += `### ${band}\n`;
    titles.forEach((title) => {
      md += `- ${title}\n`;
    });
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

#!/usr/bin/env node
/**
 * Amazon competitor research — facts layer (schema 2.1).
 *
 *   CSV (卖家精灵 / Seller Sprite export)  ->  data/*_facts.json  +  reports/*_facts.md
 *
 * Contract:
 *   1. The script computes ONLY what the CSV contains. It never estimates, interpolates,
 *      annualises or back-fills.
 *   2. Three column states are distinguished and never conflated:
 *        ok             — column present and populated
 *        empty-column   — column present but blank in every row (export did not fill it)
 *        missing-column — no column matched the field
 *      Any metric whose source column is not `ok` is reported as null, never as 0.
 *   3. Every aggregate records the CSV column behind it and the n it used.
 *   4. No conclusion text is generated here. Interpretation belongs to the agent layer.
 *
 * Usage:
 *   node scripts/analyze.js <csv-path> [options]
 *
 * Options:
 *   --out <dir>              output root (default: the folder containing scripts/)
 *   --map <file.json>        extra column aliases, {"revenue":["Umsatz","売上"]}
 *   --currency <text>        force the currency label (default: read from the CSV header)
 *   --new-days <n>           "new listing" window, days (default 180)
 *   --top-brands <n>         brand rows kept (default 10)
 *   --top-products <n>       product rows kept (default 20)
 *   --top-keywords <n>       keyword rows kept (default 15)
 *   --keyword-min-share <f>  min share of titled rows for a keyword (default 0.02)
 *   --stopwords <file>       extra stop words, one per line (added to the built-in list)
 *   --max-rows <n>           cap on rows embedded in facts.skuTable (default 2000)
 *   --quiet                  suppress the summary on stdout
 *   --help
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '2.1';
const SCRIPT_DIR = __dirname;
const DEFAULT_OUT_ROOT = path.resolve(SCRIPT_DIR, '..');

/* ------------------------------------------------------------------ *
 * Field mapping
 *
 * Aliases are matched exactly first, then after normalisation (case,
 * spaces, underscores, brackets and currency symbols stripped), so one
 * alias entry covers every currency variant of a header: 月销售额($),
 * 月销售额(¥) and 月销售额(€) all resolve to `revenue`.
 *
 * The zh aliases below were verified against a real 卖家精灵 export
 * (see tmp/ in the skill repo). For other exporters or languages pass
 * a mapping file with --map instead of editing this table.
 * ------------------------------------------------------------------ */
const FIELD_ALIASES = {
  asin: ['ASIN', 'asin'],
  brand: ['品牌', 'Brand', 'brand'],
  title: ['商品标题', '标题', 'Title', 'Product Title', 'Product Name', 'title'],
  price: ['价格', 'Price', 'price'],
  revenue: ['月销售额', 'Monthly Revenue', 'Revenue', 'Sales Revenue', 'revenue'],
  sales: ['月销量', 'Monthly Sales', 'Sales', 'Units Sold', 'sales'],
  days: ['上架天数', 'Listing Days', 'Days Available', 'Days', 'days'],
  launchDate: ['上架时间', 'Launch Date', 'Date First Available'],
  category: ['小类目', 'Category', 'Subcategory'],
  categoryPath: ['类目路径', 'Category Path'],
  salesGrowth: ['月销量增长率', 'Sales Growth'],
  bsrSmall: ['小类BSR', 'BSR'],
  reviews: ['评分数', 'Reviews', 'Rating Count'],
  newReviews: ['月新增评分数', 'New Reviews'],
  rating: ['评分', 'Rating', 'Star Rating'],
  fulfillment: ['配送方式', 'Fulfillment'],
  sellers: ['卖家数', 'Sellers'],
  variants: ['变体数', 'Variants'],
  coupon: ['Coupon'],
  lqs: ['LQS'],
  amazonChoice: ["Amazon's Choice", 'Amazon Choice'],
  bestSeller: ['Best Seller标识', 'Best Seller'],
  newRelease: ['New Release标识', 'New Release'],
  aplus: ['A+页面', 'A+ Content'],
  video: ['视频介绍', 'Video'],
  spAd: ['SP广告', 'Sponsored'],
  grossMargin: ['毛利率', 'Gross Margin'],
  fbaFee: ['FBA', 'FBA Fee'],
  reviewRate: ['留评率', 'Review Rate'],
  sizeTier: ['包装尺寸分段', 'Size Tier'],
};

/** Logical fields carried into facts.skuTable, in column order. */
const SKU_TABLE_FIELDS = [
  'asin', 'brand', 'title', 'price', 'revenue', 'sales', 'salesGrowth',
  'bsrSmall', 'reviews', 'newReviews', 'rating', 'fulfillment', 'sellers',
  'variants', 'days', 'launchDate', 'lqs', 'amazonChoice', 'bestSeller',
  'newRelease', 'aplus', 'video', 'spAd', 'coupon', 'category', 'categoryPath',
  'grossMargin', 'fbaFee', 'reviewRate', 'sizeTier',
];

const NUMERIC_FIELDS = new Set([
  'price', 'revenue', 'sales', 'days', 'salesGrowth', 'bsrSmall', 'reviews',
  'newReviews', 'rating', 'sellers', 'variants', 'lqs',
  'grossMargin', 'fbaFee', 'reviewRate',
]);

/** Boolean-ish badge columns: a non-empty value other than N/n means "yes". */
const FLAG_FIELDS = ['amazonChoice', 'bestSeller', 'newRelease', 'aplus', 'video', 'spAd'];

/** Built-in English function words. Extend or replace with --stopwords. */
const GENERIC_STOP_WORDS = [
  'with', 'for', 'and', 'the', 'from', 'into', 'that', 'this', 'than', 'then',
  'are', 'was', 'were', 'you', 'your', 'our', 'their', 'its', 'can', 'will',
  'all', 'one', 'two', 'use', 'new', 'set', 'kit', 'pack', 'pcs', 'piece',
  'amazon', 'choice', 'best', 'seller', 'official',
];

const LISTING_AGE_BANDS = [
  { label: '0-90 天', min: 0, max: 90 },
  { label: '91-180 天', min: 90, max: 180 },
  { label: '181-365 天', min: 180, max: 365 },
  { label: '366-730 天', min: 365, max: 730 },
  { label: '730 天以上', min: 730, max: Infinity },
];

/** n below which a pool is flagged as a small sample. A tool convention, not a data fact. */
const SMALL_SAMPLE_N = 30;

const DEFAULTS = {
  newDays: 180,
  topBrands: 10,
  topProducts: 20,
  topKeywords: 15,
  keywordMinShare: 0.02,
  maxRows: 2000,
  titleTermLimit: 25,
  emergingMinCount: 2,
};

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

function timestamp() {
  const iso = new Date().toISOString();
  return { iso, stamp: iso.replace(/[-:]/g, '').replace('T', '_').slice(0, 15) };
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[\s_$()（）¥€£₩₹₽₺₴฿₫￥-]/g, '');
}

function cleanNum(value) {
  if (value === undefined || value === null || value === '') return 0;
  const normalized = String(value).replace(/[$,%，\s]/g, '').trim();
  if (normalized === '' || normalized === '-') return 0;
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

function cleanText(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
}

/** Thousands separator without relying on the ICU build of the local Node. */
function groupDigits(intString) {
  return intString.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function isNum(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function fmtNumber(value) {
  if (!isNum(value)) return 'n/a';
  const n = Number(value);
  return (n < 0 ? '-' : '') + groupDigits(String(Math.round(Math.abs(n))));
}

function fmtDecimal(value, decimals) {
  if (!isNum(value)) return 'n/a';
  const n = Number(value);
  const fixed = Math.abs(n).toFixed(decimals === undefined ? 1 : decimals);
  const parts = fixed.split('.');
  return (n < 0 ? '-' : '') + groupDigits(parts[0]) + (parts[1] ? `.${parts[1]}` : '');
}

function fmtMoney(value, currency) {
  if (!isNum(value)) return 'n/a';
  const n = Number(value);
  const abs = Math.abs(n);
  let body;
  if (abs >= 1000000) body = `${(n / 1000000).toFixed(2)}M`;
  else if (abs >= 10000) body = `${(n / 1000).toFixed(1)}K`;
  else body = fmtDecimal(n, 2);
  return currency ? `${currency}${body}` : body;
}

function fmtPct(value) {
  if (!isNum(value)) return 'n/a';
  return `${Number(value).toFixed(1)}%`;
}

/** Share of `part` in `whole`, in percent. null when either side is unusable. */
function ratioPct(part, whole) {
  if (!isNum(part) || !isNum(whole) || Number(whole) <= 0) return null;
  return (Number(part) / Number(whole)) * 100;
}

function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function mean(values) {
  const list = values.filter((v) => Number.isFinite(v));
  if (list.length === 0) return null;
  return list.reduce((sum, v) => sum + v, 0) / list.length;
}

/* ------------------------------------------------------------------ *
 * CSV parsing
 * ------------------------------------------------------------------ */

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
      if (c === '\r' && next === '\n') i++;
      currentRow.push(currentCell.trim());
      currentCell = '';
      if (currentRow.some((cell) => cell !== '')) rows.push(currentRow);
      currentRow = [];
      continue;
    }

    currentCell += c;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((cell) => cell !== '')) rows.push(currentRow);
  }

  return rows;
}

/**
 * Returns { headers, headerRowIndex, rows, rowsParsed, rowsSkipped }.
 * Exports often carry a banner above the header and a signature block below it;
 * rows that do not reach the header width are dropped and counted, never silently ignored.
 */
function loadCSV(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = parseCSV(content);

  const headerRowIndex = parsed.findIndex((row) =>
    row.some((cell) => String(cell).trim().toUpperCase() === 'ASIN')
  );

  if (headerRowIndex === -1) {
    throw new Error(
      '找不到表头：CSV 中没有包含 "ASIN" 列名的行。请确认这是商品维度的导出' +
      '（卖家精灵 / Seller Sprite 商品列表），或用 --map 指定列名映射。'
    );
  }

  const headers = parsed[headerRowIndex].map((header) => cleanText(header));
  const rows = [];
  let rowsSkipped = 0;

  for (let i = headerRowIndex + 1; i < parsed.length; i++) {
    const values = parsed[i];
    if (values.length === 0 || values.every((value) => value === '')) continue;
    if (values.length < headers.length) {
      rowsSkipped++;
      continue;
    }
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cleanText(values[index]);
    });
    if (row.ASIN === '') {
      rowsSkipped++;
      continue;
    }
    rows.push(row);
  }

  return { headers, headerRowIndex, rows, rowsParsed: parsed.length, rowsSkipped };
}

/* ------------------------------------------------------------------ *
 * Column resolution and availability
 * ------------------------------------------------------------------ */

function buildAliasIndex(extraMap) {
  const map = {};
  Object.keys(FIELD_ALIASES).forEach((field) => {
    map[field] = FIELD_ALIASES[field].slice();
  });
  if (extraMap && typeof extraMap === 'object') {
    Object.keys(extraMap).forEach((field) => {
      const extra = Array.isArray(extraMap[field]) ? extraMap[field] : [extraMap[field]];
      map[field] = (map[field] || []).concat(extra.filter((v) => typeof v === 'string'));
    });
  }
  return map;
}

/** Map each logical field to the actual header it matched, or null. */
function resolveColumns(headers, aliasIndex) {
  const columns = {};
  Object.keys(aliasIndex).forEach((field) => {
    const aliases = aliasIndex[field];
    let found = null;
    for (const alias of aliases) {
      if (headers.indexOf(alias) !== -1) {
        found = alias;
        break;
      }
    }
    if (!found) {
      const normalized = new Set(aliases.map(normalizeKey));
      for (const header of headers) {
        if (normalized.has(normalizeKey(header))) {
          found = header;
          break;
        }
      }
    }
    columns[field] = found;
  });
  return columns;
}

/** ok | empty-column | missing-column, with the count of non-empty cells. */
function computeAvailability(columns, rows) {
  const availability = {};
  Object.keys(columns).forEach((field) => {
    const column = columns[field];
    if (!column) {
      availability[field] = { column: null, status: 'missing-column', nonEmptyRows: 0 };
      return;
    }
    const nonEmptyRows = rows.reduce((count, row) => count + (row[column] !== '' ? 1 : 0), 0);
    availability[field] = {
      column,
      status: nonEmptyRows > 0 ? 'ok' : 'empty-column',
      nonEmptyRows,
    };
  });
  return availability;
}

const CURRENCY_SYMBOLS = ['$', '¥', '€', '£', '₩', '₹', '₽', '₺', '₴', '฿', '₫', '￥'];
const CURRENCY_CODES = {
  USD: '$', EUR: '€', JPY: '¥', GBP: '£', CNY: '¥', RMB: '¥',
  KRW: '₩', INR: '₹', CAD: 'C$', AUD: 'A$', MXN: 'MX$', BRL: 'R$', SEK: 'kr', PLN: 'zł',
};

/**
 * Currency is read from the header of the money column the export actually used
 * (月销售额($) -> "$"). It is never inferred from the marketplace or the file name.
 */
function detectCurrency(column) {
  if (!column) return { symbol: null, detectedFrom: null, ambiguous: false };
  const bracket = String(column).match(/[（(]\s*([^)）]+?)\s*[)）]/);
  const token = bracket ? bracket[1].trim() : '';
  if (!token) return { symbol: null, detectedFrom: null, ambiguous: false };
  if (CURRENCY_SYMBOLS.indexOf(token) !== -1) {
    return { symbol: token, detectedFrom: column, ambiguous: token === '¥' || token === '￥' };
  }
  const code = token.toUpperCase();
  if (CURRENCY_CODES[code]) {
    return {
      symbol: CURRENCY_CODES[code],
      detectedFrom: column,
      ambiguous: code === 'JPY' || code === 'CNY',
    };
  }
  return { symbol: null, detectedFrom: null, ambiguous: false };
}

/* ------------------------------------------------------------------ *
 * Aggregates
 *
 * Every helper takes `ctx` so it can refuse to compute from a column that
 * is missing or empty: it returns null instead of a zero.
 * ------------------------------------------------------------------ */

function makeContext(availability, currency) {
  const ok = (field) => Boolean(availability[field]) && availability[field].status === 'ok';
  return {
    currency,
    availability,
    ok,
    column: (field) => (availability[field] ? availability[field].column : null),
    sum(items, field) {
      if (!ok(field)) return null;
      return items.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
    },
    median(items, field, predicate) {
      if (!ok(field)) return null;
      const values = items
        .map((item) => item[field])
        .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
        .map(Number)
        .filter((v) => (predicate ? predicate(v) : true));
      return median(values);
    },
    mean(items, field, predicate) {
      if (!ok(field)) return null;
      const values = items
        .map((item) => item[field])
        .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
        .map(Number)
        .filter((v) => (predicate ? predicate(v) : true));
      return mean(values);
    },
    /** Number of rows that actually carry a value for this field. */
    present(items, field, predicate) {
      if (!ok(field)) return 0;
      return items
        .map((item) => item[field])
        .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
        .map(Number)
        .filter((v) => (predicate ? predicate(v) : true)).length;
    },
    count(items, field, predicate) {
      if (!ok(field)) return null;
      return items.filter((item) => item[field] !== null && predicate(Number(item[field]))).length;
    },
  };
}

function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function priceLabel(min, max, isLast, currency) {
  if (min === max) return fmtMoney(min, currency);
  return isLast
    ? `${fmtMoney(min, currency)}+`
    : `${fmtMoney(min, currency)}-${fmtMoney(max, currency)}`;
}

/** One row of a segment table. Money columns stay null when their source column is unusable. */
function segmentRow(label, items, ctx, extra) {
  const revenue = ctx.sum(items, 'revenue');
  const sales = ctx.sum(items, 'sales');
  const base = {
    label,
    skuCount: items.length,
    revenue: isNum(revenue) ? Math.round(revenue) : null,
    sales: isNum(sales) ? Math.round(sales) : null,
    avgRevenuePerSku: isNum(revenue) && items.length ? Math.round(revenue / items.length) : null,
    medianRevenue: ctx.median(items, 'revenue'),
    medianSales: ctx.median(items, 'sales'),
  };
  return Object.assign(base, extra || {});
}

/** Representative brands of a segment, ranked by revenue. Facts only — no positioning labels. */
function topBrandsOf(items, limit) {
  const map = {};
  items.forEach((item) => {
    const brand = item.brand || 'Unknown';
    if (!map[brand]) map[brand] = { brand, revenue: 0, skuCount: 0 };
    map[brand].revenue += item.revenue || 0;
    map[brand].skuCount += 1;
  });
  return Object.values(map)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit)
    .map((item) => ({ brand: item.brand, revenue: Math.round(item.revenue), skuCount: item.skuCount }));
}

function computePriceBands(skuList, ctx) {
  if (!ctx.ok('price')) return [];
  const priced = skuList.filter((item) => item.price > 0);
  if (priced.length === 0) return [];

  const prices = priced.map((item) => item.price);
  const minPrice = Math.min.apply(null, prices);
  const maxPrice = Math.max.apply(null, prices);

  if (minPrice === maxPrice) {
    return [segmentRow(priceLabel(minPrice, maxPrice, true, ctx.currency), priced, ctx, {
      min: minPrice,
      max: maxPrice,
      topBrands: topBrandsOf(priced, 3),
    })];
  }

  const bucketTarget = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(priced.length))));
  const step = niceStep((maxPrice - minPrice) / bucketTarget);
  const start = Math.floor(minPrice / step) * step;
  const end = Math.ceil(maxPrice / step) * step;
  const bucketCount = Math.max(1, Math.ceil((end - start) / step));

  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    min: start + index * step,
    max: index === bucketCount - 1 ? Infinity : start + (index + 1) * step,
    items: [],
  }));

  priced.forEach((item) => {
    const index = Math.min(buckets.length - 1, Math.max(0, Math.floor((item.price - start) / step)));
    buckets[index].items.push(item);
  });

  return buckets
    .filter((bucket) => bucket.items.length > 0)
    .map((bucket, index, list) =>
      segmentRow(
        priceLabel(bucket.min, bucket.max, index === list.length - 1, ctx.currency),
        bucket.items,
        ctx,
        {
          min: bucket.min,
          max: bucket.max === Infinity ? null : bucket.max,
          topBrands: topBrandsOf(bucket.items, 3),
        }
      )
    );
}

function computeListingAgeBands(skuList, ctx) {
  if (!ctx.ok('days')) {
    return { bands: [], skusWithAge: null, skusWithoutAge: null };
  }
  const known = skuList.filter((item) => item.days > 0);
  const bands = LISTING_AGE_BANDS.map((band) =>
    segmentRow(
      band.label,
      known.filter((item) => item.days > band.min && item.days <= band.max),
      ctx,
      { minDays: band.min === 0 ? null : band.min, maxDays: band.max === Infinity ? null : band.max }
    )
  );
  return {
    bands,
    skusWithAge: known.length,
    skusWithoutAge: skuList.length - known.length,
  };
}

function computeBrandShare(skuList, ctx) {
  const map = {};
  skuList.forEach((item) => {
    const brand = item.brand || 'Unknown';
    if (!map[brand]) map[brand] = { brand, revenue: 0, sales: 0, skuCount: 0, prices: [], days: [] };
    map[brand].revenue += item.revenue || 0;
    map[brand].sales += item.sales || 0;
    map[brand].skuCount += 1;
    if (item.price > 0) map[brand].prices.push(item.price);
    if (item.days > 0) map[brand].days.push(item.days);
  });

  const all = Object.values(map).sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = ctx.ok('revenue') ? all.reduce((sum, item) => sum + item.revenue, 0) : null;

  return {
    totalRevenue,
    brandCount: all.length,
    all: all.map((item) => ({
      brand: item.brand,
      revenue: ctx.ok('revenue') ? Math.round(item.revenue) : null,
      sales: ctx.ok('sales') ? Math.round(item.sales) : null,
      skuCount: item.skuCount,
      pct: ratioPct(item.revenue, totalRevenue),
      priceMin: ctx.ok('price') && item.prices.length ? Math.min.apply(null, item.prices) : null,
      priceMax: ctx.ok('price') && item.prices.length ? Math.max.apply(null, item.prices) : null,
      priceMedian: ctx.ok('price') ? median(item.prices) : null,
      medianDays: ctx.ok('days') ? median(item.days) : null,
    })),
  };
}

function computeKeywordFreq(skuList, ctx, stopWords, topKeywords, minShare) {
  const titled = ctx.ok('title') ? skuList.filter((item) => item.title) : [];
  const documentCount = titled.length;
  const counts = {};

  titled.forEach((item) => {
    const words = item.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 2 && !/^\d+$/.test(word) && !stopWords.has(word));
    const seen = new Set();
    words.forEach((word) => {
      if (!seen.has(word)) {
        seen.add(word);
        counts[word] = (counts[word] || 0) + 1;
      }
    });
  });

  const minCount = Math.max(1, Math.ceil(documentCount * minShare));
  const rows =
    documentCount === 0
      ? []
      : Object.entries(counts)
          .filter((entry) => entry[1] >= minCount)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, topKeywords)
          .map((entry) => ({
            keyword: entry[0],
            count: entry[1],
            pctOfTitles: ratioPct(entry[1], documentCount),
          }));

  return { rows, documentCount, minCount, distinctKeywords: Object.keys(counts).length };
}

/* ------------------------------------------------------------------ *
 * Title corpus: words, phrases, quantified parameters, emerging terms
 *
 * Extraction is purely structural (n-grams + numeric tokens). No category
 * vocabulary is hard-coded here: classifying terms into 功能 / 参数 / 场景 /
 * 人群 and turning them into selling points is the agent layer's job.
 * Counts are document frequencies — one title counts once per term.
 * ------------------------------------------------------------------ */

function tokenizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** "4d", "10 nodes", "3 heat" — carries both a digit and a letter. */
function isQuantified(token) {
  return /\d/.test(token) && /[a-z]/.test(token);
}

function isPureNumber(token) {
  return /^\d+$/.test(token);
}

function collectTitleTerms(titles, stopWords) {
  const words = {};
  const phrases = {};
  const quantified = {};
  const bump = (bag, term) => { bag[term] = (bag[term] || 0) + 1; };

  titles.forEach((title) => {
    const tokens = tokenizeTitle(title);
    const seenWords = new Set();
    const seenPhrases = new Set();
    const seenQuantified = new Set();

    tokens.forEach((token) => {
      if (stopWords.has(token) || isPureNumber(token)) return;
      if (token.length > 2) seenWords.add(token);
      if (isQuantified(token)) seenQuantified.add(token);
    });

    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];
      if (stopWords.has(a) || stopWords.has(b)) continue;
      if (isPureNumber(a) && isPureNumber(b)) continue;
      if (!isQuantified(a) && !isPureNumber(a) && a.length < 3) continue;
      if (!isQuantified(b) && !isPureNumber(b) && b.length < 3) continue;
      if (!isPureNumber(b)) {
        seenPhrases.add(a + ' ' + b);
        if (isQuantified(a + b)) seenQuantified.add(a + ' ' + b);
      }
      const c = tokens[i + 2];
      if (c !== undefined && !stopWords.has(c) && (isQuantified(c) || c.length >= 3)) {
        if (!isPureNumber(c)) {
          seenPhrases.add(a + ' ' + b + ' ' + c);
          if (isQuantified(a + b + c)) seenQuantified.add(a + ' ' + b + ' ' + c);
        }
      }
    }

    seenWords.forEach((term) => bump(words, term));
    seenPhrases.forEach((term) => bump(phrases, term));
    seenQuantified.forEach((term) => bump(quantified, term));
  });

  return { words, phrases, quantified, n: titles.length };
}

function rankTerms(bag, documentCount, minCount, limit) {
  if (documentCount === 0) return [];
  return Object.entries(bag)
    .filter((entry) => entry[1] >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map((entry) => ({
      term: entry[0],
      count: entry[1],
      n: documentCount,
      pct: ratioPct(entry[1], documentCount),
    }));
}

/**
 * corpora: { all: [title...], top: [...], new: [...] }
 * Returns per-corpus term tables plus the terms that are over-represented in the new pool.
 */
function computeTitleAnalysis(corpora, stopWords, options) {
  const limit = options.titleTermLimit;
  const result = {
    corpora: {},
    words: {},
    phrases: {},
    quantified: {},
    emerging: [],
    note: '短语由 n-gram 通用提取，未使用行业词表；功能/参数/场景/人群的分类与卖点提炼属 Agent 层。',
  };
  const bags = {};

  Object.keys(corpora).forEach((key) => {
    const titles = corpora[key].filter(Boolean);
    const stats = collectTitleTerms(titles, stopWords);
    bags[key] = stats;
    result.corpora[key] = { label: options.corpusLabels[key] || key, n: titles.length };
    const minCount = titles.length === 0
      ? 1
      : Math.max(1, Math.ceil(titles.length * options.keywordMinShare));
    result.words[key] = rankTerms(stats.words, titles.length, minCount, limit);
    result.phrases[key] = rankTerms(stats.phrases, titles.length, minCount, limit);
    result.quantified[key] = rankTerms(stats.quantified, titles.length, 1, limit);
  });

  const base = bags.all || { phrases: {}, n: 0 };
  const fresh = bags.new || { phrases: {}, n: 0 };
  if (base.n > 0 && fresh.n > 0) {
    result.emerging = Object.entries(fresh.phrases)
      .filter((entry) => entry[1] >= options.emergingMinCount)
      .map((entry) => {
        const newCount = entry[1];
        const allCount = base.phrases[entry[0]] || 0;
        const newPct = (newCount / fresh.n) * 100;
        const allPct = (allCount / base.n) * 100;
        return {
          term: entry[0],
          newCount,
          newN: fresh.n,
          newPct,
          allCount,
          allN: base.n,
          allPct,
          lift: allPct > 0 ? Number((newPct / allPct).toFixed(2)) : null,
        };
      })
      .sort((a, b) => b.newCount - a.newCount || (b.lift || 0) - (a.lift || 0))
      .slice(0, limit);
  }

  return result;
}

function summarizePool(items, ctx, totalRevenue) {
  const revenue = ctx.sum(items, 'revenue');
  const sales = ctx.sum(items, 'sales');
  return {
    n: items.length,
    revenue: isNum(revenue) ? Math.round(revenue) : null,
    sales: isNum(sales) ? Math.round(sales) : null,
    revenueSharePct: ratioPct(revenue, totalRevenue),
    medianRevenue: ctx.median(items, 'revenue'),
    medianSales: ctx.median(items, 'sales'),
    meanSales: ctx.mean(items, 'sales'),
    medianReviews: ctx.median(items, 'reviews'),
    medianRating: ctx.median(items, 'rating', (v) => v > 0),
    medianGrossMargin: ctx.median(items, 'grossMargin', (v) => v > 0),
    medianFbaFee: ctx.median(items, 'fbaFee', (v) => v > 0),
    presentGrossMargin: ctx.present(items, 'grossMargin', (v) => v > 0),
    presentFbaFee: ctx.present(items, 'fbaFee', (v) => v > 0),
    medianPrice: ctx.median(items, 'price', (v) => v > 0),
    medianDays: ctx.median(items, 'days', (v) => v > 0),
    smallSample: items.length > 0 && items.length < SMALL_SAMPLE_N,
  };
}

/** Badge share over all sampled rows. Empty cell counts as "no badge" only when the column is populated at all. */
function flagShare(items, ctx, field) {
  if (!ctx.ok(field)) {
    return {
      available: false,
      count: null,
      n: null,
      pct: null,
      column: ctx.column(field),
      reason: ctx.column(field) ? '整列为空' : 'CSV 无该列',
    };
  }
  const count = items.filter((item) => {
    const value = String(item[field] || '').trim();
    return value !== '' && !/^n(o)?$/i.test(value);
  }).length;
  return {
    available: true,
    count,
    n: items.length,
    pct: ratioPct(count, items.length),
    column: ctx.column(field),
    reason: null,
  };
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

function analyze(rows, headers, options) {
  const aliasIndex = buildAliasIndex(options.extraMap);
  const columns = resolveColumns(headers, aliasIndex);
  const availability = computeAvailability(columns, rows);
  const currencyInfo = detectCurrency(columns.revenue || columns.price);
  const currency = options.currency || currencyInfo.symbol || '';
  const currencySource = options.currency
    ? '--currency'
    : currencyInfo.detectedFrom
      ? `CSV 表头 ${currencyInfo.detectedFrom}`
      : '未识别（按无货币符号输出）';

  const ctx = makeContext(availability, currency);

  const skuList = rows.map((row) => {
    const item = {};
    Object.keys(aliasIndex).forEach((field) => {
      const column = columns[field];
      if (!column) {
        item[field] = NUMERIC_FIELDS.has(field) ? null : '';
        return;
      }
      const raw = row[column];
      item[field] = NUMERIC_FIELDS.has(field)
        ? (raw === '' ? null : cleanNum(raw))
        : cleanText(raw);
    });
    item.brand = item.brand || 'Unknown';
    item.revenuePerUnit =
      item.sales !== null && item.sales > 0 && item.revenue !== null
        ? item.revenue / item.sales
        : null;
    return item;
  });

  const totalRevenue = ctx.sum(skuList, 'revenue');
  const totalSales = ctx.sum(skuList, 'sales');
  const priced = ctx.ok('price') ? skuList.filter((item) => item.price > 0) : [];
  const withSales = ctx.ok('sales') ? skuList.filter((item) => item.sales > 0) : null;

  const market = {
    totalSkus: skuList.length,
    pricedSkus: ctx.ok('price') ? priced.length : null,
    skusWithSales: withSales ? withSales.length : null,
    skusWithoutSales: withSales ? skuList.length - withSales.length : null,
    totalRevenue: isNum(totalRevenue) ? Math.round(totalRevenue) : null,
    totalSales: isNum(totalSales) ? Math.round(totalSales) : null,
    /** 算术平均标价：分母 = 有价格的 SKU 数（非销量加权）。 */
    avgListPrice: priced.length
      ? Number((priced.reduce((sum, item) => sum + item.price, 0) / priced.length).toFixed(2))
      : null,
    avgListPriceDenominator: priced.length || null,
    medianListPrice: ctx.median(skuList, 'price', (v) => v > 0),
    /** 件均销售额：分母 = 月销量合计。销量加权口径，与 avgListPrice 不可混用。 */
    revenuePerUnit:
      isNum(totalRevenue) && isNum(totalSales) && totalSales > 0
        ? Number((totalRevenue / totalSales).toFixed(2))
        : null,
    revenuePerUnitDenominator: isNum(totalSales) ? Math.round(totalSales) : null,
    avgRevenuePerSku:
      isNum(totalRevenue) && skuList.length ? Math.round(totalRevenue / skuList.length) : null,
    currency: currency || null,
    currencySource,
    currencyAmbiguous: Boolean(currencyInfo.ambiguous) && !options.currency,
  };

  const topProducts = skuList
    .slice()
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
    .slice(0, options.topProducts);

  const recentProducts = ctx.ok('days')
    ? skuList
        .filter((item) => item.days > 0 && item.days <= options.newDays)
        .sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
    : [];

  const brandData = computeBrandShare(skuList, ctx);
  const topBrands = brandData.all.slice(0, options.topBrands);
  const crOf = (n) =>
    ratioPct(
      brandData.all.slice(0, n).reduce((sum, item) => sum + (item.revenue || 0), 0),
      brandData.totalRevenue
    );

  const recentPoolSummary = summarizePool(recentProducts, ctx, totalRevenue);
  const establishedPool = ctx.ok('days') ? skuList.filter((item) => item.days > options.newDays) : [];
  const unknownAgePool = ctx.ok('days') ? skuList.filter((item) => item.days <= 0) : [];

  const keywordData = computeKeywordFreq(
    skuList,
    ctx,
    options.stopWords,
    options.topKeywords,
    options.keywordMinShare
  );

  const priceBands = computePriceBands(skuList, ctx);
  const titleAnalysis = ctx.ok('title')
    ? computeTitleAnalysis(
        {
          all: skuList.map((item) => item.title),
          top: topProducts.map((item) => item.title),
          new: recentProducts.map((item) => item.title),
        },
        options.stopWords,
        Object.assign({}, options, {
          corpusLabels: {
            all: '全样本',
            top: 'TOP' + options.topProducts + ' 销售额',
            new: '上架 ≤' + options.newDays + ' 天',
          },
        })
      )
    : { corpora: {}, words: {}, phrases: {}, quantified: {}, emerging: [], note: '标题列不可用' };
  const topRevenueSum = topProducts.reduce((sum, item) => sum + (item.revenue || 0), 0);

  const riskSignals = {
    concentration: {
      brandCount: brandData.brandCount,
      cr3Pct: crOf(3),
      cr5Pct: crOf(5),
      cr10Pct: crOf(10),
      denominator: '样本内「月销售额」合计',
      denominatorRevenue: isNum(brandData.totalRevenue) ? Math.round(brandData.totalRevenue) : null,
      topNRevenueSharePct: ratioPct(topRevenueSum, brandData.totalRevenue),
      topN: options.topProducts,
    },
    barriers: {
      medianReviewsAll: {
        value: ctx.median(skuList, 'reviews'),
        n: ctx.ok('reviews') ? skuList.length : 0,
      },
      medianReviewsTopN: {
        value: ctx.median(topProducts, 'reviews'),
        n: ctx.ok('reviews') ? topProducts.length : 0,
        topN: options.topProducts,
      },
      medianRating: {
        value: ctx.median(skuList, 'rating', (v) => v > 0),
        n: ctx.count(skuList, 'rating', (v) => v > 0) || 0,
      },
      badges: FLAG_FIELDS.reduce((acc, field) => {
        acc[field] = flagShare(skuList, ctx, field);
        return acc;
      }, {}),
    },
    newEntrants: recentPoolSummary,
    established: summarizePool(establishedPool, ctx, totalRevenue),
    unknownAge: {
      n: unknownAgePool.length,
      revenue: isNum(ctx.sum(unknownAgePool, 'revenue'))
        ? Math.round(ctx.sum(unknownAgePool, 'revenue'))
        : null,
    },
    /** Checks the risk layer requires that a single snapshot cannot answer. */
    notComputableFromSnapshot: [
      '新品评论增长速度（需要 ≥2 个时间点的评分数）',
      '上架 90 天后仍有销量的新品占比（需要 ≥2 个时间点的销量）',
      '低评分新品淘汰率（需要下架/在售状态的历史快照）',
      'TOP10 品牌份额是否持续升高（需要多期品牌份额）',
      'YOY / 季节性 / 未来预测（需要多期销量或外部趋势源）',
      '评论区是否提及某功能（需要评论正文，CSV 只有评分数与评分）',
    ],
  };

  const fieldsMissing = Object.keys(availability).filter((f) => availability[f].status === 'missing-column');
  const fieldsEmpty = Object.keys(availability).filter((f) => availability[f].status === 'empty-column');

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedAtTimezone: 'UTC',
    options: {
      newDays: options.newDays,
      topBrands: options.topBrands,
      topProducts: options.topProducts,
      topKeywords: options.topKeywords,
      keywordMinShare: options.keywordMinShare,
      maxRows: options.maxRows,
      smallSampleN: SMALL_SAMPLE_N,
      blankNumericCellsTreatedAs: 0,
    },
    source: {
      fileName: options.sourceFileName,
      filePath: options.sourceFilePath,
      bytes: options.sourceBytes,
      modifiedAt: options.sourceModifiedAt,
      headerRowIndex: options.headerRowIndex,
      headerColumns: options.headerColumns,
      rowsParsed: options.rowsParsed,
      rowsKept: skuList.length,
      rowsSkipped: options.rowsSkipped,
      columnsUsed: Object.keys(columns).reduce((acc, field) => {
        if (columns[field]) acc[field] = columns[field];
        return acc;
      }, {}),
      availability,
      fieldsMissing,
      fieldsEmpty,
      currency: {
        symbol: currency || null,
        source: currencySource,
        ambiguous: market.currencyAmbiguous,
      },
    },
    market,
    priceBands,
    listingAge: computeListingAgeBands(skuList, ctx),
    brandShare: topBrands,
    keywordFreq: keywordData.rows,
    titleAnalysis,
    keywordStats: {
      documentCount: keywordData.documentCount,
      minCount: keywordData.minCount,
      distinctKeywords: keywordData.distinctKeywords,
      stopWordCount: options.stopWords.size,
      stopWordSource: options.stopWordsSource,
    },
    topProducts,
    recentProducts,
    recentPool: recentPoolSummary,
    riskSignals,
    titleCorpus: {
      topTitles: ctx.ok('title') ? topProducts.map((item) => item.title).filter(Boolean) : [],
      recentTitles: ctx.ok('title') ? recentProducts.map((item) => item.title).filter(Boolean) : [],
      priceBandSampleTitles: priceBands.map((band) => {
        const inBand = skuList
          .filter(
            (item) =>
              item.price > 0 &&
              item.price >= band.min &&
              (band.max === null || item.price < band.max)
          )
          .sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
        return {
          label: band.label,
          titles: inBand.slice(0, 3).map((item) => item.title).filter(Boolean),
        };
      }),
    },
    skuTable: {
      columns: SKU_TABLE_FIELDS,
      rowOrder: 'CSV 原始行序（未排序）',
      included: Math.min(skuList.length, options.maxRows),
      total: skuList.length,
      truncated: skuList.length > options.maxRows,
      rows: skuList.slice(0, options.maxRows).map((item) => {
        const out = {};
        SKU_TABLE_FIELDS.forEach((field) => {
          out[field] = item[field] === undefined ? null : item[field];
        });
        return out;
      }),
    },
    caveats: buildCaveats({
      options,
      market,
      recentPool: recentPoolSummary,
      keywordData,
      currencyInfo,
      rowsSkipped: options.rowsSkipped,
      fieldsMissing,
      fieldsEmpty,
      availability,
    }),
  };
}

function buildCaveats(input) {
  const caveats = [];
  const options = input.options;
  const market = input.market;
  const recentPool = input.recentPool;
  const keywordData = input.keywordData;
  const currencyInfo = input.currencyInfo;

  caveats.push(
    '月销量 / 月销售额 直接取自 CSV 的「月销量」「月销售额」列（导出工具口径），本脚本未做任何换算；' +
      '报告中引用时必须标注该来源，不要表述为 Amazon 后台实际成交数据。'
  );

  if (market.totalSkus === 0) {
    caveats.push('CSV 中没有可用商品行，所有指标不可计算。');
    return caveats;
  }

  if (market.skusWithoutSales !== null && market.skusWithoutSales > 0) {
    caveats.push(
      `样本中有 ${market.skusWithoutSales} / ${market.totalSkus} 个 SKU 的月销量为 0 或空值，` +
        '它们计入 SKU 数但不贡献销售额；件均销售额的分母是月销量合计，不是 SKU 数。'
    );
  }

  caveats.push(
    '数值列的空白单元格记为 null（未知）：求和时按 0 计，取中位数/均值时剔除，'
    + '因此各指标的有效样本量可能小于 SKU 数，报告引用时必须带各自的 n。'
  );

  if (recentPool.n === 0) {
    caveats.push(
      `样本中没有「上架 ≤ ${options.newDays} 天且上架天数 > 0」的 SKU（或上架天数列不可用），` +
        '新品池为空，任何新品结论都缺乏样本支持。'
    );
  } else if (recentPool.smallSample) {
    caveats.push(
      `新品池样本量 n=${recentPool.n}（< ${SMALL_SAMPLE_N}），属于小样本；` +
        '基于该池的中位数/占比只能作为线索，不能当作类目规律。'
    );
  }

  if (keywordData.documentCount === 0) {
    caveats.push('没有可用标题，标题语料层为空。');
  } else if (keywordData.minCount <= 1) {
    caveats.push(
      `关键词频次阈值为 1（样本仅 ${keywordData.documentCount} 条标题），等于未做频次过滤，` +
        '低频词也会进入列表。'
    );
  }

  if (currencyInfo.ambiguous && !options.currency) {
    caveats.push('货币符号为 ¥，无法从表头区分 JPY / CNY，必须结合站点确认后再解读金额。');
  } else if (!currencyInfo.symbol && !options.currency) {
    caveats.push('未能从表头识别货币符号，金额不带货币单位；如需标注请用 --currency 指定。');
  }

  if (input.rowsSkipped > 0) {
    caveats.push(
      `有 ${input.rowsSkipped} 行因列数不足表头宽度被跳过（通常是导出文件的说明头或签名尾），未计入样本。`
    );
  }

  if (input.fieldsMissing.length > 0) {
    caveats.push(`CSV 中找不到以下字段对应的列，相关指标一律为 n/a：${input.fieldsMissing.join('、')}。`);
  }

  if (input.fieldsEmpty.length > 0) {
    const detail = input.fieldsEmpty
      .map((field) => `${field}（列名「${input.availability[field].column}」）`)
      .join('、');
    caveats.push(
      `以下列存在但整列为空（导出未填充）：${detail}。相关指标输出 n/a。` +
        '特别注意：徽章类字段整列为空时不得解读为「0% 占比」。'
    );
  }

  caveats.push(
    '本文件是单期快照（single snapshot）：所有数值只描述导出时点的状态，不含历史序列，' +
      '因此不支持 YOY、季节性、份额趋势、淘汰率等需要多期数据的判断。'
  );

  return caveats;
}

/* ------------------------------------------------------------------ *
 * Markdown digest
 * ------------------------------------------------------------------ */

function mdTable(headers, rows) {
  if (!rows || rows.length === 0) return '_无数据_\n';
  let md = `| ${headers.join(' | ')} |\n`;
  md += `| ${headers.map((_, index) => (index === 0 ? '---' : '---:')).join(' | ')} |\n`;
  rows.forEach((row) => {
    md += `| ${row.join(' | ')} |\n`;
  });
  return md;
}

function writeMarkdown(facts) {
  const cur = facts.market.currency || '';
  const money = (v) => fmtMoney(v, cur);
  const pct = (v) => fmtPct(v);
  const rp = facts.recentPool;

  let md = '# 事实层摘要（脚本输出，不含结论）\n\n';
  md += `- 生成时间：${facts.generatedAt}（UTC）\n`;
  md += `- 源文件：${facts.source.fileName}\n`;
  md += `- 样本：${fmtNumber(facts.source.rowsKept)} 个 SKU`
    + `（解析 ${fmtNumber(facts.source.rowsParsed)} 行，跳过 ${fmtNumber(facts.source.rowsSkipped)} 行）\n`;
  md += `- 货币：${facts.market.currency || '未识别'}（来源：${facts.market.currencySource}）\n`;
  md += `- 口径参数：新品窗口 ${facts.options.newDays} 天；TOP 品牌 ${facts.options.topBrands}；`
    + `TOP 商品 ${facts.options.topProducts}；关键词阈值 ${(facts.options.keywordMinShare * 100).toFixed(1)}%\n`;
  md += '\n> n/a = 该指标的分母无效或源列不可用（缺列 / 整列为空），**不等于 0**。\n\n';

  md += '## 1. 市场规模（单期快照）\n\n';
  md += mdTable(
    ['指标', '数值', '口径 / 分母'],
    [
      ['SKU 数', fmtNumber(facts.market.totalSkus), 'CSV 中保留的商品行'],
      ['有价格的 SKU 数', fmtNumber(facts.market.pricedSkus), '价格 > 0'],
      ['月销售额', money(facts.market.totalRevenue), `「${facts.source.columnsUsed.revenue || '月销售额'}」列求和，导出工具口径`],
      ['月销量', fmtNumber(facts.market.totalSales), `「${facts.source.columnsUsed.sales || '月销量'}」列求和，导出工具口径`],
      ['算术平均标价', money(facts.market.avgListPrice), isNum(facts.market.avgListPriceDenominator) ? `分母 = ${fmtNumber(facts.market.avgListPriceDenominator)} 个有价格的 SKU（未按销量加权）` : 'n/a'],
      ['标价中位数', money(facts.market.medianListPrice), isNum(facts.market.avgListPriceDenominator) ? `分母 = ${fmtNumber(facts.market.avgListPriceDenominator)} 个有价格的 SKU` : 'n/a'],
      ['件均销售额', money(facts.market.revenuePerUnit), isNum(facts.market.revenuePerUnitDenominator) ? `分母 = 月销量合计 ${fmtNumber(facts.market.revenuePerUnitDenominator)}` : 'n/a'],
      ['单 SKU 平均销售额', money(facts.market.avgRevenuePerSku), `分母 = ${fmtNumber(facts.market.totalSkus)} 个 SKU`],
      ['月销量为 0 / 空', fmtNumber(facts.market.skusWithoutSales), isNum(facts.market.skusWithoutSales) ? `占样本 ${pct(ratioPct(facts.market.skusWithoutSales, facts.market.totalSkus))}` : 'n/a'],
    ]
  );

  md += '\n## 2. 价格带\n\n';
  md += mdTable(
    ['价格带', 'SKU 数', '月销量', '月销售额', '单 SKU 平均销售额', '销售额中位数'],
    facts.priceBands.map((band) => [
      band.label,
      fmtNumber(band.skuCount),
      fmtNumber(band.sales),
      money(band.revenue),
      money(band.avgRevenuePerSku),
      money(band.medianRevenue),
    ])
  );

  md += '\n## 3. 上架时长结构\n\n';
  md += mdTable(
    ['上架时长', 'SKU 数', '月销量', '月销售额', '单 SKU 平均销售额'],
    facts.listingAge.bands.map((band) => [
      band.label,
      fmtNumber(band.skuCount),
      fmtNumber(band.sales),
      money(band.revenue),
      money(band.avgRevenuePerSku),
    ])
  );
  md += `\n- 有上架天数的 SKU：${fmtNumber(facts.listingAge.skusWithAge)}；`
    + `上架天数为 0 或空：${fmtNumber(facts.listingAge.skusWithoutAge)}\n`;

  md += '\n## 4. 品牌格局\n\n';
  md += mdTable(
    ['品牌', 'SKU 数', '月销量', '月销售额', '销售额占比'],
    facts.brandShare.map((brand) => [
      brand.brand,
      fmtNumber(brand.skuCount),
      fmtNumber(brand.sales),
      money(brand.revenue),
      pct(brand.pct),
    ])
  );
  md += `\n- 样本品牌数：${fmtNumber(facts.riskSignals.concentration.brandCount)}`
    + `；CR3 ${pct(facts.riskSignals.concentration.cr3Pct)}`
    + `，CR5 ${pct(facts.riskSignals.concentration.cr5Pct)}`
    + `，CR10 ${pct(facts.riskSignals.concentration.cr10Pct)}`
    + `（分母：样本内月销售额合计 ${money(facts.riskSignals.concentration.denominatorRevenue)}）\n`;

  md += '\n## 5. 标题关键词频次\n\n';
  md += mdTable(
    ['关键词', '出现标题数', '占有标题 SKU 的比例'],
    facts.keywordFreq.map((item) => [item.keyword, fmtNumber(item.count), pct(item.pctOfTitles)])
  );
  md += `\n- 统计口径：每个标题内去重计数；分母 = ${fmtNumber(facts.keywordStats.documentCount)} 条有标题的 SKU；`
    + `入选阈值 = 出现 ≥ ${fmtNumber(facts.keywordStats.minCount)} 次；`
    + `停用词 ${fmtNumber(facts.keywordStats.stopWordCount)} 个（${facts.keywordStats.stopWordSource}）\n`;

  const termRows = (rows) => (rows || []).map((x) => [x.term, `${fmtNumber(x.count)} / ${fmtNumber(x.n)}`, fmtPct(x.pct)]);
  const ta = facts.titleAnalysis || { corpora: {}, words: {}, phrases: {}, quantified: {}, emerging: [] };

  md += '\n### 5.1 标题词与短语（按语料分组）\n\n';
  ['all', 'top', 'new'].forEach((key) => {
    const corpus = ta.corpora[key];
    if (!corpus) return;
    md += `**${corpus.label}（n = ${fmtNumber(corpus.n)} 条标题）**\n\n`;
    md += mdTable(['单词', '出现标题数 / 总数', '占比'], termRows(ta.words[key]));
    md += mdTable(['短语（2-3 词）', '出现标题数 / 总数', '占比'], termRows(ta.phrases[key]));
    md += mdTable(['量化参数短语', '出现标题数 / 总数', '占比'], termRows(ta.quantified[key]));
  });

  md += '\n### 5.2 新品池相对全样本的高频短语（可能的卖点方向）\n\n';
  md += mdTable(
    ['短语', '新品池', '全样本', '倍数'],
    (ta.emerging || []).map((x) => [
      x.term,
      `${fmtNumber(x.newCount)} / ${fmtNumber(x.newN)}`,
      `${fmtNumber(x.allCount)} / ${fmtNumber(x.allN)}`,
      x.lift === null ? 'n/a（全样本为 0）' : `${x.lift}×`,
    ])
  );
  md += `\n> ${ta.note || ''}\n`;

  md += '\n## 6. 新品池（脚本口径）\n\n';
  md += mdTable(
    ['指标', '数值', '分母'],
    [
      [`上架 ≤ ${facts.options.newDays} 天的 SKU 数`, fmtNumber(rp.n), `占样本 SKU 的 ${pct(ratioPct(rp.n, facts.market.totalSkus))}`],
      ['月销量中位数', fmtNumber(rp.medianSales), `n = ${fmtNumber(rp.n)}`],
      ['月销量均值', fmtDecimal(rp.meanSales, 1), `n = ${fmtNumber(rp.n)}`],
      ['月销售额中位数', money(rp.medianRevenue), `n = ${fmtNumber(rp.n)}`],
      ['月销售额合计', money(rp.revenue), isNum(rp.revenueSharePct) ? `占样本销售额 ${pct(rp.revenueSharePct)}` : 'n/a'],
      ['评分数中位数', fmtNumber(rp.medianReviews), `n = ${fmtNumber(rp.n)}`],
      ['评分中位数', fmtDecimal(rp.medianRating, 2), `n = ${fmtNumber(rp.n)}`],
      ['标价中位数', money(rp.medianPrice), `n = ${fmtNumber(rp.n)}`],
      ['上架天数中位数', fmtNumber(rp.medianDays), `n = ${fmtNumber(rp.n)}`],
      ['小样本标记', rp.n === 0 ? 'n/a（池为空）' : rp.smallSample ? `是（n < ${SMALL_SAMPLE_N}）` : '否', `阈值 n = ${SMALL_SAMPLE_N}（工具约定）`],
    ]
  );

  md += '\n## 7. 风险验证可用信号（单期快照可算部分）\n\n';
  const b = facts.riskSignals.barriers;
  const badgeRows = FLAG_FIELDS.map((field) => {
    const flag = b.badges[field];
    const label = `${field}（${flag.column || '列缺失'}）`;
    if (!flag.available) {
      return [label, 'n/a', `n/a — ${flag.reason}`];
    }
    return [label, `${fmtNumber(flag.count)} / ${fmtNumber(flag.n)} = ${pct(flag.pct)}`, '样本 SKU'];
  });
  md += mdTable(
    ['信号', '数值', '分母'],
    [
      ['评分数中位数（全样本）', fmtNumber(b.medianReviewsAll.value), `n = ${fmtNumber(b.medianReviewsAll.n)}`],
      [`评分数中位数（TOP${b.medianReviewsTopN.topN}）`, fmtNumber(b.medianReviewsTopN.value), `n = ${fmtNumber(b.medianReviewsTopN.n)}`],
      [`TOP${facts.riskSignals.concentration.topN} 销售额占比`, pct(facts.riskSignals.concentration.topNRevenueSharePct), '分母：样本月销售额'],
      ['评分中位数', fmtDecimal(b.medianRating.value, 2), `n = ${fmtNumber(b.medianRating.n)} 个有评分的 SKU`],
    ].concat(badgeRows)
  );
  md += '\n**单期快照无法计算的验证项（需补充数据源，不得推断）：**\n';
  facts.riskSignals.notComputableFromSnapshot.forEach((item) => {
    md += `- ${item}\n`;
  });

  md += '\n## 8. 数据质量与口径提示\n\n';
  facts.caveats.forEach((item) => {
    md += `- ${item}\n`;
  });

  md += '\n## 9. 字段映射（可追溯）\n\n';
  md += mdTable(
    ['逻辑字段', 'CSV 列', '状态', '非空行数'],
    Object.keys(facts.source.availability).map((field) => {
      const info = facts.source.availability[field];
      const status = info.status === 'ok' ? '可用' : info.status === 'empty-column' ? '整列为空' : '缺列';
      return [field, info.column || '—', status, info.column ? fmtNumber(info.nonEmptyRows) : '—'];
    })
  );

  md += '\n## 10. 标题语料（供模型层推理，脚本不解读）\n\n';
  md += '### TOP 销售额标题\n';
  if (facts.titleCorpus.topTitles.length === 0) md += '- （无标题语料）\n';
  facts.titleCorpus.topTitles.slice(0, 10).forEach((title) => {
    md += `- ${title}\n`;
  });
  md += '\n### 新品标题\n';
  if (facts.titleCorpus.recentTitles.length === 0) md += '- （新品池为空）\n';
  facts.titleCorpus.recentTitles.slice(0, 10).forEach((title) => {
    md += `- ${title}\n`;
  });
  md += '\n### 各价格带样本标题\n';
  if (facts.titleCorpus.priceBandSampleTitles.length === 0) md += '- （无价格带数据）\n';
  facts.titleCorpus.priceBandSampleTitles.forEach((band) => {
    md += `\n**${band.label}**\n`;
    if (band.titles.length === 0) md += '- （无标题）\n';
    band.titles.forEach((title) => {
      md += `- ${title}\n`;
    });
  });

  md += '\n---\n\n';
  md += `本文件由 scripts/analyze.js（schema ${facts.schemaVersion}）自动生成。`
    + '仅包含 CSV 中可计算的事实；n/a 不等于 0。'
    + '趋势、季节性、YOY、未来预测不在本文件范围内。\n';

  return md;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = Object.assign({}, DEFAULTS, {
    extraMap: null,
    currency: null,
    stopwordsFile: null,
    out: null,
  });
  const positional = [];

  const readValue = (index, flag) => {
    const value = argv[index];
    if (value === undefined || value.indexOf('--') === 0) throw new Error(`${flag} 需要一个值`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--quiet') { options.quiet = true; continue; }
    if (arg === '--out') { options.out = readValue(++i, arg); continue; }
    if (arg === '--map') { options.mapFile = readValue(++i, arg); continue; }
    if (arg === '--currency') { options.currency = readValue(++i, arg); continue; }
    if (arg === '--stopwords') { options.stopwordsFile = readValue(++i, arg); continue; }
    if (arg === '--new-days') { options.newDays = Number(readValue(++i, arg)); continue; }
    if (arg === '--top-brands') { options.topBrands = Number(readValue(++i, arg)); continue; }
    if (arg === '--top-products') { options.topProducts = Number(readValue(++i, arg)); continue; }
    if (arg === '--top-keywords') { options.topKeywords = Number(readValue(++i, arg)); continue; }
    if (arg === '--keyword-min-share') { options.keywordMinShare = Number(readValue(++i, arg)); continue; }
    if (arg === '--max-rows') { options.maxRows = Number(readValue(++i, arg)); continue; }
    if (arg === '--title-terms') { options.titleTermLimit = Number(readValue(++i, arg)); continue; }
    if (arg === '--emerging-min') { options.emergingMinCount = Number(readValue(++i, arg)); continue; }
    if (arg.indexOf('--') === 0) throw new Error(`未知参数：${arg}`);
    positional.push(arg);
  }

  return { options, positional };
}

function validateOptions(options) {
  ['newDays', 'topBrands', 'topProducts', 'topKeywords', 'maxRows', 'titleTermLimit', 'emergingMinCount'].forEach((key) => {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} 必须是正数`);
    }
    options[key] = Math.floor(options[key]);
  });
  if (!Number.isFinite(options.keywordMinShare) || options.keywordMinShare < 0 || options.keywordMinShare > 1) {
    throw new Error('--keyword-min-share 必须在 0 到 1 之间');
  }
}

function loadStopWords(file) {
  const set = new Set(GENERIC_STOP_WORDS);
  let source = `内置英文停用词表，仅覆盖英文，可用 --stopwords 追加`;
  if (file) {
    const extra = fs
      .readFileSync(path.resolve(file), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && line.indexOf('#') !== 0);
    extra.forEach((word) => set.add(word));
    source = `内置英文停用词表 + ${path.basename(file)}`;
  }
  return { set, source };
}

const HELP = `用法：node scripts/analyze.js <csv-path> [options]

从商品维度 CSV（卖家精灵 / Seller Sprite 导出）提取事实层，输出：
  <out>/data/<csv名>_<UTC时间戳>_facts.json
  <out>/reports/<csv名>_<UTC时间戳>_facts.md
  <out>/reports/latest_facts.md

参数：
  --out <dir>              输出根目录，默认 scripts/ 的上一级
  --map <file.json>        追加列名别名，如 {"revenue":["Umsatz"]}
  --currency <text>        强制货币标注，默认从 CSV 表头括号中识别
  --new-days <n>           新品窗口天数，默认 ${DEFAULTS.newDays}
  --top-brands <n>         品牌行数，默认 ${DEFAULTS.topBrands}
  --top-products <n>       商品行数，默认 ${DEFAULTS.topProducts}
  --top-keywords <n>       关键词行数，默认 ${DEFAULTS.topKeywords}
  --keyword-min-share <f>  关键词最低出现比例，默认 ${DEFAULTS.keywordMinShare}
  --stopwords <file>       追加停用词文件（每行一个，# 开头为注释）
  --max-rows <n>           facts.skuTable 最多内嵌行数，默认 ${DEFAULTS.maxRows}
  --quiet                  不打印摘要
  --help

说明：脚本只做 CSV 中可计算的事实，不生成结论、不做估算。
      缺列或整列为空 => 指标输出 n/a，绝不输出 0。`;

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const options = parsed.options;
  const positional = parsed.positional;

  if (options.help) {
    console.log(HELP);
    return;
  }

  if (positional.length === 0) {
    console.error(HELP);
    process.exit(1);
  }

  validateOptions(options);

  const csvPath = path.resolve(positional[0]);
  if (!fs.existsSync(csvPath)) {
    console.error(`找不到 CSV：${csvPath}`);
    process.exit(1);
  }

  const outRoot = options.out ? path.resolve(options.out) : DEFAULT_OUT_ROOT;
  const dataDir = path.join(outRoot, 'data');
  const reportsDir = path.join(outRoot, 'reports');

  if (options.mapFile) {
    const mapPath = path.resolve(options.mapFile);
    if (!fs.existsSync(mapPath)) {
      console.error(`找不到映射文件：${mapPath}`);
      process.exit(1);
    }
    options.extraMap = JSON.parse(fs.readFileSync(mapPath, 'utf8').replace(/^\uFEFF/, ''));
  }

  const stopWords = loadStopWords(options.stopwordsFile);
  options.stopWords = stopWords.set;
  options.stopWordsSource = stopWords.source;

  const stat = fs.statSync(csvPath);
  const loaded = loadCSV(csvPath);

  const facts = analyze(loaded.rows, loaded.headers, Object.assign({}, options, {
    sourceFileName: path.basename(csvPath),
    sourceFilePath: csvPath,
    sourceBytes: stat.size,
    sourceModifiedAt: stat.mtime.toISOString(),
    headerRowIndex: loaded.headerRowIndex,
    headerColumns: loaded.headers.length,
    rowsParsed: loaded.rowsParsed,
    rowsSkipped: loaded.rowsSkipped,
  }));

  if (facts.market.totalSkus === 0) {
    console.error('警告：CSV 中没有解析到商品行；输出仍会生成，但全部指标为 n/a。');
  }

  const markdown = writeMarkdown(facts);
  const stamp = timestamp().stamp;
  const base = path.basename(csvPath, path.extname(csvPath));

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  const jsonPath = path.join(dataDir, `${base}_${stamp}_facts.json`);
  const mdPath = path.join(reportsDir, `${base}_${stamp}_facts.md`);
  const latestMdPath = path.join(reportsDir, 'latest_facts.md');

  fs.writeFileSync(jsonPath, JSON.stringify(facts, null, 2), 'utf8');
  fs.writeFileSync(mdPath, markdown, 'utf8');
  fs.writeFileSync(latestMdPath, markdown, 'utf8');

  if (!options.quiet) {
    console.log(`facts.json : ${jsonPath}`);
    console.log(`facts.md   : ${mdPath}`);
    console.log(`latest     : ${latestMdPath}`);
    console.log(
      `样本 ${facts.source.rowsKept} 个 SKU | 月销售额 ${fmtMoney(facts.market.totalRevenue, facts.market.currency || '')}`
        + ` | 月销量 ${fmtNumber(facts.market.totalSales)} | 货币 ${facts.market.currency || '未识别'}`
        + ` | 生成于 ${facts.generatedAt}`
    );
    if (facts.source.fieldsEmpty.length > 0) {
      console.log(`整列为空：${facts.source.fieldsEmpty.join('、')}`);
    }
    if (facts.source.fieldsMissing.length > 0) {
      console.log(`缺列：${facts.source.fieldsMissing.join('、')}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Amazon competitor research — HTML renderer.
 *
 *   report.md  (+ facts.json, optional trend_context.json)  ->  report.html
 *
 * Contract:
 *   - Output is a single self-contained HTML file: inline CSS, inline SVG charts,
 *     no external fonts, no CDN, no network, no runtime beyond Node.
 *   - Every chart is computed from the provided JSON files. When a series is absent
 *     the chart area states what is missing — it never renders a placeholder chart
 *     and never invents a value.
 *   - The renderer writes no conclusions. Chart notes restate figures taken from the
 *     JSON, with the source file, metric and n in the caption.
 *
 * Usage:
 *   node scripts/gen-html.js <report.md> [report.html] [options]
 *
 * Options:
 *   --facts <facts.json>     facts layer file (default: newest *_facts.json in <out>/data)
 *   --trend <trend.json>     trend context file (optional)
 *   --title <text>           document title (default: first H1 of the markdown)
 *   --out <dir>              output root used to locate data/ (default: scripts/..)
 *   --no-charts              skip the appendix charts entirely
 *   --quiet
 *   --help
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const DEFAULT_OUT_ROOT = path.resolve(SCRIPT_DIR, '..');

const CHART_COLORS = [
  '#2563eb', '#f97316', '#16a34a', '#dc2626', '#7c3aed',
  '#0891b2', '#ca8a04', '#be185d', '#4f46e5', '#059669',
];

/* ------------------------------------------------------------------ *
 * Basic helpers
 * ------------------------------------------------------------------ */

function escapeHtml(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isNum(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function groupDigits(intString) {
  return intString.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** K/M abbreviations, for money and other amounts where a short form helps. */
function fmtNumCompact(value, decimals) {
  if (!isNum(value)) return 'n/a';
  const n = Number(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1000000000) return `${sign}${(abs / 1000000000).toFixed(2)}B`;
  if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(2)}M`;
  if (abs >= 10000) return `${sign}${(abs / 1000).toFixed(1)}K`;
  if (decimals !== undefined) {
    const fixed = abs.toFixed(decimals);
    const parts = fixed.split('.');
    return sign + groupDigits(parts[0]) + (parts[1] ? `.${parts[1]}` : '');
  }
  if (abs >= 100) return sign + groupDigits(String(Math.round(abs)));
  if (abs >= 10) return `${sign}${abs.toFixed(1)}`;
  return `${sign}${abs.toFixed(2)}`;
}

/** Integer counts for titles, captions and notes — never renders 10 as "10.0". */
function fmtCount(value) {
  if (!isNum(value)) return 'n/a';
  return groupDigits(String(Math.round(Number(value))));
}

/** Value labels that keep decimals when the series needs them (2.05, 10.4). */
function fmtValue(value) {
  if (!isNum(value)) return 'n/a';
  const n = Number(value);
  if (Number.isInteger(n)) return groupDigits(String(n));
  return groupDigits(n.toFixed(Math.abs(n) < 10 ? 2 : 1));
}

/** Compact axis ticks: 1.2M / 45K / 320. */
function fmtAxis(value) {
  if (!isNum(value)) return 'n/a';
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (abs >= 10000) return `${(n / 1000).toFixed(0)}K`;
  return groupDigits(String(Math.round(n)));
}

function fmtPct(value) {
  if (!isNum(value)) return 'n/a';
  return `${Number(value).toFixed(1)}%`;
}

function money(value, currency) {
  if (!isNum(value)) return 'n/a';
  return `${currency || ''}${fmtNumCompact(value)}`;
}

function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { __parseError: error.message };
  }
}

/* ------------------------------------------------------------------ *
 * SVG charts
 * ------------------------------------------------------------------ */

function noDataSvg(message, height) {
  const h = height || 200;
  return `
  <rect x="1" y="1" width="678" height="${h - 2}" fill="#fafafa" stroke="#e5e7eb"/>
  <text x="340" y="${h / 2}" text-anchor="middle" font-size="13" fill="#6b7280">${escapeHtml(message)}</text>`;
}

/** Vertical bars. `rows` = [{label, value, color, projected}] — rows with a non-numeric value are dropped. */
function svgVerticalBars(rows, opts) {
  const options = opts || {};
  const usable = (rows || []).filter((row) => isNum(row.value));
  const height = options.height || 260;
  if (usable.length === 0) return noDataSvg(options.emptyText || '无可用数据', height);

  const width = 680;
  const margin = { top: 20, right: 16, bottom: options.rotateLabels ? 74 : 46, left: 74 };
  const plotX = margin.left;
  const plotY = margin.top;
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const values = usable.map((row) => Math.max(0, Number(row.value)));
  const maxValue = Math.max.apply(null, values.concat([1]));
  const step = niceStep(maxValue / 5);
  const niceMax = Math.max(step, Math.ceil(maxValue / step) * step);
  const tickCount = Math.round(niceMax / step);
  const slot = plotW / usable.length;
  const barWidth = Math.max(10, Math.min(56, slot * 0.62));

  let svg = '';
  for (let i = 0; i <= tickCount; i++) {
    const tickValue = step * i;
    const y = plotY + plotH - (tickValue / niceMax) * plotH;
    svg += `<line x1="${plotX}" y1="${y.toFixed(1)}" x2="${plotX + plotW}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>\n`;
    svg += `<text x="${plotX - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#6b7280">${escapeHtml(options.tickFormatter ? options.tickFormatter(tickValue) : fmtAxis(tickValue))}</text>\n`;
  }

  usable.forEach((row, index) => {
    const value = Math.max(0, Number(row.value));
    const barHeight = (value / niceMax) * plotH;
    const x = plotX + index * slot + (slot - barWidth) / 2;
    const y = plotY + plotH - barHeight;
    const color = row.color || CHART_COLORS[index % CHART_COLORS.length];
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(barHeight, 1).toFixed(1)}" fill="${color}" rx="3"/>\n`;
    svg += `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#374151">${escapeHtml(options.valueFormatter ? options.valueFormatter(row.value) : fmtCount(row.value))}</text>\n`;

    const labelX = x + barWidth / 2;
    const labelY = plotY + plotH + 16;
    if (options.rotateLabels) {
      svg += `<text x="${labelX.toFixed(1)}" y="${labelY}" text-anchor="end" font-size="10" fill="#4b5563" transform="rotate(-32,${labelX.toFixed(1)},${labelY})">${escapeHtml(row.label)}</text>\n`;
    } else {
      svg += `<text x="${labelX.toFixed(1)}" y="${labelY}" text-anchor="middle" font-size="10" fill="#4b5563">${escapeHtml(row.label)}</text>\n`;
    }
    if (row.projected) {
      svg += `<text x="${labelX.toFixed(1)}" y="${(plotY + 10).toFixed(1)}" text-anchor="middle" font-size="9" fill="#94a3b8">预测</text>\n`;
    }
  });

  return svg;
}

/** Horizontal bars. `rows` = [{label, value, color}] — non-numeric values are dropped. */
function svgHorizontalBars(rows, opts) {
  const options = opts || {};
  const usable = (rows || []).filter((row) => isNum(row.value));
  const height = options.height || Math.max(160, usable.length * 26 + 30);
  if (usable.length === 0) return noDataSvg(options.emptyText || '无可用数据', height);

  const width = 680;
  const margin = { top: 12, right: 78, bottom: 16, left: options.labelWidth || 168 };
  const plotX = margin.left;
  const plotW = width - margin.left - margin.right;
  const rowHeight = Math.min(28, (height - margin.top - margin.bottom) / usable.length);
  const maxValue = Math.max.apply(null, usable.map((row) => Number(row.value)).concat([1]));

  let svg = '';
  usable.forEach((row, index) => {
    const value = Math.max(0, Number(row.value));
    const y = margin.top + index * rowHeight + 4;
    const barW = (value / maxValue) * plotW;
    const color = row.color || CHART_COLORS[index % CHART_COLORS.length];
    svg += `<text x="${plotX - 8}" y="${(y + rowHeight * 0.55).toFixed(1)}" text-anchor="end" font-size="10" fill="#374151">${escapeHtml(row.label)}</text>\n`;
    svg += `<rect x="${plotX}" y="${y.toFixed(1)}" width="${Math.max(barW, 1).toFixed(1)}" height="${Math.max(rowHeight - 8, 6).toFixed(1)}" fill="${color}" rx="3"/>\n`;
    svg += `<text x="${(plotX + barW + 6).toFixed(1)}" y="${(y + rowHeight * 0.55).toFixed(1)}" font-size="10" fill="#6b7280">${escapeHtml(options.valueFormatter ? options.valueFormatter(row.value) : fmtCount(row.value))}</text>\n`;
  });

  return svg;
}

function chartBlock(chart) {
  if (!chart) return '';
  const body = chart.unavailable
    ? `<div class="chart-missing">${escapeHtml(chart.unavailable)}</div>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 ${chart.height}" width="100%" role="img" aria-label="${escapeHtml(chart.title)}">
${chart.svg}
</svg>`;

  const insight = chart.insight
    ? `<p class="chart-insight"><strong>洞察：</strong>${escapeHtml(chart.insight)}</p>`
    : '';
  const notes = (chart.notes || []).length
    ? `<ul class="chart-notes">${chart.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
    : '';

  return `
<section class="chart-section">
  <h3>${escapeHtml(chart.title)}</h3>
  <p class="chart-caption">${escapeHtml(chart.caption)}</p>
  ${body}
  ${insight}
  ${notes}
</section>`;
}

/* ------------------------------------------------------------------ *
 * Chart builders — every value is read from the JSON, none is invented
 * ------------------------------------------------------------------ */

function priceBandChart(facts) {
  const rows = Array.isArray(facts.priceBands) ? facts.priceBands : [];
  const currency = facts.market && facts.market.currency ? facts.market.currency : '';
  const usable = rows.filter((row) => isNum(row.revenue));

  const notes = [];
  if (usable.length > 0) {
    const total = usable.reduce((sum, row) => sum + Number(row.revenue), 0);
    const top = usable.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue))[0];
    notes.push(
      `销售额最高的价格带为 ${top.label}：${money(top.revenue, currency)}，`
      + `占价格带销售额 ${fmtPct(total > 0 ? (Number(top.revenue) / total) * 100 : null)}，含 ${fmtCount(top.skuCount)} 个 SKU。`
    );
    notes.push('各价格带 SKU 数：' + usable.map((row) => `${row.label} ${fmtCount(row.skuCount)}`).join('；') + '。');
  }

  return {
    title: '图 1 价格带销售额分布',
    caption: `数据来源：商品维度 CSV 样本 | 样本 ${fmtCount(facts.source && facts.source.rowsKept)} 个 SKU | 指标：月销售额（导出工具口径）| 价格带数：${fmtCount(rows.length)}`,
    height: 270,
    rotateLabels: usable.length > 5,
    svg: svgVerticalBars(
      usable.map((row, index) => ({
        label: row.label,
        value: Number(row.revenue) / 1000,
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
      {
        rotateLabels: usable.length > 5,
        tickFormatter: (v) => fmtAxis(v * 1000),
        valueFormatter: (v) => money(v * 1000, currency),
        emptyText: '事实层中没有可用的价格带销售额数据',
      }
    ),
    unavailable: usable.length === 0 ? '事实层中没有可用的价格带销售额数据（价格列或销售额列不可用）。' : null,
    notes,
  };
}

function brandShareChart(facts) {
  const rows = Array.isArray(facts.brandShare) ? facts.brandShare : [];
  const currency = facts.market && facts.market.currency ? facts.market.currency : '';
  const usable = rows.filter((row) => isNum(row.revenue));
  const concentration = (facts.riskSignals && facts.riskSignals.concentration) || {};

  const notes = [];
  if (usable.length > 0) {
    notes.push(`样本品牌数 ${fmtCount(concentration.brandCount)}；CR3 ${fmtPct(concentration.cr3Pct)}，CR5 ${fmtPct(concentration.cr5Pct)}，CR10 ${fmtPct(concentration.cr10Pct)}（分母：样本内月销售额合计 ${money(concentration.denominatorRevenue, currency)}）。`);
    if (isNum(concentration.topNRevenueSharePct)) {
      notes.push(`TOP${fmtCount(concentration.topN)} 商品销售额占比 ${fmtPct(concentration.topNRevenueSharePct)}。`);
    }
  }

  return {
    title: `图 2 品牌销售额份额（TOP ${fmtCount(rows.length)}）`,
    caption: `数据来源：商品维度 CSV 样本 | 品牌按月销售额排序 | 仅展示 TOP ${fmtCount(rows.length)}，非全部品牌`,
    height: Math.max(200, usable.length * 26 + 30),
    svg: svgHorizontalBars(
      usable.map((row, index) => ({
        label: String(row.brand || 'Unknown').slice(0, 26),
        value: Number(row.revenue),
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
      { valueFormatter: (v) => money(v, currency), emptyText: '事实层中没有可用的品牌销售额数据' }
    ),
    unavailable: usable.length === 0 ? '事实层中没有可用的品牌销售额数据。' : null,
    notes,
  };
}

function listingAgeChart(facts) {
  const bands = facts.listingAge && Array.isArray(facts.listingAge.bands) ? facts.listingAge.bands : [];
  const currency = facts.market && facts.market.currency ? facts.market.currency : '';
  const usable = bands.filter((row) => isNum(row.revenue));

  const notes = [];
  if (bands.length > 0) {
    notes.push('各区间 SKU 数：' + bands.map((row) => `${row.label} ${fmtCount(row.skuCount)}`).join('；') + '。');
    if (isNum(facts.listingAge.skusWithAge)) {
      notes.push(`有上架天数的 SKU ${fmtCount(facts.listingAge.skusWithAge)} 个，上架天数为 0 或空 ${fmtCount(facts.listingAge.skusWithoutAge)} 个（图表未包含后者）。`);
    }
    const newPool = facts.recentPool || {};
    if (isNum(newPool.n)) {
      notes.push(`上架 ≤ ${fmtCount(facts.options && facts.options.newDays)} 天的新品池 n=${fmtCount(newPool.n)}${newPool.smallSample ? '（小样本，慎用）' : ''}。`);
    }
  }

  return {
    title: '图 3 上架时长 × 月销售额',
    caption: `数据来源：商品维度 CSV 样本 | 分组依据：「上架天数」列 | 指标：月销售额`,
    height: 270,
    svg: svgVerticalBars(
      usable.map((row, index) => ({
        label: row.label,
        value: Number(row.revenue) / 1000,
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
      {
        tickFormatter: (v) => fmtAxis(v * 1000),
        valueFormatter: (v) => money(v * 1000, currency),
        emptyText: '事实层中没有可用的上架时长数据（上架天数列不可用）',
      }
    ),
    unavailable: usable.length === 0 ? '事实层中没有可用的上架时长数据（缺少「上架天数」列或销售额列）。' : null,
    notes,
  };
}

function keywordChart(facts) {
  const rows = Array.isArray(facts.keywordFreq) ? facts.keywordFreq : [];
  const stats = facts.keywordStats || {};
  const usable = rows.filter((row) => isNum(row.count));

  const notes = [];
  if (usable.length > 0) {
    notes.push(`统计口径：同一标题内去重计数；分母 = ${fmtCount(stats.documentCount)} 条有标题的 SKU；入选阈值 = 出现 ≥ ${fmtCount(stats.minCount)} 次。`);
    notes.push(`停用词 ${fmtCount(stats.stopWordCount)} 个 — ${stats.stopWordSource || '未记录'}。`);
  }

  return {
    title: '图 4 标题关键词频次',
    caption: `数据来源：${fmtCount(stats.documentCount)} 条商品标题（每个标题去重计数）| 指标：包含该词的标题数 | 展示前 ${fmtCount(rows.length)} 个`,
    height: Math.max(200, usable.length * 24 + 30),
    svg: svgHorizontalBars(
      usable.map((row, index) => ({
        label: String(row.keyword || '').slice(0, 26),
        value: Number(row.count),
        color: CHART_COLORS[index % CHART_COLORS.length],
      })),
      { labelWidth: 150, valueFormatter: (v) => fmtCount(v), emptyText: '事实层中没有可用的标题关键词数据' }
    ),
    unavailable: usable.length === 0 ? '事实层中没有可用的标题关键词数据（标题列不可用或样本为空）。' : null,
    notes,
  };
}

/** Accepts several trend_context.json shapes; returns [] when nothing is plottable. */
function extractTrendSeries(trend) {
  if (!trend || typeof trend !== 'object') return { rows: [], explicit: false };

  const arrays = [
    trend.series,
    trend.yoy,
    trend.historical,
    trend.history,
    trend.marketTrend,
    trend.trend,
  ].filter(Array.isArray);

  const projections = [trend.projection, trend.forecast, trend.forecasts].filter(Array.isArray);

  const historical = arrays.length > 0 ? arrays[0] : [];
  const projection = projections.length > 0 ? projections[0] : [];

  const labelKeys = ['label', 'year', 'date', 'month', 'period', 'name'];
  const valueKeys = ['value', 'marketSize', 'market_size', 'size', 'index', 'revenue', 'sales', 'searchIndex', 'demandIndex'];

  const pick = (row, keys) => {
    for (const key of keys) {
      if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
    }
    return undefined;
  };

  const mapRow = (row, projected) => {
    if (!row || typeof row !== 'object') return null;
    const value = pick(row, valueKeys);
    const label = pick(row, labelKeys);
    if (!isNum(value) || label === undefined) return null;
    return {
      label: String(label),
      value: Number(value),
      projected: Boolean(projected || row.projected || row.projection || row.forecast),
      growthRate: pick(row, ['growthRate', 'growth', 'yoy', 'yoyGrowth']),
    };
  };

  return {
    rows: historical.map((row) => mapRow(row, false)).filter(Boolean)
      .concat(projection.map((row) => mapRow(row, true)).filter(Boolean)),
    explicit: arrays.length > 0 || projections.length > 0,
  };
}

function trendSources(trend) {
  const source = (trend && (trend.sources || trend.source)) || null;
  if (!source) return [];
  const list = Array.isArray(source) ? source : [source];
  return list
    .map((entry) => {
      if (typeof entry === 'string') return { name: entry, url: null, readOn: null };
      if (entry && typeof entry === 'object') {
        return {
          name: entry.name || entry.title || entry.url || '未命名来源',
          url: entry.url || null,
          readOn: entry.readOn || entry.read_on || entry.date || null,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function trendChart(trend, trendFileName) {
  const extracted = extractTrendSeries(trend);
  const usable = extracted.rows.filter((row) => isNum(row.value));
  const metric = (trend && (trend.metric || trend.unit)) || '数值';
  const unitLabel = (trend && (trend.unit || trend.currency)) || '';

  const notes = [];
  const sources = trendSources(trend);
  const sourceNames = sources.length
    ? sources.map((source) => source.name).join('；')
    : '未标注来源（趋势层文件缺少 sources）';
  sources.forEach((source) => {
    notes.push(`来源：${source.name}${source.url ? ` — ${source.url}` : ''}${source.readOn ? `（读取日期 ${source.readOn}）` : ''}`);
  });
  if (trend && typeof trend.notes === 'string' && trend.notes.trim()) {
    notes.push(trend.notes.trim());
  }
  if (usable.length > 0) {
    const first = usable[0];
    const last = usable[usable.length - 1];
    const projectedCount = usable.filter((row) => row.projected).length;
    if (first.value !== 0) {
      notes.push(`序列从 ${first.label} 到 ${last.label} 的变化为 ${fmtPct(((last.value - first.value) / first.value) * 100)}（仅描述该序列两端，不构成趋势判断）。`);
    }
    if (projectedCount > 0) {
      notes.push(`序列中有 ${fmtCount(projectedCount)} 个预测点（图中标注「预测」），预测值与实测值口径不同，不能直接比较。`);
    }
  }
  if (sources.length === 0) {
    notes.push('趋势层文件未提供 sources 字段，无法标注来源与读取日期；引用该图前必须补齐来源。');
  }

  if (!trend) {
    return {
      title: '图 5 市场趋势与预测',
      caption: '未提供趋势层数据',
      height: 220,
      svg: '',
      unavailable: '本次运行没有提供趋势层数据，因此没有趋势图。趋势层需单独执行检索并记录来源与读取日期。',
      notes: [],
    };
  }

  return {
    title: '图 5 市场趋势与预测',
    caption: `数据来源：${sourceNames} | 指标：${metric}${unitLabel ? ` (${unitLabel})` : ''} | 序列 ${fmtCount(usable.length)} 个点，其中预测点 ${fmtCount(usable.filter((row) => row.projected).length)} 个`,
    height: 270,
    rotateLabels: usable.length > 6,
    svg: svgVerticalBars(
      usable.map((row, index) => ({
        label: row.label,
        value: row.value,
        projected: row.projected,
        color: row.projected ? '#94a3b8' : CHART_COLORS[index % CHART_COLORS.length],
      })),
      {
        rotateLabels: usable.length > 6,
        valueFormatter: (v) => fmtValue(v),
        emptyText: '趋势层文件中没有可绘制的数值序列',
      }
    ),
    unavailable: usable.length === 0
      ? '已提供趋势层文件，但其中没有可绘制的 {label, value} 序列（需 series / yoy / historical / projection 数组）。'
      : null,
    notes,
  };
}

function buildCharts(facts, trend, trendFileName, insights) {
  const charts = [];
  if (facts) {
    charts.push(Object.assign(priceBandChart(facts), { key: 'priceBand' }));
    charts.push(Object.assign(brandShareChart(facts), { key: 'brandShare' }));
    charts.push(Object.assign(listingAgeChart(facts), { key: 'listingAge' }));
    charts.push(Object.assign(keywordChart(facts), { key: 'keyword' }));
  }
  charts.push(Object.assign(trendChart(trend, trendFileName), { key: 'trend' }));

  charts.forEach((chart) => {
    const text = insights && typeof insights[chart.key] === 'string' ? insights[chart.key].trim() : '';
    if (text) chart.insight = text;
  });
  return charts;
}

/* ------------------------------------------------------------------ *
 * Markdown -> HTML
 * ------------------------------------------------------------------ */

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // markdown allows raw HTML; we re-enable only the line break, everything else stays escaped
  out = out.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  return out;
}

function mdToHtmlBody(md) {
  const lines = md.split(/\r?\n/);
  let out = '';
  let i = 0;

  const isTableRow = (line) => line.trim().indexOf('|') === 0 && line.trim().slice(-1) === '|';
  const isDividerRow = (line) => line.trim().indexOf('|') === 0 && /^\|[\s:|-]+\|$/.test(line.trim());

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (line === '') { i++; continue; }

    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      out += `<h${level}>${renderInline(line.replace(/^#+\s*/, ''))}</h${level}>\n`;
      i++;
      continue;
    }

    if (/^(---|\*\*\*|___)$/.test(line)) { out += '<hr>\n'; i++; continue; }

    if (isTableRow(raw)) {
      const block = [];
      while (i < lines.length && isTableRow(lines[i])) {
        block.push(lines[i].trim());
        i++;
      }
      const rows = block
        .filter((row) => !isDividerRow(row))
        .map((row) => row.slice(1, -1).split('|').map((cell) => cell.trim()));
      if (rows.length > 0) {
        const head = rows[0];
        out += '<div class="table-wrap"><table>\n<thead><tr>';
        out += head.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
        out += '</tr></thead>\n<tbody>\n';
        rows.slice(1).forEach((cells) => {
          out += `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>\n`;
        });
        out += '</tbody>\n</table></div>\n';
      }
      continue;
    }

    if (line.indexOf('> ') === 0) {
      const quote = [];
      while (i < lines.length && lines[i].trim().indexOf('> ') === 0) {
        quote.push(lines[i].trim().slice(2));
        i++;
      }
      out += `<blockquote>${quote.map((q) => `<p>${renderInline(q)}</p>`).join('')}</blockquote>\n`;
      continue;
    }

    if (/^[-*+]\s/.test(line) || /^\d+[.)]\s/.test(line)) {
      const ordered = /^\d+[.)]\s/.test(line);
      const items = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        const isItem = ordered ? /^\d+[.)]\s/.test(current) : /^[-*+]\s/.test(current);
        if (!isItem) break;
        items.push(current.replace(/^([-*+]|\d+[.)])\s*/, ''));
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out += `<${tag}>\n${items.map((item) => `<li>${renderInline(item)}</li>`).join('\n')}\n</${tag}>\n`;
      continue;
    }

    const paragraph = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (next === '' || /^#{1,6}\s/.test(next) || isTableRow(lines[i]) || next.indexOf('> ') === 0
        || /^[-*+]\s/.test(next) || /^\d+[.)]\s/.test(next) || /^(---|\*\*\*|___)$/.test(next)) {
        break;
      }
      paragraph.push(next);
      i++;
    }
    // A single newline inside a paragraph becomes a hard break. CommonMark would join
    // the lines into flowing text, but these reports are written one fact per line
    // (per-SKU cards, evidence lists) and must keep that structure.
    out += `<p>${paragraph.map((line) => renderInline(line)).join('<br>\n')}</p>\n`;
  }

  // The first list directly under the H1 is the report's own header block
  // (生成时间 / 数据来源 / 样本量 / 时间范围) — style it, do not invent content for it.
  out = out.replace(/(<\/h1>\s*)<ul>/, '$1<ul class="meta-list">');
  return out;
}

/* ------------------------------------------------------------------ *
 * Document shell
 * ------------------------------------------------------------------ */

const STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 20px 64px;
  background: #f1f5f9;
  color: #1f2937;
  font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", "Noto Sans CJK SC", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.75;
}
.page { max-width: 1080px; margin: 0 auto; background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(15,23,42,.12); overflow: hidden; }
.page-head { padding: 28px 36px 22px; border-bottom: 1px solid #e2e8f0; background: linear-gradient(180deg,#f8fafc,#fff); }
.page-head h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.35; color: #0f172a; }
ul.meta-list { list-style: none; padding: 0; margin: 10px 0 0; font-size: 12.5px; color: #475569; }
ul.meta-list li { margin: 2px 0; }
.content { padding: 24px 36px 8px; }
h1,h2,h3,h4 { color: #0f172a; line-height: 1.4; }
h1 { font-size: 22px; margin: 26px 0 12px; }
h2 { font-size: 18px; margin: 30px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #2563eb; }
h3 { font-size: 15px; margin: 22px 0 8px; }
h4 { font-size: 14px; margin: 18px 0 6px; }
p { margin: 8px 0; }
a { color: #2563eb; word-break: break-all; }
code { background: #f1f5f9; padding: 1px 5px; border-radius: 3px; font-family: Consolas, Menlo, monospace; font-size: 12px; }
hr { border: none; border-top: 1px solid #e2e8f0; margin: 22px 0; }
blockquote { margin: 12px 0; padding: 10px 16px; background: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 0 6px 6px 0; color: #78350f; }
blockquote p { margin: 4px 0; }
ul,ol { margin: 8px 0; padding-left: 22px; }
li { margin: 3px 0; }
.table-wrap { overflow-x: auto; margin: 12px 0; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { background: #2563eb; color: #fff; text-align: left; padding: 8px 10px; border: 1px solid #1d4ed8; font-weight: 600; white-space: nowrap; }
td { padding: 7px 10px; border: 1px solid #e2e8f0; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f8fafc; }
.appendix { padding: 8px 36px 36px; }
.appendix > h2 { margin-top: 34px; }
.chart-section { margin: 22px 0 30px; padding: 18px 18px 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; }
.chart-section h3 { margin: 0 0 4px; font-size: 15px; }
.chart-caption { margin: 0 0 10px; font-size: 11.5px; color: #64748b; }
.chart-section svg { width: 100%; height: auto; display: block; }
.chart-missing { padding: 26px 16px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; color: #64748b; font-size: 12.5px; text-align: center; }
.chart-notes { margin: 12px 0 0; padding-left: 20px; font-size: 12px; color: #475569; }
.chart-insight { margin: 10px 0 0; padding: 9px 12px; background: #eff6ff; border-left: 4px solid #2563eb; border-radius: 0 6px 6px 0; font-size: 12.5px; color: #1e3a8a; }
@media print {
  body { background: #fff; padding: 0; font-size: 11px; }
  .page { box-shadow: none; border-radius: 0; max-width: none; }
  .content, .appendix, .page-head { padding-left: 0; padding-right: 0; }
  h2 { page-break-after: avoid; }
  table, .chart-section { page-break-inside: avoid; }
}
`;

function buildDocument(input) {
  const chartsHtml = input.charts.length
    ? `<section class="appendix">
  <h2>附图</h2>
  ${input.charts.map(chartBlock).join('\n')}
</section>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="page">
  <header class="page-head">
    <h1>${escapeHtml(input.title)}</h1>
  </header>
  <main class="content">
${input.body}
  </main>
  ${chartsHtml}
</div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = { facts: null, trend: null, title: null, out: null, charts: true, insights: null };
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
    if (arg === '--no-charts') { options.charts = false; continue; }
    if (arg === '--facts') { options.facts = readValue(++i, arg); continue; }
    if (arg === '--trend') { options.trend = readValue(++i, arg); continue; }
    if (arg === '--insights') { options.insights = readValue(++i, arg); continue; }
    if (arg === '--title') { options.title = readValue(++i, arg); continue; }
    if (arg === '--out') { options.out = readValue(++i, arg); continue; }
    if (arg.indexOf('--') === 0) throw new Error(`未知参数：${arg}`);
    positional.push(arg);
  }

  return { options, positional };
}

function newestFactsFile(dataDir, product) {
  if (!fs.existsSync(dataDir)) return null;
  const candidates = fs
    .readdirSync(dataDir)
    .filter((name) => name.slice(-11) === '_facts.json')
    .filter((name) => !product || name.indexOf(`${product}_`) === 0)
    .map((name) => path.join(dataDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates.length > 0 ? candidates[0] : null;
}

function parseProductAndStamp(reportPath) {
  const base = path.basename(reportPath, path.extname(reportPath));
  const match = base.match(/^(.*)_(\d{8}_\d{6})_(report|facts)$/);
  if (match) return { product: match[1], stamp: match[2] };
  return { product: base, stamp: null };
}

const HELP = `用法：node scripts/gen-html.js <report.md> [report.html] [options]

把调研报告 Markdown 渲染为单文件 HTML（内联 CSS + 内联 SVG 图表，无外部依赖）。

参数：
  --facts <facts.json>  事实层文件；默认取 <out>/data 下最新（同一产品优先）的 *_facts.json
  --trend <trend.json>  趋势层文件（可选），无则趋势图区说明缺失
  --insights <file.json> 每张图的「洞察」文案，由 Agent 撰写；键为 priceBand / brandShare /
                        listingAge / keyword / trend。缺省时按同批次 <产品>_<ts>_chart_notes.json 自动查找
  --title <text>        文档标题，默认取 Markdown 的第一个 H1
  --out <dir>           用于定位 data/ 的输出根目录，默认 scripts/ 的上一级
  --no-charts           不渲染附图
  --quiet               不打印摘要
  --help

输出：与报告同目录的 <产品>_<时间戳>_report.html，并复制一份 <out>/reports/latest_report.html。
说明：图表只用传入的 JSON 计算；序列缺失时显示缺失原因，不会画占位图。`;

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

  const reportPath = path.resolve(positional[0]);
  if (!fs.existsSync(reportPath)) {
    console.error(`找不到报告文件：${reportPath}`);
    process.exit(1);
  }

  const outRoot = options.out ? path.resolve(options.out) : DEFAULT_OUT_ROOT;
  const dataDir = path.join(outRoot, 'data');
  const reportsDir = path.join(outRoot, 'reports');

  const identity = parseProductAndStamp(reportPath);

  let factsPath = options.facts ? path.resolve(options.facts) : null;
  if (!factsPath) {
    if (identity.stamp) {
      const candidate = path.join(dataDir, `${identity.product}_${identity.stamp}_facts.json`);
      if (fs.existsSync(candidate)) factsPath = candidate;
    }
    if (!factsPath) factsPath = newestFactsFile(dataDir, identity.product);
    if (!factsPath) factsPath = newestFactsFile(dataDir, null);
  }

  let trendPath = options.trend ? path.resolve(options.trend) : null;
  if (!trendPath && identity.stamp) {
    const candidate = path.join(dataDir, `${identity.product}_${identity.stamp}_trend_context.json`);
    if (fs.existsSync(candidate)) trendPath = candidate;
  }

  const facts = factsPath && fs.existsSync(factsPath) ? readJson(factsPath) : null;
  if (facts && facts.__parseError) {
    console.error(`警告：${path.basename(factsPath)} 解析失败（${facts.__parseError}），本次不渲染图表。`);
  }
  const trend = trendPath && fs.existsSync(trendPath) ? readJson(trendPath) : null;
  if (trend && trend.__parseError) {
    console.error(`警告：${path.basename(trendPath)} 解析失败（${trend.__parseError}），趋势图将显示缺失。`);
  }

  const usableFacts = facts && !facts.__parseError ? facts : null;
  const usableTrend = trend && !trend.__parseError ? trend : null;
  if (usableFacts) usableFacts.__fileName = path.basename(factsPath);

  let insightsPath = options.insights ? path.resolve(options.insights) : null;
  if (!insightsPath && identity.stamp) {
    const candidate = path.join(dataDir, `${identity.product}_${identity.stamp}_chart_notes.json`);
    if (fs.existsSync(candidate)) insightsPath = candidate;
  }
  const insightsRaw = insightsPath && fs.existsSync(insightsPath) ? readJson(insightsPath) : null;
  if (insightsRaw && insightsRaw.__parseError) {
    console.error(`警告：${path.basename(insightsPath)} 解析失败（${insightsRaw.__parseError}），图表不显示洞察。`);
  }
  const insights = insightsRaw && !insightsRaw.__parseError ? insightsRaw : null;

  const markdown = fs.readFileSync(reportPath, 'utf8');
  const h1Match = markdown.match(/^#\s+(.+)$/m);
  const title = options.title || (h1Match ? h1Match[1].trim() : identity.product);

  const charts = options.charts
    ? buildCharts(usableFacts, usableTrend, trendPath && path.basename(trendPath), insights)
    : [];

  const html = buildDocument({
    title,
    body: mdToHtmlBody(markdown),
    charts,
  });

  const outputDir = path.dirname(reportPath);
  const htmlName = identity.stamp
    ? `${identity.product}_${identity.stamp}_report.html`
    : `${identity.product}_report.html`;
  const htmlPath = positional[1] ? path.resolve(positional[1]) : path.join(outputDir, htmlName);

  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html, 'utf8');

  let latestPath = null;
  if (fs.existsSync(reportsDir) || outputDir === reportsDir) {
    fs.mkdirSync(reportsDir, { recursive: true });
    latestPath = path.join(reportsDir, 'latest_report.html');
    if (path.resolve(latestPath) !== path.resolve(htmlPath)) {
      fs.copyFileSync(htmlPath, latestPath);
    } else {
      latestPath = htmlPath;
    }
  }

  if (!options.quiet) {
    console.log(`HTML       : ${htmlPath}`);
    if (latestPath) console.log(`latest     : ${latestPath}`);
    console.log(
      `事实层     : ${usableFacts ? path.basename(factsPath) : '未提供（图表区已标注缺失）'}`
      + ` | 趋势层：${usableTrend ? path.basename(trendPath) : '未提供'}`
      + ` | 图表数：${charts.filter((chart) => !chart.unavailable).length}/${charts.length}`
      + ` | 带洞察：${charts.filter((chart) => chart.insight).length}`
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exit(1);
}

# Competitor Research Skill

Amazon 竞品调研分析工具，用于把卖家精灵或同类 CSV 导出转成事实层报告，并可进一步导出 PDF。

## 快速开始

上传 CSV 后直接告诉 agent：

```text
分析这个竞品数据
```

## 核心目录

```text
competitor-research/
├── SKILL.md
├── _meta.json
├── README.md
├── scripts/
│   ├── analyze.js
│   └── gen-pdf.js
├── data/      # facts JSON 输出
├── reports/   # Markdown / PDF 输出
└── charts/    # 可选图表资源
```

## 使用方法

### 1. 分析 CSV

```bash
node scripts/analyze.js <csv路径>
```

输出：

- `data/<文件名>_<时间戳>_facts.json`
- `reports/<文件名>_<时间戳>_report.md`
- `reports/latest_report.md`
- `reports/latest_report.path.txt`

### 2. 导出 PDF

```bash
node scripts/gen-pdf.js
node scripts/gen-pdf.js <md路径>
node scripts/gen-pdf.js <md路径> <pdf路径>
node scripts/gen-pdf.js <md路径> --charts
```

默认会读取 `reports/latest_report.md`。
首次使用前，请先运行一次 `node scripts/analyze.js <csv路径>` 生成它。

### 3. Agent 调用建议

当用户上传 CSV 并要求分析时，推荐流程是：

1. 运行 `scripts/analyze.js`
2. 让 Agent/LLM 基于 facts / titles 做进一步研究推理
3. 如需交付 PDF，再运行 `scripts/gen-pdf.js`

## CSV 列名要求

脚本会优先识别这些列：

- `价格($)` / `价格`
- `月销量`
- `月销售额($)` / `月销售额`
- `品牌`
- `ASIN`
- `商品标题`
- `评分`
- `上架天数`

## 依赖

- Node.js
- Python + `weasyprint`（用于 PDF 导出）
- 中文字体（推荐 `Noto Sans SC`、`Microsoft YaHei`、`SimHei` 或 `文泉驿微米黑`）

## 说明

- 当前主流程只依赖 `scripts/` 下两个脚本。
- `data/`、`reports/`、`charts/` 是输出目录，首次清理后可能为空。
- `charts/` 下如果存在 `chart1...chart4` 图表，`gen-pdf.js --charts` 会自动插入最新匹配文件。

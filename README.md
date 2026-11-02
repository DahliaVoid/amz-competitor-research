# Competitor Research Skill

Amazon 竞品调研分析工具，用于把卖家精灵或同类 CSV 导出转成事实层报告，并可进一步导出 PDF。

## 快速开始

上传 CSV 后直接告诉 agent：

```text
调用本地amz-competitor-research skill做一个市场调研
```

## 核心目录

```text
competitor-research/
├── SKILL.md
├── _meta.json
├── README.md
├── scripts/
│   ├── analyze.js
│   └── gen-html.js
├── data/      # facts JSON 输出
├── reports/   # Markdown / html 输出
└── charts/    # 可选图表资源
```

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

也兼容常见英文列名（如 `Brand` / `Title` / `Price` / `Monthly Revenue` / `Monthly Sales` / `Days Listed` / `Rating`）。

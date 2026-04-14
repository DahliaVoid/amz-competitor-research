# SKILL: Competitor Research（完整增强版）

Amazon 竞品调研 **事实层 + 趋势层 + Agent 推理工作流工具**。

该 Skill 的核心职责不是直接输出固定结论，而是：

> 从卖家精灵 / CSV 原始数据中提取 **市场事实、品牌格局、价格带机会、TOP 标题语料、新品标题池**，并补充 **YOY、季节性、未来 1–3 年预测趋势**，为 Agent/LLM 提供高质量动态研究上下文。

---

## 核心能力

### 1) 事实层数据提取（analyze.js）
从原始 CSV 自动提取：

- 市场总体规模
  - 总 SKU 数
  - 总销售额
  - 总销量
  - 平均客单价
- 品牌格局
  - TOP10 品牌
  - 品牌销售额
  - SKU 分布
- 价格带机会
  - 不同价格带 SKU 数
  - 价格带坑产（单 SKU 平均产出）
  - 每个价格带样本标题
- 头部竞品池
  - TOP20 商品
  - 高销售额标题
- 新品池
  - 上架 180 天内新品
  - 新品标题语料

---

### 2) 标题语料层（供 Agent/LLM 推理）
自动生成标题语料池：

- TOP Titles
- Recent Titles
- Price Band Sample Titles

供大模型动态分析：

- 高频功能词
- 参数关键词
- 用户使用场景
- 人群定位
- 礼品属性
- 户外 / 家居 / 办公场景
- 差异化方向

---

### 3) 趋势增强层
当最终报告包含以下任一内容时，必须补充趋势检索：

- 市场 YOY 趋势
- 季节性销售趋势
- 市场未来预测
- 类目生命周期判断

### 必须补充的数据源（至少 2 类）
- Google Trends
- 卖家精灵关键词趋势
- Keepa 类目历史价格/BSR
- ShelfTrend 类目趋势
- Grand View Research / Statista / CAGR
- Reddit 用户讨论热度

### 趋势层输出
统一输出 `trend_context.json`：

- 近 12 个月搜索趋势
- 近 3–5 年 CAGR / YOY
- 旺季月份
- 淡季月份
- Prime Day / 黑五 / 圣诞节点
- 用户需求迁移
- 未来 12 / 24 / 36 个月预测

---

### 4) 动态研究层（由 Agent/LLM 完成）
基于：

- facts.json
- trend_context.json
- 标题语料

Agent/LLM 动态推理：

- 市场 YOY 趋势
- 季节性
- 新品节奏
- 用户需求聚类
- 价格带机会
- 差异化卖点路线
- 广告关键词方向
- 主图与 A+ 升级方向
- 新品开发建议
- 未来 1–3 年市场预测

> 注意：YOY、季节性、未来预测 **不在脚本中硬编码**，由模型结合趋势检索动态生成。

---

### 5) 可选导出层（gen-pdf.js）
`scripts/gen-pdf.js` 用于将最终 Markdown 研究报告转换为 PDF，并兼容 `reports/latest_report.md` 的默认流程。

适合：

- 内部汇报
- 产品立项评审
- 跨团队同步
- 存档

支持：

- 中文 PDF
- 表格渲染
- 图表嵌入
- 标题层级
- 页面分页

---

## 风险验证层（新增强制，避免盲目乐观）

### 目标
用于校验 YOY、季节性、未来预测是否存在 **线性外推偏差、幸存者偏差、伪需求误判**。

> 禁止 Agent 因趋势上升、功能空白或搜索热度增长，就直接推导出“适合入场”。

### 强制验证维度
在生成以下任一结论前，必须先执行风险验证：
- 市场 YOY 增长
- 季节性机会
- 新品切入建议
- 差异化卖点机会
- 未来 12–36 个月预测

必须至少校验以下反证指标中的 3 类：

#### 1) 市场饱和度反证
- TOP10 品牌份额是否持续升高
- Amazon's Choice 是否高度集中
- 高评分 Review 壁垒是否过高
- 新链接冷启动难度是否增加

#### 2) 新品真实存活率反证
- 180 天新品销量中位数
- 新品评论增长速度
- 低评分新品淘汰率
- 上架 90 天后仍有销量的新品占比

#### 3) 趋势质量反证
- YOY 是否由单一头部品牌拉动
- 搜索热度是否仅集中在大促节点
- 是否存在短期网红/KOL 带动
- 是否为疫情/政策红利残留

#### 4) 伪需求验证
- 评论区是否主动提及该功能
- 用户是否愿意为新功能支付溢价
- 功能是否真正改善核心使用场景
- 是否只是标题关键词堆砌

### 输出要求
风险验证层只负责：
- 提供支持证据
- 提供反对证据
- 标记不确定性来源
- 给出高 / 中 / 低置信度

> **禁止写死固定结论模板，必须由 Agent 根据证据动态组织结论表达。**

---

## 推荐工作流（最佳实践）

### Step 1：导入 CSV，运行事实层脚本
```bash
node scripts/analyze.js <csv文件路径>
```
输出：
- `data/*_facts.json`
- `reports/*_report.md`

### Step 2：趋势增强
若报告涉及 YOY / 季节性 / 未来预测，必须执行趋势检索。

输出：
- `data/*_trend_context.json`

### Step 3：Agent/LLM 动态研究推理
基于 facts + trend context 输出最终 Markdown。

### Step 4：导出 PDF
```bash
node scripts/gen-pdf.js
node scripts/gen-pdf.js <md路径> --charts
```

---

## 使用方法

### 自动分析（推荐）
上传 CSV 后直接说：

> 亚马逊竞品调研

Agent 会自动执行：

> CSV → analyze.js → facts.json → Agent/LLM 推理 → Markdown → PDF（可选）

---

## 输出文件（动态命名，避免覆盖）

所有输出文件建议采用统一命名规范：

```text
{csv文件名}_{YYYYMMDD_HHMMSS}_{stage}.{ext}
```

例如：

```text
retro-speaker_20260410_153022_facts.json
retro-speaker_20260410_153022_trend_context.json
retro-speaker_20260410_153022_report.md
retro-speaker_20260410_153022_report.pdf
latest_report.md
```

---

## 文件结构
```text
competitor-research/
├── SKILL.md
├── _meta.json
├── scripts/
│   ├── analyze.js
│   └── gen-pdf.js
├── data/
│   ├── *_facts.json
│   └── *_trend_context.json
├── reports/
└── charts/
```

---

## 设计原则

### 1. 脚本只做事实
JS 不负责：
- 行业知识
- 固定功能标签
- YOY 固定结论
- 类目固定经验
- 固定季节性结论
- 固定未来预测

只负责：
- 数据清洗
- 数值分析
- 标题语料提取
- 趋势代理指标

### 2. 趋势层负责时间维度
趋势检索负责：
- 过去 3–5 年
- 月度季节性
- 市场生命周期

### 3. 大模型负责研究与预测
Agent/LLM 负责：
- 动态趋势分析
- 差异化卖点
- 用户需求洞察
- 新品开发策略
- 未来 1–3 年路线预测

### 4. 多品类可扩展
适配：
- 蓝牙音箱
- 耳机
- 按摩椅
- 咖啡机
- 办公椅
- 户外设备
- 其他 Amazon 标准类目

无需修改 analyze.js 主逻辑。


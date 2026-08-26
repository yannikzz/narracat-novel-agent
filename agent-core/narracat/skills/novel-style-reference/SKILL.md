---
name: novel-style-reference
description: A real-novel writing style reference library backed by the novel_query_style_reference MCP tool. Returns annotated extracts from published Chinese novels indexed by technique × emotion. Use the MCP tool to fetch human-written examples that break AI templated expression patterns during chapter writing or review.
---

# novel-style-reference

## 定位

本 Skill 是**系统集成壳**——封装 `novel_query_style_reference` MCP 工具的调用说明，按手法+情感检索真人写作范例。

不提供写作原则、不替代写作技艺指导。库含 58 部华语网文的 4141 个标注段落，存于官方只读语料服务（不随包分发），工具联网检索；去标识化：只给段落与机制注解、不含出处。服务不可用或未配置凭证时返回空结果与提示，不影响写作流程。

> 写作链消费的范例由上下文构建工具按 `technique × emotion` 机械选入，不经本 Skill。

## 何时使用

- **深度审读时** — 标注某段写法问题时，按对应手法调用，提供修订方向的真人参照
- **对话讨论时** — 与用户讨论某类场景怎么写时，调用拉取真人范例
- **不要这样用** — 全量扫描语料文件做整体阅读（违背"按需查询"原则）

## MCP 工具调用

工具全名：`mcp__narracat_memory__novel_query_style_reference`

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `technique` | `string[]` | 是 | 手法标签（至少 1 个），值域见下方"分类体系" |
| `emotion` | `string[]` | 否 | 情感标签（0-2 个），值域见下方"分类体系" |
| `limit` | `int` | 否 | 返回条数上限（默认 3，最大 8） |

**返回：** `StyleReferenceEntry[]`，每条含 `id / paragraph / technique[] / emotion[] / annotation / usage_scenario`（不含出处——真人范例去标识化，只提供段落与机制注解）。

**调用示例：**

```
场景：暴雨中两个陌生人初遇，需要一段对话，既紧张又带点幽默
→ novel_query_style_reference({technique:["对话设计"], emotion:["紧张","幽默"]})
→ 返回 2-3 条同类对话范例
→ 参考范例的节奏与潜台词写法，不照搬段落内容
```

## 分类体系

### 手法维度（8 类）

对话设计 / 心理刻画 / 环境描写 / 动作细节 / 节奏控制 / 情感渲染 / 视角运用 / 悬念设置

### 情感维度（8 类）

紧张 / 悲伤 / 愤怒 / 暧昧 / 幽默 / 温暖 / 释然 / 震撼

> 「幽默」是情感不是手法，勿放进 `technique`。学范例时提炼机制、节奏与语用决策，不复制原文、专名或桥段。

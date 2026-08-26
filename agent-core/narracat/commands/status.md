---
description: 查看项目进度 — 章节完成度、字数统计、当前 arc、伏笔追踪
allowed-tools: [Read, Glob, mcp__narracat_memory__novel_get_arc, mcp__narracat_memory__novel_foreshadowing_status, mcp__narracat_memory__novel_failed_reviews]
---

读取项目状态，向用户展示进度报告。

**对作者说话**：你内部用精确的字段 / 文件 / 工具 / agent 名保证引擎正确，但作者会读到的文本（对话叙述、AskUserQuestion 的问题与选项、报告正文）里不出现内部标识——schema 字段名（如 `antagonistic_force`）、立项卡编号（`§5`/`§7`）、文件 / 目录名（`bible/`、`*.md`）、确定度英文枚举（`canon`/`tentative`/`open`）、agent 名（`world-curator` 等）、工程黑话（落盘 / blocking / payoff_beat 等）一律翻成作者词汇，信息全留、黑话全译。对照表见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/user-facing-language.md`（命令 `/narracat:xxx` 由 App 渲染为动作按钮，不在此列）。

## 执行流程

### 步骤 1: 读取数据

- `.narracat/config.yaml` → 书名、题材、语言
- `.narracat/state.yaml` → progress / structure / word_count / checkpoint
- `mcp__narracat_memory__novel_get_arc(chapter=最新完成章)` → 当前 arc 信息（无大纲或工具报错时本节显示「未规划」）
- `mcp__narracat_memory__novel_foreshadowing_status()` → 伏笔清单与最新状态（工具报错时本节显示 N/A）
- `bible/references/` 目录 → 用 Glob 列出 .md/.txt 文件清单（不读内容）
- `bible/reference-guidance/index.md` 存在性检查（不读内容）
- `mcp__narracat_memory__novel_failed_reviews()` → 未通过审校的章节清单（`failed_chapters`）

### 步骤 2: 生成报告

## 📖 {书名} — 项目状态

### 进度
- 已完成: {completed}/{planned} 章（{percentage}%）
- 正在写作: {in_progress_chapter 或 "无"}
- 总字数: {word_count.total} 字
- 平均每章: {total/completed} 字
- 断点: {checkpoint 存在 → "{last_command} 中断于步骤 {last_step}（{timestamp}）"；否则 "无"}

### 当前 arc
- {arc 标题}（第 {chapter_start}-{chapter_end} 章）
- 核心问题: {core_question}
- 不可逆变化: {irreversible_change}

### 参考作品状态

- 原始参考文本（`bible/references/`）: {file_count} 个 / 或「无」
- 项目级参考指导（`bible/reference-guidance/`）: 已生成 / 未生成
- {特殊态显示}:
  - if guidance 存在 + references 不存在 → 「⚠️ 已保留分析结果，原始参考文本缺失或已清理」
  - if references 存在 + guidance 不存在 → 「💡 可运行 `/narracat:reference` 生成项目级参考指导」
  - if 两者都无 → 「（无参考作品）」

### 伏笔追踪（{count} 个）
| 伏笔 | 埋设章 | 目标揭示 | 最新动作 | 状态 |
|---|---|---|---|---|
（来自 novel_foreshadowing_status；状态由最新 action 导出。target 已临近（≤ 当前章+10）且未 reveal 的行加 ⚠️ 标注）

### 未通过审校的章节
（步骤 1 的 `novel_failed_reviews` 结果 `failed_chapters`；为空时显示「无」）

### 下一步
- 建议: /narracat:write {in_progress_chapter 或 last_completed_chapter+1}

## 错误处理

| 场景 | 处理 |
|---|---|
| 项目未初始化 | 报错 + 提示执行 /narracat:init |
| state.yaml 损坏 | 尝试从文件系统重建基础信息 |
| MCP 工具不可用 | 对应小节显示 N/A，其余照常输出 |

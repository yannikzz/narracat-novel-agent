---
description: 审校已完成章节 — 默认客观错误审校；追加 deep 进入深度标注
argument-hint: <章节号或范围，如"42"、"40-45"、"vol-01"；追加 deep 进入深审>
allowed-tools: [Agent, Read, Write, AskUserQuestion, "mcp__narracat_memory__novel_build_writing_context_pack", "mcp__narracat_memory__novel_get_review"]
---

对已完成章节做审校。两种模式：

- **模式 A（默认）**：客观错误审校。与 /narracat:write 的写后审修是同一个 agent、同一套规则，本命令不另加任何审校要求。
- **模式 B（深审）**：$ARGUMENTS 含 `deep` 时触发。纯描述性标注，供人阅读，不评分、不判定、不回流修改。

## 参数解析

- 纯数字 "42" → [42]；范围 "40-45" → 第 40 到 45 章；"vol-01" → 读 `.narracat/state.yaml` 的 `structure.chapter_to_volume` 反查该卷全部已完成章节。
- 目标章节必须在 `progress.completed_chapters` 中，未完成的章节警告并跳过。
- 未提供参数 → AskUserQuestion 询问审校范围；范围超过 20 章 → AskUserQuestion 确认。
- 每章按 `chapter_to_volume` 查得卷号，正文路径 `manuscript/vol-{VV}/ch-{NNN}.md`（VV 卷号两位补零，NNN 章号三位补零）。

/review 是只读诊断流程：不回流改稿、不更新进度。

## 模式 A：客观错误审校（默认）

对每个目标章节依次执行：

1. 调 `novel_build_writing_context_pack(chapter={N})`，记下返回的 pack_path 与 manuscript_path（上下文包由工具落盘）。工具返回错误 → 该章标记为无法审校并记录原因，继续下一章。
2. 派发审校（与 /narracat:write 写后审修同一 Envelope，不复述审校规则）：

   ```
   Task(continuity-editor): "审校第 {N} 章。
   正文路径: {manuscript_path}
   上下文包路径: {pack_path}"
   ```

3. 调 `novel_get_review(chapter={N})` 取 `{verdict, blockers[]}`。审校报告由工具渲染到 `reviews/ch-{NNN}-review.md`，主会话不写报告文件。

全部章节完成后汇总展示：

| 章 | verdict | blockers |
|---|---|---|

- verdict=fail 的章：逐条列出 blockers，建议 `/narracat:rewrite {N}` 修复。
- 全部 pass：报告"审校通过，无客观错误"。

## 模式 B：深审标注（按需）

深审一律按章落盘，每个目标章节各产一份报告——范围 / 卷输入对范围内每章逐章执行，绝不合并为区间文件。对每个目标章节依次执行：

1. Read 该章正文。深审只基于当前文本做描述性标注；不要读取或套用通用写作原则索引。
2. 通读后写一份纯描述性标注：哪里有力、哪里平、节奏与情绪的观察——逐处给出位置和一句话描述，描述事实而非下结论。
3. 硬规则：无分数、无 verdict、无结构化字段、不写修订指令、不触发任何重写。
4. 写入 `reviews/ch-{NNN}-deep-review.md`（NNN 为该章章号三位补零）。深审报告与轻审报告同住 `reviews/`，供工作台审修视图按章发现并展示；深审不产 JSON 孪生（无 verdict、无路由）。

## 错误处理

| 场景 | 处理 |
|---|---|
| 未提供参数 | AskUserQuestion 询问审校范围 |
| 章节未完成 | 警告并跳过 |
| 上下文包构建失败 | 该章标记为无法审校，继续其余章节 |

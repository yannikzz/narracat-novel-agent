---
description: 立项卡定点修订 — 改一张地基卡的一条内容，先评级联影响、作者确认后再落改并同步大纲
argument-hint: <卡·字段>（可追加一句修改诉求）
allowed-tools: [Read, Grep, Glob, AskUserQuestion, "mcp__narracat_memory__novel_submit_premise"]
---

定点修改一张立项卡的一条地基内容：定位 → 讨论新值 → 级联影响评估 → 作者确认 → 写回并同步大纲重叠字段。本命令由主会话直接执行，不派发 agent，不自动改任何章节。

**对作者说话**：你内部用精确的字段 / 文件 / 工具 / agent 名保证引擎正确，但作者会读到的文本（对话叙述、AskUserQuestion 的问题与选项、报告正文）里不出现内部标识——schema 字段名（如 `antagonistic_force`）、立项卡编号（`§5`/`§7`）、文件 / 目录名（`bible/`、`*.md`）、确定度英文枚举（`canon`/`tentative`/`open`）、级联影响级别枚举（`critical`/`moderate`/`minor`）、agent 名（`world-curator` 等）、工程黑话（落盘 / blocking / payoff_beat 等）一律翻成作者词汇，信息全留、黑话全译。对照表见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/user-facing-language.md`（命令 `/narracat:xxx` 由 App 渲染为动作按钮，不在此列）。

## 步骤 0：定位与读现状

1. 解析 $ARGUMENTS：识别要改的卡与字段（如「对抗力量」「主角欲望·深层需要」），其余文字为用户的修改诉求（可空）。指向不明时用 AskUserQuestion 让用户在九卡条目中选定一条。
2. Read `bible/premise-cards.json`（立项卡数据契约，即当前权威值）。不存在 → 报错：「尚未立项，请先运行 /narracat:setup」，终止。
3. 取出目标字段的当前值与确定度，记为旧值（步骤 2 级联评估与步骤 4 写回都用它）。本命令只改这一条，其余卡原样保留。

## 步骤 1：讨论新值（只动一条）

- 用追问式对话把这一条收敛到具体新值，附你的推荐答案（基于旧值与其余八卡推断最可能的改法，用户回「按你说的」即采纳）。
- 只讨论这一条；牵出其他卡的改动需要时提示用户另起一次 `/narracat:revise-premise`，不在本次顺手改。
- 收敛出新值后进入级联评估，先不写回。

## 步骤 2：级联影响评估（不修改任何文件）

读 `.narracat/state.yaml` 的 `progress.completed_chapters`：

1. completed_chapters 为空 → 无级联，直接进入步骤 3（按无影响报告）。
2. 逐章 Read 已完成章节正文，找出依赖旧地基值的段落——被改字段所承载的设定 / 欲望 / 对抗关系 / 中心问题在正文里的体现。
3. 按 CascadeImpactReport 的结构组织结果（锚点是被改的地基字段，而非某个重写章）：
   - key_changes：本次地基改动的关键差异，每条 `{ category, description, old_value, new_value }`。
   - affected_chapters：每条 `{ chapter, impact_level ∈ critical|moderate|minor, issues[], suggested_fix }`。

## 步骤 3：先报告后确认

- 无级联影响 → 一行说明「改动不影响已写章节」，进入步骤 4。
- 有级联影响 → 表格展示 | 章节 | 影响级别 | 问题 | 建议修复 |，并说明：确认后只更新立项卡、不自动改章节；critical 章需作者事后逐章 `/narracat:rewrite` 修复。
- 用 AskUserQuestion 二选一：确认落改 / 取消。取消即终止，不做任何修改。

## 步骤 4：写回并同步大纲

1. 构造**只含目标卡**的 payload：取步骤 0 读到的该卡**完整 fields**，只把目标字段的 value 改为新值（确定度按用户意图：定稿用 canon，仍待定用 tentative），同卡其余 field 原样带上——必须带全该卡所有 field，否则会丢字段。
2. 调 `novel_submit_premise(payload=<只含目标卡>, merge_cards=true, sync_engine_facts=true)`：工具按 card key 把目标卡并入现有立项卡（其余八卡不受影响、不会丢），引擎落库 + 机械渲染只读 premise.md + 落 premise-cards.json；并把与大纲重叠的四项「全书」facts 同步为新值（中心戏剧问题 / 主角核心欲望←主角欲望·表层想要 / 主角核心缺失←主角欲望·深层需要 / 对抗力量），同时回灌已渲染的全书大纲（outline-structure.json + master-outline.md）同名字段，使记忆与用户可见大纲一致；其余字段不在同步范围。
3. 工具校验失败 → 按 errors[].hint 自修正重试 ≤2 次，超限停下报人工。
4. 落改后输出一行摘要（改了哪条 + 是否有级联）；若有 critical 章，逐章建议 `/narracat:rewrite <章号>` 修复，不自动执行。

## 错误处理

| 场景 | 处理 |
|---|---|
| 尚未立项（无 premise-cards.json） | 提示运行 /narracat:setup，终止 |
| 目标字段指向不明 | AskUserQuestion 让用户选定一条再继续 |
| 用户取消 | 终止，不做任何修改 |
| 工具校验失败 | 按 errors[].hint 自修正重试 ≤2 次，超限停下报人工 |

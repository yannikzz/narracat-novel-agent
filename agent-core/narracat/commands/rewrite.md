---
description: 重写已完成章节 — 回滚记忆后重新执行写作流程，并分析对后续章节的级联影响
argument-hint: <章节号>（可追加一句重写要求）
allowed-tools: [Agent, Read, Write, Grep, Glob, AskUserQuestion, "mcp__plugin_narracat_novelmemory__novel_build_writing_context_pack", "mcp__plugin_narracat_novelmemory__novel_rollback_chapter", "mcp__plugin_narracat_novelmemory__novel_get_review", "mcp__plugin_narracat_novelmemory__novel_get_arc", "mcp__plugin_narracat_novelmemory__novel_character_state", "mcp__plugin_narracat_novelmemory__novel_update_progress", "mcp__plugin_narracat_novelmemory__novel_checkpoint"]
---

重写指定的已完成章节：确认 → 构建上下文包 → 记忆回滚 → 重写 → 审修 → 入库 → 级联影响分析。

**对作者说话**：你内部用精确的字段 / 文件 / 工具 / agent 名保证引擎正确，但作者会读到的文本（对话叙述、AskUserQuestion 的问题与选项、报告正文）里不出现内部标识——schema 字段名（如 `antagonistic_force`）、立项卡编号（`§5`/`§7`）、文件 / 目录名（`bible/`、`*.md`）、确定度英文枚举（`canon`/`tentative`/`open`）、agent 名（`world-curator` 等）、工程黑话（落盘 / blocking / payoff_beat 等）一律翻成作者词汇，信息全留、黑话全译。对照表见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/user-facing-language.md`（命令 `/narracat:xxx` 由 App 渲染为动作按钮，不在此列）。

## 步骤 0：影响预警与确认

1. 解析 $ARGUMENTS：第一个数字为 chapter_num，其余文字为用户的重写要求（可空）。
2. 读 `.narracat/state.yaml`（取 progress 与 structure）。
3. chapter_num 不在 `progress.completed_chapters` → 报错："该章未完成，请使用 /narracat:write"。
4. chapter_num 不在 `structure.chapter_to_volume` → 报错："该章未在大纲中规划"。
5. 调 `novel_get_review(chapter=chapter_num)`：有 blockers 则展示，作为默认修复目标。
6. 展示警告："重写第 {chapter_num} 章将回滚该章记忆并重新写作，可能影响第 {chapter_num+1}-{last_completed_chapter} 章（共 N 章）。" → AskUserQuestion："确认重写" / "取消"。取消即终止，不做任何修改。

## 步骤 1：构建上下文包（不修改记忆与正文）

- 调 `novel_build_writing_context_pack(chapter=chapter_num)`，记下返回的 pack_path、manuscript_path 与 word_count_range（上下文包由工具落盘），后续步骤直接引用。
- 工具返回错误 → 终止：不回滚记忆、不覆盖正文。
- Read {manuscript_path} 当前正文，保存为旧稿（步骤 6 级联分析用）。
- Read {pack_path}：包里有 `characters_without_cards` 时逐个按条目上的 `character_uid` 调 `novel_character_state` 补查，把这些角色的当前状态翻成人话记为 `{角色状态补充}`（无该键则为空），步骤 3 派发时附上。本命令的写手直接读包、手上没有查询工具，这一步不补它就只能靠猜。

## 步骤 2：记忆回滚

- 调 `novel_rollback_chapter(chapter=chapter_num)`：该章记忆移除、被该章失效的旧事实恢复、进度状态回退，全部由工具完成。主会话不手改 `state.yaml`。
- 回滚失败 → 终止并报告（记忆状态不一致时不得继续写作）。
- 调 `novel_checkpoint(command="rewrite {chapter_num}", step=2, chapter=chapter_num)`。

## 步骤 3：正文生成

```
Task(chapter-writer): "重写第 {chapter_num} 章正文。
目标字数区间: {word_count_range 的下限}-{word_count_range 的上限} 字。
输出路径: {manuscript_path}
WritingContextPack 路径: {pack_path}
重写要求: {用户的重写要求；无则用步骤 0 取得的 blockers；两者都无则写「按细纲重写」}
包外补充的角色状态: {角色状态补充；为空则写「无」}
包里没给全的角色资料以上面这段为准，不要去翻或猜项目里的文件。"
```

完成后调 `novel_checkpoint(command="rewrite {chapter_num}", step=3, chapter=chapter_num)`。

## 步骤 4：审修与路由

1. 派发审校（与 /narracat:write 写后审修同一 Envelope，不复述审校规则）：

   ```
   Task(continuity-editor): "审校第 {chapter_num} 章。
   正文路径: {manuscript_path}
   上下文包路径: {pack_path}"
   ```

2. 调 `novel_get_review(chapter=chapter_num)` 取 `{verdict, blockers[]}`。
3. verdict=fail → 定向修复一次（上限 1 轮）：
   - Task(chapter-writer)："只修复以下问题，其余内容保持不变：{blockers 原样列出}。文件路径: {manuscript_path}。WritingContextPack 路径: {pack_path}。"
   - Task(continuity-editor)："审校第 {chapter_num} 章。只复验下列已修复问题: {blockers 原样列出}。正文路径: {manuscript_path}。上下文包路径: {pack_path}。"
   - 再调 `novel_get_review`。仍 fail → 调 `novel_checkpoint(command="rewrite {chapter_num}", step=4, chapter=chapter_num)`，停止并向用户报告 blockers，等人工处理。
4. verdict=pass → 继续步骤 5。

## 步骤 5：记忆入库与进度

1. 派发记忆收尾：

   ```
   Task(memory-keeper): "第 {chapter_num} 章已定稿，执行章节收尾。
   正文路径: {manuscript_path}
   本章调 novel_commit_chapter 与 novel_submit_extraction。"
   ```

   若本章是其所在 arc 或卷的末章（用 `novel_get_arc(chapter=chapter_num)` 查边界），在派发中追加："本章到达 {arc|volume} {scope_id} 边界（第 {start}-{end} 章），另调 novel_consolidate 刷新该区间摘要。"
2. 调 `novel_update_progress(chapter=chapter_num)`（完成集合、字数、checkpoint 清理全部由工具写 `state.yaml`）。

## 步骤 6：级联影响分析（主会话直接执行）

1. 对比旧稿与新稿，提取关键差异：角色状态、事件、关系、伏笔、设定。
2. 逐章 Read 后续章节（chapter_num+1 到 last_completed_chapter），找出引用了被改动内容的段落，评定 impact_level ∈ critical / moderate / minor。
3. 按 CascadeImpactReport 组织结果：`rewritten_chapter` / `has_impact` / `affected_chapters[{chapter, impact_level, issues, suggested_fix}]`。
4. 展示：
   - has_impact=false → "重写完成，无级联影响。"
   - has_impact=true → 表格展示 | 章节 | 影响级别 | 问题 | 建议修复 |，建议对 critical 章逐章 `/narracat:rewrite` 修复 → AskUserQuestion："了解，稍后处理" / "立即修复第 X 章"。

## 错误处理

| 场景 | 处理 |
|---|---|
| 章节未完成 | 报错 + 引导使用 /narracat:write |
| 上下文包构建失败 | 终止，不回滚记忆、不覆盖正文 |
| 记忆回滚失败 | 终止，不继续写作 |
| 修复复验仍 fail | 停在 checkpoint，报告 blockers 等人工处理 |
| 用户取消 | 终止，不做任何修改 |

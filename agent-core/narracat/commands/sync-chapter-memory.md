---
description: 用户手改正文后同步本章记忆 — 影响评估 → 作者确认 → 回滚重抽 → 矛盾提示
argument-hint: <章节号>
allowed-tools: [Agent, Read, Grep, Glob, AskUserQuestion, "mcp__narracat_memory__novel_chapter_summary", "mcp__narracat_memory__novel_query", "mcp__narracat_memory__novel_foreshadowing_status", "mcp__narracat_memory__novel_rollback_chapter", "mcp__narracat_memory__novel_detect_conflicts", "mcp__narracat_memory__novel_get_arc", "mcp__narracat_memory__novel_restore_progress", "mcp__narracat_memory__novel_checkpoint"]
---

作者手动修改了某章正文（改动已保存到正文文件）。你的任务：评估这次改动对记忆库的影响，
经作者确认后回滚记忆并按新正文重新提取入库，最后提示可能的矛盾。
**正文一个字都不改，只动记忆**——发现矛盾只报告，改不改、要不要重写由作者决定。

**v1 范围限定**：本命令目前只支持同步**目前完成写作的最新一章**；更早的章节暂不支持，见步骤 0。

**对作者说话**：你内部用精确的字段 / 文件 / 工具 / agent 名保证引擎正确，但作者会读到的文本（对话叙述、AskUserQuestion 的问题与选项、报告正文）里不出现内部标识——schema 字段名、文件 / 目录名（`manuscript/`、`*.md`）、工具名、agent 名、工程黑话（落盘 / 回滚 / 事实 等）一律翻成作者词汇，信息全留、黑话全译。对照表见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/user-facing-language.md`。

## 步骤 0：定位与前置检查

1. 解析 $ARGUMENTS：第一个数字为 chapter_num。无数字 → 用 AskUserQuestion 问作者要同步哪一章。
2. 读 `.narracat/state.yaml`：取 `progress.completed_chapters`，记下其中最大章号为 `last_completed_chapter`。
   - chapter_num 不在 `completed_chapters` 里 → 告知作者"这一章还没有完成写作，正文修改会在写作或重写时自然入库，不需要单独同步"，终止。
3. **前置检查（v1 范围限定）**：chapter_num 必须等于 `last_completed_chapter`（即目前完成写作的最新一章）。不相等 → 用作者词汇如实告知："你的正文修改已经保存，不受影响。但目前只有最新完成的一章支持同步记忆——更早章节的记忆牵连其后所有章节，这个能力还在路上。想让这一章的剧情变化真正进入后续创作，可以对它使用重写。"然后终止，不查看文件、不碰任何记忆。
4. 用 Glob 按 `manuscript/vol-*/ch-{chapter_num 补零三位}.md` 定位该章正文文件（卷目录前缀不定，章号文件名固定三位数字补零）。
   - 未找到匹配文件（进度显示已完成但文件缺失）→ 报错"记录与实际文件不一致"，终止。
   - 找到即 Read 全文（这是作者改过的新正文），记为「正文文件路径」供后续步骤引用。

## 步骤 1：影响评估（只读，不动任何记忆）

1. 调 `novel_chapter_summary(chapter=chapter_num)` 取本章已入库摘要与事实。
2. 用 `novel_query` 按本章关键角色、关键事件检索相关事实；调 `novel_foreshadowing_status(chapter=chapter_num)` 取截至本章的伏笔状态快照（不是"本章触发了哪些动作"的精确过滤，只作参考，判断本章可能涉及的伏笔埋设 / 推进 / 揭示是否因改动而变化）。
3. 对比新正文与已入库记忆，整理影响清单：
   - **变了的事实**：记忆里记的与新正文不一致的（如角色状态、关系、事件结果）。
   - **失效的记录**：新正文里已删除的情节对应的记忆。
   - **矛盾嫌疑**：体检或已入库记忆里，有没有依赖本章被改掉内容的其它记录（如伏笔登记的埋设点、跨章引用），列出理由。
4. 若对比后发现改动完全不影响已入库记忆（纯文字润色），直接告知作者"这次修改没有触及已记录的剧情事实，无需同步"，调 `novel_checkpoint(command="sync-chapter-memory {chapter_num}", step=1, chapter=chapter_num)` 后结束。

## 步骤 2：报告与确认

把影响清单用作者词汇摆出来（哪些事实变了 / 失效 / 有无矛盾嫌疑及原因）。

然后 AskUserQuestion："确认同步记忆" / "取消"。取消 → 终止，不做任何修改。

## 步骤 3：回滚与重新提取

1. 调 `novel_rollback_chapter(chapter=chapter_num)`：清空第 {chapter_num} 章的记忆，恢复被其失效的旧事实（本命令 v1 仅支持最新完成章，此时不存在更晚的已完成章节，这一步不会波及其它章节的记忆）。失败 → 终止并报告，不得继续。
2. 派发重新提取（契约与 /narracat:rewrite 的记忆收尾一致，一次性直接提交、不经暂存）：

   ```
   Task(memory-keeper): "第 {chapter_num} 章正文经作者修改后重新入库。
   正文路径: {步骤 0 定位的正文文件路径}
   本章调 novel_commit_chapter 与 novel_submit_extraction。
   只提取正文明写的事实，不脑补。"
   ```

   若本章是其所在 arc 或卷的末章（用 `novel_get_arc(chapter=chapter_num)` 查边界），在派发中追加："本章到达 {arc|volume} {scope_id} 边界（第 {start}-{end} 章），另调 novel_consolidate 刷新该区间摘要。"

3. 调 `novel_restore_progress(chapter=chapter_num)`（作者手改正文的同步链路，进度恢复不要求机器复审）恢复第 {chapter_num} 章的完成进度（步骤 3.1 回滚时一并清空的进度状态，这一步补回，避免之后「写下一章」误把本章当作待写而覆盖正文）。
4. 调 `novel_detect_conflicts(chapter=chapter_num)` 做记忆体检。
5. 调 `novel_checkpoint(command="sync-chapter-memory {chapter_num}", step=3, chapter=chapter_num)`。

## 步骤 4：收尾汇报

告知作者：本章记忆已按新正文重新记录。如体检或步骤 1 发现矛盾嫌疑，列出章号与矛盾点，
并说明"想让正文也保持一致，可以对那一章使用重写。"不主动发起任何重写。

若步骤 3 执行了摘要重建（本章是 arc 或卷末章），另起一句告知作者："这一篇章（或卷）的内容摘要已同步更新。"

## 错误处理

| 场景 | 处理 |
|---|---|
| 章节号非正整数 | 步骤 0 报错终止 |
| 章节未完成写作 | 步骤 0 对应分支告知作者"这一章还没有完成写作，正文修改会在写作或重写时自然入库，不需要单独同步"，终止 |
| 章节非目前完成写作的最新一章（v1 范围限定） | 步骤 0 前置检查终止：如实告知作者正文修改已保存、不受影响，更早章节暂不支持同步记忆，可对该章使用重写 |
| 正文文件缺失（进度显示已完成但文件不存在） | 步骤 0 报错终止，提示记录与实际文件不一致，需人工确认 |
| 记忆回滚失败 | 终止并报告，不继续 |
| 重新提取失败（连续两次） | 先调 `novel_restore_progress(chapter=chapter_num)` 恢复进度（防止写作流覆盖正文），再终止并报告：本章记忆已清空但尚未按新正文重新记住，可直接重试本命令（进度已恢复，重试可通过前置检查） |
| 作者取消确认 | 终止，不做任何修改 |

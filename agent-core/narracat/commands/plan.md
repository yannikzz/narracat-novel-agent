---
description: 规划大纲 — 书级引擎 / 卷级与 arc / 章级细纲三层规划，按批推进
argument-hint: <创意方向或修改指令>
allowed-tools: [Agent, TaskCreate, TaskUpdate, Read, Write, Glob, AskUserQuestion, mcp__narracat_memory__novel_get_structure_budget, mcp__narracat_memory__novel_get_arc, mcp__narracat_memory__novel_get_arc_velocity_target, mcp__narracat_memory__novel_checkpoint, mcp__narracat_memory__novel_mint_character_uid, mcp__narracat_memory__novel_list_candidate_characters, mcp__narracat_memory__novel_register_candidate_character]
---

调度大纲架构师分层规划大纲。结构化产物由 outline-architect 自行调用提交工具入库，大纲文件（master-outline.md / vol-outline.md / ch-NNN.md）由提交工具机械渲染；主会话只做模式判定、Envelope 派发和回执推进，不写任何大纲文件，不直接编辑 state.yaml。

两阶段骨架：

- **阶段一**：书级引擎 + storylines + 伏笔注册表 + 卷级 + arc，经 `novel_submit_outline` 提交
- **阶段二**：按 arc 批次细化章级细纲，经 `novel_submit_chapter_outline` 提交，从最早缺失处推进

通用约定：

- VV = 卷号两位补零，NNN = 章号三位补零。
- 每个步骤完成时调用 `mcp__narracat_memory__novel_checkpoint(command="plan", step=步骤号)`，下文简写为 novel_checkpoint(step=N)。
- automation_level == "auto" 时跳过本命令所有 AskUserQuestion，按各处标注的默认项推进。
- 派发 subagent 只传路径与参数（Envelope），不复述 agent 内部规则。
- 进度与控制状态边界见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/command-progress.md`：automation_level 取值、模式判定（新建/修改/补卷/补纲）、前置检查流水账与内部步骤编号是控制状态，只用于自身分支判断，不复述进面向作者的文本，也不写进任务列表的步骤名。
- 对作者说话只用作者词汇：作者会读到的文本（对话、AskUserQuestion 问题与选项、报告）里不出现 schema 字段名 / 立项卡编号（§5）/ 文件目录名（`bible/`、`*.md`）/ 确定度英文枚举（`canon`/`tentative`/`open`）/ agent 名 / 工程黑话（落盘 / payoff_beat 等），按 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/user-facing-language.md` 翻成作者词汇（命令 `/narracat:xxx` 由 App 渲染为动作按钮，不在此列）。

## 进度跟踪

前置检查通过后，用 TaskCreate 建任务列表（步骤名用面向作者的措辞，不带内部编号）：规划全书结构 / 细化章纲 / 完成。每步开始 TaskUpdate(in_progress)，完成 TaskUpdate(completed)。进度只经任务列表表达，不另写成对话文本。

## 步骤 0：前置检查

1. Read `.narracat/config.yaml`（取 automation_level）。
2. Read `bible/premise.md`（立项卡）。文件不存在或各卡仍是空模板 → 输出「请先执行 /narracat:setup 完成立项」，终止。
3. Glob `bible/characters/*.md`。无角色文件 → AskUserQuestion：「先去 /narracat:world 创建主要角色」/「继续规划」（默认：继续规划）。选创建 → 终止。

## 步骤 1：结构预算

调 `mcp__narracat_memory__novel_get_structure_budget` 取预算表（tier、卷数、arc 跨度、storyline 预算、伏笔预算、payoff_beats 下限等）。工具报 config 缺篇幅字段 → 输出「请先执行 /narracat:setup 补齐篇幅设置」，终止。完成后 novel_checkpoint(step=1)。

## 步骤 2：模式判定

模式判定是内部分支，静默判定后直接进入对应分支，不向作者复述判定结果或 automation_level（作者需要知道的判定结论与影响在各分支内用面向作者的话表达，如「即将规划第 N 卷大纲」）。

Read `${CLAUDE_PLUGIN_ROOT}/docs/contracts/outline-planning.md`，按其 §1-§2 执行细纲扫描与最早缺失计算，然后按顺序判定：

1. `outline/master-outline.md` 不存在 → **新建**：进入步骤 3（范围按契约 §4）。
2. master-outline.md 存在，且 Read `outline/outline-structure.json` 其 `volumes` 为空数组 → **书级待展开**：全书骨架已入库、分卷尚未展开。进入步骤 3 的书级确认门（`$ARGUMENTS` 非空时作为骨架调整意见处理，不进修改分支），确认后从卷级展开继续。
3. master-outline.md 存在且 `$ARGUMENTS` 非空 → **修改**：进入步骤 3，Envelope 附修改指令。修改只作用于书级 / 卷级 / arc 结构；已渲染的章级细纲文件不会被重渲染。
4. 契约 §2 判定为补卷 → **补卷**：进入步骤 3（范围 = 下一个未规划卷）。
5. 契约 §2 有缺失章 → **补纲**：跳到步骤 4。
6. 全部完成 → 输出「全书章级细纲已完整」与进度摘要，结束。

完成后 novel_checkpoint(step=2)。

## 步骤 3：阶段一派发（Envelope）

Glob `bible/world/*.md` 与 `bible/characters/*.md` 取设定文件实际路径备用；从立项卡摘录引擎字段（某项缺失则留空，由架构师从立项卡全文推出）：

- 「中心戏剧问题」卡 → central_dramatic_question
- 「主角欲望与代价」卡的表层想要 / 深层需要 → protagonist_core_desire / protagonist_core_lack
- 「对抗力量」卡 → antagonistic_force
- 「金手指与爽点引擎」卡整卡 → golden_finger（含能力 / 限制 / 成长性 / 反馈回路 / 为何不消灭冲突；按卡的条目结构原样摘，不只摘其中一条。**反馈回路是本书的爽点节奏 spec**——小爽到什么粒度、中爽隔多久、大爽落在哪个层级，原文带出，供架构师据此编排各 arc 的爽点密度与分布）

取定速靶：调 `mcp__narracat_memory__novel_get_arc_velocity_target`，取返回的 `brief`，作为 Envelope 的「主线定速靶」一行随包投递给架构师。这是给架构师排 arc 的节奏参照，不向作者复述其数字。

取获得线锚点：从金手指卡的成长性与反馈回路两条里，摘出「尚未兑现的下一阶」——已点名但还没让主角拿到手的力量之门、下一级获得（原文摘录，两条都没点名就留空、不编造），作为 Envelope 的「主角获得线锚点」一行随包投递给架构师。

派发形态（内部分支，不向作者复述）：

- **全量**（auto 新建 / 修改 / 补卷）：按「全量派发」执行，与既有行为一致。
- **两段**（collaborative 新建）：先「3A 书级骨架」后「3B 卷级展开」。
- **书级待展开**（步骤 2 判定 2 进入）：不重新派发 3A，直接执行 3A 的回执确认门（摘要要点 Read `outline/master-outline.md` 取）；`$ARGUMENTS` 非空视为「需要调整」的调整意见，重派 3A。确认后进 3B。

**全量派发：**

```
Task(outline-architect): "【阶段一】规划全书结构并提交。
创意方向: {$ARGUMENTS，如有}
立项卡: bible/premise.md
设定文件: {上一步 Glob 得到的 bible/world 与 bible/characters 下全部 .md 路径，逐条列出}
{如 bible/reference-guidance/structure.md 存在: 参考指导: bible/reference-guidance/structure.md}
引擎字段（摘自立项卡）:
- central_dramatic_question: {...}
- protagonist_core_desire: {...}
- protagonist_core_lack: {...}
- antagonistic_force: {...}
- golden_finger（金手指与爽点引擎整卡，含反馈回路 = 本书爽点节奏 spec）:
{第 3 卡各条目原文，逐条列出：能力 / 限制 / 成长性 / 反馈回路 / 为何不消灭冲突}
主线定速靶（同类头部节奏参照，据此排 arc、别让主线长期停靠）: {novel_get_arc_velocity_target 的 brief}
主角获得线锚点（金手指尚未兑现的下一阶——这是立项时许给读者的糖，覆盖当前细纲窗口的 arc 里要排上它的实质推进与获得型爽点，别只登记成远期伏笔）: {从金手指卡成长性/反馈回路摘出的原文，无则省略本行}
预算表:
{novel_get_structure_budget 返回原文}
范围: {按预算表 tier——非 XL: 全书全部卷；XL: 书级 + 第一卷 | 补卷: 仅新增第 {V} 卷，书级与已有卷透传不改 | 修改: 按创意方向调整后整体重新提交}
完成后调 novel_submit_outline 提交，返回提交回执摘要。"
```

回执处理：

- 架构师返回提交回执（文件渲染与数据入库由提交工具完成，主会话不重复校验）。
- 向用户展示摘要：卷数 / 总章数 / storylines 条数 / 伏笔条数。
- AskUserQuestion：「确认结构，继续细化章纲」/「需要调整」（默认：继续）。调整 → 收集意见，重派发本步骤（Envelope 附调整意见）。
- novel_checkpoint(step=3)，进入步骤 4。

**3A 书级骨架（collaborative 新建）：**

```
Task(outline-architect): "【阶段一·书级骨架】只规划书级并提交，不展开卷级与 arc。
创意方向: {$ARGUMENTS，如有}
立项卡: bible/premise.md
设定文件: {Glob 得到的全部 .md 路径，逐条列出}
{如 bible/reference-guidance/structure.md 存在: 参考指导: bible/reference-guidance/structure.md}
引擎字段（摘自立项卡）: {同全量派发的引擎字段块}
主线定速靶（同类头部节奏参照）: {novel_get_arc_velocity_target 的 brief}
主角获得线锚点: {同全量派发，无则省略本行}
预算表:
{novel_get_structure_budget 返回原文}
范围: 仅书级——引擎字段 + 故事线 + 伏笔注册表，不含分卷。
完成后调 novel_submit_outline（scope="book"）提交，返回提交回执摘要。"
```

回执处理（书级确认门）：

- 向作者展示：中心戏剧问题一句话、故事线条数、伏笔条数，并告知「全书骨架已写入大纲页，可在工作台直接查看；个别条目可直接修改，改完回来选确认」。
- AskUserQuestion：「确认骨架，展开分卷」/「需要调整」（默认：确认）。调整 → 收集意见，重派 3A（Envelope 附调整意见）。
- 确认后进入 3B。

**3B 卷级展开：**

```
Task(outline-architect): "【阶段一·卷级展开】读已确认的全书骨架，展开卷级与 arc 并提交。
全书骨架: outline/master-outline.md（书级已确认入库，以此为准，不重产、不改写书级内容）
立项卡: bible/premise.md
设定文件: {上一步 Glob 得到的 bible/world 与 bible/characters 下全部 .md 路径，逐条列出}
金手指与爽点引擎（摘自立项卡，含反馈回路 = 本书爽点节奏 spec，据此编排各 arc 的爽点密度与分布）:
{第 3 卡各条目原文，逐条列出：能力 / 限制 / 成长性 / 反馈回路 / 为何不消灭冲突}
主线定速靶（据此排 arc、别让主线长期停靠）: {novel_get_arc_velocity_target 的 brief}
主角获得线锚点（覆盖当前细纲窗口的 arc 里要排上实质推进与获得型爽点）: {同全量派发，无则省略本行}
预算表:
{novel_get_structure_budget 返回原文}
范围: {按预算表 tier——非 XL: 全书全部卷；XL: 第一卷}
完成后调 novel_submit_outline（scope="volumes"，payload 只含 volumes）提交，返回提交回执摘要。"
```

回执处理：

- 向作者展示摘要：卷数 / 总章数 / 故事线条数 / 伏笔条数。
- AskUserQuestion：「确认结构，继续细化章纲」/「需要调整」（默认：继续）。调整 → 收集意见，重派 3B（Envelope 附调整意见；卷级整体重排，书级不动）。
- novel_checkpoint(step=3)，进入步骤 4。

## 步骤 4：阶段二窗口（earliest-missing + 叙事断点）

剧情驱动的章窗口懒生成：派发单位是从最早缺失章 `start` 起、收口于一个叙事断点的章区间，不再按整 arc 整卷前置。约束（起点固定 / 最小前瞻窗口 / 单窗口即收口 / 不覆盖）见契约 §2-§3。**本次运行只推进 `[start, target]` 一个窗口：`target` 之外的章一律不派发、不细化，窗口完成后直接进步骤 5（作者要继续，会再次运行本命令）。**

Glob `bible/characters/*.md` 取角色档案实际路径备用（pov_character 与章级 characters 角色引用的 `character_uid` 来源）。

1. 按契约 §2 取最早缺失章 `start` 与 earliest_arc：`mcp__narracat_memory__novel_get_arc(chapter=start)`。
2. **auto 档**：不派发断点候选，`target` 由主会话按契约 §3 的机械规则算出（arc 闭合章、不足最小前瞻窗口时顺延，含规划末尾的接受语义）。算完跳过第 3 条，直接进第 4 条派发窗口。
3. **collaborative 档·取断点候选**：派发 outline-architect 让其读结构化大纲，从 `start` 起算出若干「产到第 N 章（断点理由）」候选（各满足最小前瞻窗口）：

```
Task(outline-architect): "【阶段二·断点候选】只规划本次细化窗口的收口断点，不要细化章纲、不提交。
全书大纲: outline/master-outline.md
最早缺失章: {start}
从该章起，按结构化大纲的故事线入场/收线、伏笔埋设/兑现章、payoff_beats 兑现点、arc 闭合，列出最近的 3-4 个叙事断点候选（升序），每个给：目标章号 + 一句剧情理由；各候选跨度不得短于最小前瞻窗口（5 章），已到规划末尾、剩余章不足 5 章时以规划末章为候选。返回候选清单，不调用任何提交工具。"
```

   选定：AskUserQuestion，选项标题用人读中文「产到第 {N} 章 · {断点理由}」（候选逐项），另加「暂不细化」；暂不细化 → 跳到步骤 5。

4. **派发窗口**：窗口 `[start, target]` 按 arc 切分逐段派发（一次一段，前一段回执确认后再派下一段；单段不超过工具的 ≤4 arc 上限，跨更多 arc 自然拆成多段）。

   **每段派发前·新角色处置**：若本段 arc 需要尚未建档的角色（架构师上一批回执报告「尚无角色档案 / 缺 UID」，或与用户讨论中提到的新人），按 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/new-character-intake.md` 逐个处置（建 stub / 留候选带 importance / 别名归一；plan 来源是有意写进大纲的角色，不当龙套跳过），source 用 `plan`。留作候选的角色本批不进章细纲的 `pov_character` / `characters`（候选不强制建档）。

   每段：

```
Task(outline-architect): "【阶段二】为第 {seg_start}-{seg_end} 章（属 arc {arc_id} 等）细化章级细纲并提交。
全书大纲: outline/master-outline.md
卷级大纲: outline/vol-{VV}/vol-outline.md
角色档案: {上一步 Glob 得到的 bible/characters 下全部 .md 路径，逐条列出；为空则说明尚无角色档案、停下报告不编造 UID}
本段所属 arc 三件套与 payoff_beats:
{逐 arc 列出 core_question / irreversible_change / next_arc_seed / payoff_beats}
{如区间内已有细纲文件: 已存在细纲章（提交时渲染会跳过，照常产出其数据即可）: {章号列表}}
完成后调 novel_submit_chapter_outline 提交本段全部章，返回提交回执摘要。"
```

5. 某段失败 → 按契约 §3：保留已成功段的产物，AskUserQuestion 重试该段或停止（默认：停止并报告）。
6. 窗口完成 → novel_checkpoint(step=4)。窗口即本次规划的全部范围——不重算最早缺失章、不继续下一个 arc，直接进入步骤 5。

## 步骤 5：完成输出

- 摘要：全书结构（卷数 / 总章数）、本次细化范围、累计已细化章数 / 总章数。
- 下一步建议：仍有缺失章 →「继续 /narracat:plan 细化下一批」或「/narracat:write {最早未写章号}」；全部细化 →「/narracat:write 1」。
- novel_checkpoint(step=5)。

## 错误处理

| 场景 | 处理 |
|---|---|
| 立项卡缺失 / 空模板 | 步骤 0 提示先 /narracat:setup，终止 |
| config 缺篇幅字段 | 步骤 1 提示先 /narracat:setup，终止 |
| 架构师提交重试超限 | 展示其报告的失败字段与原因，建议人工检查后重跑 /narracat:plan |
| 窗口分段部分失败 | 契约 §3：保留已成功段产物，询问重试或停止 |
| NovelMemory 不可用 | 报错并建议检查 MCP 连接 |

---
description: 管理世界观和角色 — 创建、查看、修改设定
argument-hint: <操作描述，如"创建主角"、"主角+反派+力量体系一起立项">
allowed-tools: [Agent, Read, Write, Edit, Glob, Grep, AskUserQuestion, mcp__narracat_memory__novel_checkpoint, mcp__narracat_memory__novel_mint_character_uid, mcp__narracat_memory__novel_list_candidate_characters, mcp__narracat_memory__novel_register_candidate_character]
---

调度世界观策展人合成角色档案、世界观设定、关系图谱。一次对话可以同时立项多个对象（如主角 + 反派 + 力量体系），最后一并落盘。

步骤 3、4、5、6 各自完成后调用 `novel_checkpoint`（command: "world"，step: 步骤号）。

**对作者说话**：你内部用精确的字段 / 文件 / 工具 / agent 名保证引擎正确，但作者会读到的文本（对话叙述、AskUserQuestion 的问题与选项、报告正文）里不出现内部标识——schema 字段名（如 `antagonistic_force`）、立项卡编号（`§5`/`§7`）、文件 / 目录名（`bible/`、`*.md`）、确定度英文枚举（`canon`/`tentative`/`open`）、agent 名（`world-curator` 等）、工程黑话（落盘 / blocking / payoff_beat 等）一律翻成作者词汇，信息全留、黑话全译。对照表见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/user-facing-language.md`（命令 `/narracat:xxx` 由 App 渲染为动作按钮，不在此列）。

## 步骤 0: 前置检查

读取 `bible/premise.md`：
- 文件不存在（项目未初始化）→ 提示先运行 /narracat:init，终止。
- 内容仍是空模板（只有占位符）→ AskUserQuestion："核心前提未填写，角色设计缺少故事根基。" 选项：**先去运行 /narracat:setup**（终止本命令）/ **继续创建**。

## 步骤 1: 意图解析

从 $ARGUMENTS 判断操作：
- **view**（查看角色列表 / 关系 / 某项设定）→ 直接 Read 相关文件展示，终止。
- **update**（修改已有角色 / 设定）→ 定位对应 bible/ 文件；不存在则提示未找到、建议改为创建。直接进步骤 3。
- **create**（创建角色 / 设定，可一次多个）→ 进步骤 2。

## 步骤 2: 对话采集（仅 create）

和用户对话弄清这次要立项什么：

- $ARGUMENTS 已足够动笔 → 不追问，直接进步骤 3。
- 能推出的不问：用户已说过的、能从立项卡或题材常识可靠推出的，直接写进草案，留到确认环节核对；只追关键处，推不出又不关键的留白交给策展人。
- 一次只问一个问题，且必须问具体创作内容（某个设定本身怎么定），不问「你想怎么说 / 先说哪个 / 要不要补充」这类流程问题——流程由你安排，直接从最重要的对象问起，并永远附上你自己的推荐答案（用户回「按你说的」即采纳）。
- 用户给抽象标签或说不上来时，不反问偏好：基于已知信息直接给出 2-3 个差异化的具体方案让他挑或改，用户回「按你说的」即采纳。
- 用户说「直接帮我定」或类似表述 → 立即停止提问，带现有信息进步骤 3。
- 多个对象（主角、反派、体系…）在同一场对话里聊清，一起带进步骤 3。
- AskUserQuestion 只用于真正的关键取舍（两三个方向不可兼得）；开放问题用普通对话问，同样附你的推荐。

## 步骤 3: 派发 world-curator（合成）

先 Glob `bible/world/*.md` 与 `bible/characters/*.md` 取实际路径，`bible/relationships.md` 存在则一并计入，全部逐条列进下面的「既有设定文件」——策展人只读派发指令列出的路径（子会话不共享本会话上下文），漏列的设定就不在冲突检测的比对范围内。create 与 update 都要枚举：新对象同样会撞上既有关系与世界规则。立项卡另有专门一行，不并入这份清单。

一次 Task 调用覆盖本次全部对象，world-curator 只做内容合成与冲突检测，不落盘、不调用提交工具：

```
Task(world-curator): "操作: {create | update}
对象（每个一句话意图）:
- {对象 1: 意图}
- {…}
用户对话中确认的要点: {步骤 2 采集结果，无则省略}
立项卡: bible/premise.md
既有设定文件: {上一步枚举得到的全部路径，逐条列出}
状态词表: {bible/state-vocabulary.json 存在则传路径，否则省略}
参考指导文件: {bible/reference-guidance/ 下存在的 premise.md / world.md / characters.md 路径，无则省略}
返回: 每个对象的完整 bible 内容（标注目标文件路径）+ conflicts[] + 状态词表草案（对象中含角色时）+ 每个核心角色的结构化字段草案（name/aliases/gender/age/initial_states，对象中含角色时）"
```

## 步骤 4: 确认门

展示 world-curator 返回的全部内容，再按 severity 处理 conflicts[]（结构与判级见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/world-guided.md` §二）：

**4.1 有 blocking → 逐条 AskUserQuestion**，每条单独问：

- 问题："设定冲突：{new_claim} 与既有 {existing_fact}（{source}）矛盾，如何处理？"
- 选项：
  - **改这项** — 回步骤 3 让 world-curator 按既有设定只重做该项
  - **覆盖既有设定** — 保留本次主张，写入时标注覆盖
  - **取消该项** — 该项不写入

**4.2** warning 展示提醒、info 一行带过，都不阻断。

**4.3** blocking 全部处理完（或本就没有）→ AskUserQuestion："确认保存" / "需要调整"。选调整 → 带用户意见回步骤 3。

conflicts[] 缺失或无法解析 → 跳过 4.1/4.2，直接走 4.3。

## 步骤 5: 写入 bible/

按确认结果用 Write/Edit 落盘：

- 角色 → `bible/characters/{name}.md`
- 世界设定 → `bible/world/{topic}.md`
- 关系 → 追加到 `bible/relationships.md`

角色档案的身份锚点：每个角色文件标题下紧跟一行 `<!-- character_identity: {"character_uid":"...","name":"角色名","profile_stage":"..."} -->`。`profile_stage` 标完善度（stub / sketch / full，阶梯见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/new-character-intake.md` 第〇节）。

- create 的角色：落盘前先 `novel_list_candidate_characters(status="all")` 按 `name` 查候选池——命中则**复用**该候选行的 `character_uid`，不另铸（建档与候选必须同一 UID，否则 promote 回写会落新行、原候选行滞留池中导致身份分裂）；未命中才调 `novel_mint_character_uid` 铸新 UID。取得的 `character_uid` 填入身份注释行；本命令产出完整六维度档案，`profile_stage` 写 `full`（维度有「（留白）」则写 `sketch`）。
- update 的角色（含写作期来的 stub 深化）：先 Read 既有文件，原样保留其 `character_uid` 与 `name`，不重新生成 UID；按本次补全程度把 `profile_stage` 升级（stub→sketch→full，只升不降，缺该字段的旧档按 full 视之）。
- 若建档/深化的角色登记在候选池（create 命中候选、或 update 深化 stub），写入后调 `novel_register_candidate_character(name=..., character_uid=..., status="promoted")` 把它从候选清单淡出（character_uid 用上面复用/保留的同一个）。
- 候选命中时，该候选行的 `initial_relationships`（`novel_list_candidate_characters` 返回字段，[{other_character_uid, state}]）非空则一并落实：每条把 `other_character_uid` 解析为对应已建档角色名（读其档案 character_identity），把关系状态写进本角色档案的关系维度，并追加到 `bible/relationships.md`。无 initial_relationships 则跳过。

步骤 4 取消的项不写入；选「覆盖既有设定」的项在该处标注「⚠️ 覆盖既有设定: {existing_fact}」。

角色对象且步骤 3 返回了状态词表 / 结构化字段草案 → 本步确定的 `character_uid`（复用或新铸）连同 name、aliases、gender、age、effective_chapter、initial_states 一并交给步骤 6；无角色对象或用户在步骤 4 全部取消，跳过步骤 6。

## 步骤 6: 派发 world-curator（结构化提交，仅角色对象时）

第二次 Task 调用，只传已确认、已定 UID 的清单，专职调用 `novel_submit_state_vocabulary` / `novel_submit_character_entity` 完成结构化半边落盘：

```
Task(world-curator): "操作: 结构化提交
状态词表: {步骤 3 草案经步骤 4 确认后的 payload}
已确认角色:
- character_uid: {...} / name: {...} / aliases: {...} / gender: {...} / age: {...} / effective_chapter: {...} / initial_states: {...}
- {…}
返回: 提交结果（facts_written / warnings）"
```

`effective_chapter` 取值：候选转正取候选行 `proposed_chapter`（`novel_list_candidate_characters` 可查）或实际首次出场章；建书期新角色省略（默认 0）。

## 错误处理

| 场景 | 处理 |
|---|---|
| 未提供 $ARGUMENTS | AskUserQuestion 询问要做什么操作 |
| world-curator 返回失败或为空 | 报告错误，建议重试 |

---
description: 写章节 — 核心创作循环（上下文聚合 → 正文生成 → 审校 → 入库收尾）
argument-hint: <章节号>
allowed-tools: [Agent, TaskCreate, TaskUpdate, Read, Write, Glob, AskUserQuestion, mcp__narracat_memory__novel_build_writing_context_pack, mcp__narracat_memory__novel_get_review, mcp__narracat_memory__novel_get_arc, mcp__narracat_memory__novel_check_manuscript_contract, mcp__narracat_memory__novel_check_prose_hygiene, mcp__narracat_memory__novel_check_state_delivery, mcp__narracat_memory__novel_query, mcp__narracat_memory__novel_character_state, mcp__narracat_memory__novel_update_progress, mcp__narracat_memory__novel_checkpoint, mcp__narracat_memory__novel_mint_character_uid, mcp__narracat_memory__novel_list_candidate_characters, mcp__narracat_memory__novel_register_candidate_character, mcp__narracat_memory__novel_stage_extraction, mcp__narracat_memory__novel_commit_extraction_union, mcp__narracat_memory__novel_detect_conflicts]
---

完成一个章节的完整写作流程。

通用约定：

- 每个步骤完成时调用 `mcp__narracat_memory__novel_checkpoint(command="write", step=步骤号, chapter=chapter_num)`，下文简写为 novel_checkpoint(step=N)。
- 派发 subagent 只传章号、路径与参数，不复述 agent 内部规则。
- 不要直接编辑 state.yaml：断点经 novel_checkpoint 写入，进度经 novel_update_progress 写入。
- 上下文包、正文、细纲的路径一律使用步骤 1 工具返回的 pack_path / manuscript_path / outline_path，不自行拼路径。
- 进度与控制状态边界见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/command-progress.md`：automation_level 取值、断点恢复的内部状态、内部步骤编号是控制状态，不复述进面向作者的文本，也不写进任务列表的步骤名。
- 对作者说话只用作者词汇：作者会读到的文本（对话、AskUserQuestion 问题与选项、报告）里不出现 schema 字段名 / 立项卡编号（§5）/ 文件目录名（`bible/`、`*.md`）/ 确定度英文枚举（`canon`/`tentative`/`open`）/ agent 名（`builder` / `world-curator` 等）/ 工程黑话（落盘 / payoff_beat / warnings 等），按 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/user-facing-language.md` 翻成作者词汇（命令 `/narracat:xxx` 由 App 渲染为动作按钮，不在此列）。

## 进度跟踪

前置检查通过后，用 TaskCreate 建任务列表（步骤名用面向作者的措辞，不带内部编号）：上下文聚合 / 正文生成 / 审校 / 入库收尾。每步开始 TaskUpdate(in_progress)，完成 TaskUpdate(completed)。进度只经任务列表表达，不另写成对话文本。

## 步骤 0：前置检查

1. chapter_num = $ARGUMENTS，必须为正整数，否则报错并终止。
2. Read `.narracat/config.yaml`（取 automation_level）与 `.narracat/state.yaml`（取 progress.completed_chapters、checkpoint）。
3. chapter_num > 1 且 chapter_num-1 不在 progress.completed_chapters → 输出「请先完成第 {chapter_num-1} 章，或执行 /narracat:write {chapter_num-1}」，终止。
4. chapter_num 已在 progress.completed_chapters → 输出「第 {chapter_num} 章已完成。如需修改请执行 /narracat:rewrite {chapter_num}」，终止。

（细纲缺失或本章未规划时，步骤 1 的 builder 会返回带引导的错误，无需在此预查。）

### 断点恢复

若 checkpoint.last_command == "write {chapter_num}"：

- AskUserQuestion：「检测到第 {chapter_num} 章中断于步骤 {last_step}。继续，还是从头开始？」
- 继续 → 先执行步骤 1（builder 幂等，重建上下文包并取回各路径），再跳到步骤 {last_step} 的下一个步骤继续；last_step == 3 时不直接进步骤 4，先重新调一次 `mcp__narracat_memory__novel_check_manuscript_contract(chapter=chapter_num)`：`ok == true` 才进步骤 4，`ok == false` 按 3c 的补写流程处理（复检上限 2 轮，仍不过则终止并报人工处理）；last_step == 6 时直接执行步骤 6 第 4 点完成收尾。
- 从头 → 从步骤 1 开始。

## 步骤 1：上下文聚合

1. 调 `mcp__narracat_memory__novel_build_writing_context_pack(chapter=chapter_num)`。
2. 返回 ok → 上下文包已由工具落盘。记下返回的 pack_path、manuscript_path、outline_path 与 word_count_range，后续步骤直接引用。
3. 返回错误 → 原样输出 errors，终止。
4. novel_checkpoint(step=1)。

正文路径由工具返回，写作期间指向草稿区；主会话与 subagent 一律用返回的 manuscript_path，不自行拼路径。

## 步骤 2：确认（仅协作模式）

automation_level == "auto" 时跳过本步骤；**其余情况一律走确认门**（含 `.narracat/config.yaml` 里没有这个字段——缺省即协作，与 plan.md 同向）：向用户摘要本章细纲要点与上下文准备时的提醒，AskUserQuestion「开始写作」/「取消」；取消 → 终止。完成后 novel_checkpoint(step=2)。

## 步骤 3：正文生成

### 3a 压缩任务书

主会话亲自执行（不派发）：

1. Read {pack_path}。再 Read `${CLAUDE_PLUGIN_ROOT}/skills/novel-web-craft/SKILL.md`（写法素材库）；包里有 `craft_pack_hints` 时逐个 Read 其 reference_path，与本章故事线或场景意图不符的 pack 丢弃，并记一行丢弃理由留到完成输出。
2. 补齐包内缺口。补查结果只写进任务书，不回写包：
   - 包里有 `characters_without_cards` 时**逐个**按条目上的 `character_uid` 调 novel_character_state 补查，把状态翻成人话补进任务书第三段。这些是本章出场、但状态卡没随包给出的角色（预算裁掉或尚无记录）——写手只读任务书，这一步不补，第三段就少人，写手只能自己编。
   - 其余缺口（场景涉及的旧事件只有一句摘要等）用 novel_query / novel_character_state 补查。
3. 按下面的五段结构，把包与素材翻译成一份自然语言任务书，Write 到 `.narracat/staging/ch-{三位章号}.brief.md`（三位补零，完整文件名形如 `ch-004.brief.md`——章号段与正文一致，后缀不同，别写成正文的 `ch-004.md`）。铁律：
   - 任务书是写手唯一的剧情输入，细纲信息如实全量承载——翻译成人话，不减料、不降级。
   - 不减料指事件、因果与信息点。细纲里预写的演法（比喻、生理反应、感官描写的具体写法）不搬运——把它还原成事件和这一拍要打出的效果，怎么演由写手定。两分判据：删掉后这场戏仍成立的是演法；删掉戏就断的（承载功能的动作、道具、关键台词）是必须落地的细节，原样保留。
   - 任务书里不得出现字段名、工具名、pack 名、伏笔编号、英文确定度枚举等系统词——写手读到的必须是纯人话（机械检查会拦下命中项：被打回就按提示改写后重新 Write 一次；第二次仍命中会放行，把警示留到完成输出）。
   - `warnings` 里影响本章的项翻译成自然语言提醒写进对应段落，其余丢弃。
   - 第四段是**给这一章的**写法指示，不是通用写作原则的转述。素材库条目、persona 手感、本书声音都要落到「这一章的哪一段、怎么写」——写成通用原则时写手只当灵感参考，指名到本章场景才会照做。其中两件事每章都要点名到具体段落说清楚：**①哪里该展开、哪里该收**（心里绕弯子、算账、铺关系的地方敢用长句一口气把因果和情绪交清楚；要砸的地方再收短）**②这一章的对白怎么给**（谁跟谁说、几句关键台词各是什么调门、说话人怎么交待、哪句台词底下藏着别的意思）。
   - 第四段里**不许出现句长处方**（「短句」「段落实短」「描写精简」这类）：本书声音里的节奏诉求翻成钩子密度、场景切换速度、对白占比来表达。

任务书五段结构：

```
# 第{N}章任务书

## 一、这次委托
《{书名}》第 {N} 章「{章标题}」。一句话目标：{本章定位}。字数 {下限}-{上限} 字。

## 二、这章的故事
{前情：上一章讲到哪、悬着什么，一到三句}
上一章结尾原文（开头要接住这里的情绪和悬着的东西；句子怎么断、写多长按这一章的需要来）：
> {前章逐字结尾}
{场景节拍逐条翻成人话：谁在哪、发生什么、这一拍要打出什么；必须落地的爽点/事件点明}
{伏笔动作翻成人话：这一章要让读者注意到什么 / 揭开什么，制造期待不剧透}

## 三、这章的人物
{每人一段：现在的状态、TA 想要什么、这一章 TA 的作用；有语言指纹就写明说话的样子}

## 四、怎么写更顺
本书语感（照这个感觉写，学语感、不抄内容）：
> {本书样章段落}
{书的声音与说话方式，翻成两三句描述}
{选中 pack 的精髓翻成 2-3 条针对本章的写法要求}
{这一章哪里该展开、哪里该收：点名到具体段落说}
{这一章的对白怎么给：谁跟谁说、几句关键台词各是什么调门（冲/堵/虚/噎住/故意压平）、让读者看得见谁在开口；每轮对白至少推进一件事，嘴上说的和真正想说的差在哪}
这一章的心跳节拍在：{点名 1-2 处该打出强度的段落}。演出来，不许总结；宁可过头，不许收着。

## 五、收在哪里
{章末停在什么画面 / 什么未完成的感觉，钩子指向哪里；人物的实际动作与去向照章纲收尾节拍，不改写}
```

### 3b 热写

派发：

```
Task(chapter-writer): "撰写第 {chapter_num} 章。
任务书路径: {brief 路径}
输出路径: {manuscript_path}
目标字数区间: {word_count_range 的下限}-{word_count_range 的上限} 字"
```

- 写手报告任务书不可用或「细纲不可写」→ 向用户转述报告，建议执行 /narracat:plan 重新细化本章，终止。

**新角色处置**：写手在正文里引入了上下文包既有角色清单之外的角色时，按 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/new-character-intake.md` 逐个处置（先判重要度：龙套跳过 / 建 stub / 留候选带 importance / 别名归一），source 用 `write`。建 stub 的角色入库收尾时 memory-keeper 才能为其解析 UID；留作候选与龙套的角色不写入本章 `characters_appeared`。本步在审校前完成，避免出场角色缺 UID 卡住收尾。

### 3c 机械门

1. 调 `mcp__narracat_memory__novel_check_manuscript_contract(chapter=chapter_num)`（工具会顺手把 ASCII 引号包中文机械归一为弯引号，主会话无需处理）。
2. `ok == false` → 派写手按 errors 补写/清理（下面模板），复检上限 2 轮；2 轮仍不过 → novel_checkpoint(step=3)，输出 errors 并报告「第 {chapter_num} 章正文未达交付合同，请人工处理后重新执行 /narracat:write {chapter_num}」，终止。

```
Task(chapter-writer): "第 {chapter_num} 章正文有下列交付问题，逐条补写或清理，保留其余正文。
正文路径: {manuscript_path}
任务书路径: {brief 路径}
问题清单（逐条处理）:
{errors 逐条 field + hint}"
```

3. 合同过后调 `mcp__narracat_memory__novel_check_prose_hygiene(chapter=chapter_num)`，把返回的 errors（若有）、fingerprint_findings 与 shape_findings 全量留给 3d——不派发擦除、不在本步处置。

### 3d 冷 pass（唯一改稿位）

派发（**必须带 `thinking="off"`**：冷改是低自由度任务——输入是完整正文、只做打磨，模型的"思考"在这里不产生价值。真机 A/B 实测两臂产出相似度 98.7%、54 处差异全是采样抖动，而思考白烧掉单次约 87% 的输出预算。热写那一遍相反，不要加这个参数）：

```
Task(chapter-writer, thinking="off"): "对第 {chapter_num} 章成稿做一遍冷改打磨，按下面四遍依次处理，改完把整章覆写回正文路径。
正文路径: {manuscript_path}
任务书路径: {brief 路径}（第四段是本书语感基准）
第一遍·擦机器腔：下面的机械扫描结果是排序线索，不是要归零的指标——按命中密度从高到低处置，读上下文，是机器腔就换成这本书的说法，是正常人话就保留：
{3c 洁净扫描的 errors 与 fingerprint_findings 逐条：词 / 次数 / 密度 / 改写方向}
第二遍·松句子：下面是机械量出来的句段形状，逐条按提示到那一段去看，是形状问题就改，本来就该那样就放着：
{3c 洁净扫描的 shape_findings 逐条：label / detail / hint；无命中时省略本行，仍执行下面四件事}
不靠扫描结果、这一遍还要自己过一遍这四件事：
（1）主干早点来——先让做事的人和动作出现，时间、原因、条件、例子接到后面；读到名词时已经忘了句首的句子重写。
（2）该长的地方缝回去——心里绕弯子、算账、铺关系的句子被切成三截的，缝成一句把因果和情绪一并交清楚；短句留给真要砸的落点。
（3）动作后面少解释一句——人物把门打开又关上，后面不用再来一句「他犹豫了」；读者已经能看见的情绪，删掉那句解释。
（4）拆掉只是好看的句子——单独摘出来很漂亮、放回正文却没多给一件事实、一个动作或一层情绪的句子，删掉；没有来路也不影响后文的装饰性细节（天气、摆设、神态），一起删。
第三遍·缝接缝：通读全文，修指代悬空、没头没尾的反应句、前后语气突变、场景过渡生硬；开头与任务书引用的上一章结尾原文要接得上。
第四遍·补火力：对照任务书点名的心跳节拍，哪里弱了就地重写到「演出来」的强度——只加火力，不改剧情事件、人物名字与去向、不改章末停住的画面。章末已经让读者感到什么，就不要再让叙述者出来把主题总结一遍。"
```

冷 pass 完成后重调一次 `novel_check_prose_hygiene(chapter=chapter_num)` 复扫留档：指标劣化或仍超硬线 → 记下 message 留到完成输出，**不再追加改稿轮**（步骤 5 的审校修复是唯一例外）。然后 novel_checkpoint(step=3)。

## 步骤 4：审校

派发：

```
Task(continuity-editor): "审校第 {chapter_num} 章。
正文路径: {manuscript_path}
WritingContextPack 路径: {pack_path}"
```

审校 agent 完成后，主会话调 `mcp__narracat_memory__novel_get_review(chapter=chapter_num)` 取 `{verdict, blockers}`，然后 novel_checkpoint(step=4)。审校报告文件由工具渲染，主会话不读、不解析报告文本。

## 步骤 5：审校路由

- verdict == "pass" → novel_checkpoint(step=5)，进入步骤 6。
- verdict == "fail"（首次）→ 定向修复一次（任务书文件不存在时——升级前的旧中断——派发中省略「任务书路径」一行）：

```
Task(chapter-writer): "修复第 {chapter_num} 章的下列问题。只修改问题涉及的段落，保留其余正文，不整章重写。
正文路径: {manuscript_path}
任务书路径: {brief 路径}
问题清单（逐条处理）:
{blockers 原样逐条列出}"
```

  修复完成后重新执行步骤 4，复审派发末尾追加一句：「只复验下列已修复问题: {blockers 原样逐条列出}」。

- 复审后 verdict == "pass" → 修复动作已改过正文，进入步骤 6 前重新调一次 `mcp__narracat_memory__novel_check_manuscript_contract(chapter=chapter_num)`：`ok == true` → novel_checkpoint(step=5)，进入步骤 6；`ok == false` → 按 3c 的补写流程处理（复检上限 2 轮；仍不过 → novel_checkpoint(step=3)，输出 errors 并报告「第 {chapter_num} 章正文未达交付合同，请人工处理后重新执行 /narracat:write {chapter_num}」，终止）。
- 复审后 verdict 仍 == "fail"（修复轮上限 1，已用完）→ 调 novel_checkpoint(step=3)（把断点退回「正文已生成」，下次恢复将从步骤 4 重新审校），输出 blockers 清单并报告：「第 {chapter_num} 章经一轮定向修复仍未通过审校，请人工处理后重新执行 /narracat:write {chapter_num}」，终止。

## 步骤 6：入库收尾

1. 调 `mcp__narracat_memory__novel_get_arc(chapter=chapter_num)`，取返回的 is_arc_end / is_volume_end 与 arc、volume 信息（found == false 时按非边界处理）。
2. 并行派发（四个任务可同时执行，互不依赖）：

```
Task A-1（memory-keeper）: "第 {chapter_num} 章事实暂存。
run_id: 1
正文路径: {manuscript_path}
细纲路径: {outline_path}"

Task A-2（memory-keeper）: "第 {chapter_num} 章事实暂存。
run_id: 2
正文路径: {manuscript_path}
细纲路径: {outline_path}"

Task A-3（memory-keeper）: "第 {chapter_num} 章事实暂存。
run_id: 3
正文路径: {manuscript_path}
细纲路径: {outline_path}"

Task B（memory-keeper）: "第 {chapter_num} 章收尾入库。本任务不做事实抽取——本章的事实由并行的三个暂存任务负责，不要调抽取脚手架、不要暂存事实。
正文路径: {manuscript_path}
细纲路径: {outline_path}
{is_arc_end == true 时追加: 本章为 arc {arc_id}（第 {chapter_start}-{chapter_end} 章）末章，入库后需提交该 arc 的压缩摘要。}
{is_volume_end == true 时追加: 本章为第 {volume_no} 卷末章，入库后需提交该卷的压缩摘要。}"
```

3. 四个任务全部完成后，主会话调 `mcp__narracat_memory__novel_commit_extraction_union(chapter=chapter_num)`，把各轮暂存的事实合并落库。看返回的 `staged_runs`：
   - `staged_runs == 0`（三轮抽取均未暂存，疑似全部失败）→ **不进入第 4 点**：调 novel_checkpoint(step=3)（退回正文已生成），向用户报告「第 {chapter_num} 章事实抽取全部失败、本章未沉淀事实，请重试 /narracat:write {chapter_num}」，终止。
   - `1 ≤ staged_runs < 3` → 正常落库，向用户附一句「本章仅 {staged_runs} 轮抽取成功，事实样本偏少」提示后继续。
   - `staged_runs == 3` → 正常继续。
4. （staged_runs ≥ 1 时）调 `mcp__narracat_memory__novel_check_state_delivery(chapter=chapter_num)` 做计划状态变更兑现比对（机械匹配，命中项自动落账）：若返回的 `undelivered` 非空，保留待「完成输出」呈现，不阻断收尾、不自动顺延（处置交用户）。
5. 调 `mcp__narracat_memory__novel_detect_conflicts(chapter=chapter_num)` 对刚落库的事实做生成后时序 / 状态冲突体检（只读、只标不改）：若 `conflict_count > 0`，保留返回的 `report` 待「完成输出」呈现，不阻断收尾、不自动改记忆（修订交用户）。然后 novel_checkpoint(step=6)，再调 `mcp__narracat_memory__novel_update_progress(chapter=chapter_num)` 更新进度并清除断点。

novel_update_progress 会先核对交付合同并把草稿区正文原子搬进正式路径；返回 manuscript_contract 类错误时退回步骤 3 处理。

## 完成输出

一行汇报：「第 {chapter_num} 章完成。」并附下一步建议：/narracat:write {chapter_num+1}。协作模式可另附上下文准备时的提醒与审校 note 条数。

若步骤 6 的 novel_detect_conflicts 检出冲突（conflict_count > 0），另起一段原样呈现其 `report`，标明为待人工确认的潜在时序 / 设定矛盾（只标注、未改动记忆，可执行 /narracat:revise-premise 或后续 /narracat:rewrite 修订）。

若步骤 6 的 novel_check_state_delivery 返回 `undelivered` 非空，另起一段逐条列出未兑现的计划状态变更（角色 / 维度 / 目标值 / 缘由），标明为章纲计划与正文记忆的差异提醒：可能是正文写了但抽取漏了，也可能是剧情自然后移——只提醒不阻断，可在角色页时间线补录，或在章纲卡上调整该计划。

若 3d 复扫仍有残留机械腔提示，另起一行附上残余提示的原文说明（已收尾、不阻断）。

若字数超出目标上限或引号提醒非空，另起一句用作者能懂的话附上。

若压缩任务书时有与本章不相关而未采用的写法参考，另起一行用作者词汇附一句说明。

若任务书自检时曾提示需要改写的用词、放行时仍有残留，另起一行用作者能懂的话提醒一句本章任务书已内部检查处理过，不影响正文。

收尾后调 `mcp__narracat_memory__novel_list_candidate_characters(status="candidate", importance="major")`；若有影响剧情的重要候选角色待建档，另起一行提醒：「影响剧情的重要角色待建档：{名字列表}。需要时可在「小说角色」目录里为 ta 建档，或执行 /narracat:world create {名字}。」无重要候选则不输出此行（次要候选静默在目录里，不提醒）。

## 错误处理

| 场景 | 处理 |
|---|---|
| 章节号非正整数 / 前置章未完成 | 步骤 0 对应分支报错终止 |
| builder 返回错误（含细纲缺失、本章未规划） | 原样输出 errors，终止 |
| 写手报告细纲不可写或上下文不可用 | 转述报告，建议 /narracat:plan，终止 |
| 复审仍 fail | 断点退回步骤 3，报人工处理 |
| 记忆入库或进度更新提示需重新审校（正文在审校后有变化） | 重新执行步骤 4 审校，通过后从中断处继续 |
| 并集 staged_runs=0（三轮抽取全失败） | 断点退回步骤 3，报人工重试，不标记完成 |
| 交付合同未过（update_progress / 记忆入库返回 manuscript_contract 错误） | 退回步骤 3 的机械门处理 |
| NovelMemory 不可用 | 报错并建议检查 MCP 连接 |

# CLAUDE.md

- 你必须用中文和我互动
- 所有创作内容使用中文

## 项目概述

NarraCat 是 NarraCat-app 内部维护的 Agent Core，为 AI 辅助超长篇小说创作（50-500 章，20万-300万字）提供完整工具链。Command 命名空间 `/narracat:xxx`；App 经 `narracat.manifest.json`（唯一契约清单）发现与装载本引擎。

4.0 架构的唯一权威规格：`docs/plans/2026-06-12-agent-core-4.0-rebuild-design.md`（下称「总设计」）。运行模型按 ADR-0030 三层切分（账房归我们、花归用户、尺归读者）：**账房层（结构化数据/记忆/一致性）按确定性纪律设计——代码能算的绝不让 LLM 填；一切结构化数据经 MCP 工具入口 ajv 校验，失败返回 errors[]+hint 自修正重试 ≤2 次，超限停在 checkpoint 报人工。创作层（正文/散文/声音）按作者假设设计——信任模型判断、喂温度而非字段、账房对写作动作隐形。质量信号由评价层提供（只度量、不阻断）。**

## 架构（4.0）

```
用户交互层   13 Commands —— 编排极简化，派发一律 Envelope 模式：只传路径+参数，不复述 agent 内部规则
专业 Agent 层 5 Agents —— 按最小噪声原则精简：写手 ≤2k token；审校 ≤100 行
引擎层       NovelMemory MCP Server（TypeScript, stdio, 嵌入式 SQLite）—— 结构化落库唯一通道
机械层       质量钩子（产物存在性 / receipt 核对 / 字数 / 任务书系统词）住 App 侧 electron/main/engine/，经 pi 扩展挂载，引擎不再持有 hooks 目录；一切格式渲染（outline md / review md / 叙述者腔调节）由工具从已验证数据生成
```

审校为双层最小审校：L0 代码机械层 + L1 客观错误极简 agent（5 类，blocker 即 FAIL）；风格层主链彻底不审，/review 深审只标注、永不回流。记忆为分层记忆主干（L1 热层章 brief / L2 温层 arc·卷摘要 / L0 全量按需检索）+ 图谱-lite（facts 受控谓词 + 别名归一）。

## 组件清单

- **Commands (13):** init（纯机械初始化）/ setup（grill 式立项对话 → novel_submit_premise 入库九张立项卡）/ reference（参考作品分析）/ world（批量立项 + 冲突检测）/ plan（预算表派发大纲）/ write（核心循环——一热一冷：步骤 1=上下文聚合、3=正文生成【3a 主会话把包压缩成自然语言任务书 Write 进 `.narracat/staging/` → 3b 派发写手热写 → 3c 机械合同门（含 ASCII 引号归一）→ 3d 冷 pass 唯一改稿位】、4=审修、5=修订、6=收尾入库（`novel_update_progress` 原子把草稿区正文搬进正式路径），编号语义是 App 硬契约）/ review（模式 A=主链同款 L1 审校；模式 B=深审标注）/ rewrite（级联影响分析 + 记忆回滚）/ revise-premise（立项卡地基内容定点修订：讨论单条→CascadeImpactReport→确认→novel_submit_premise merge_cards+sync_engine_facts 落改，不自动改章节）/ sync-chapter-memory（用户手改已完成章节正文后同步记忆：影响评估 → 确认 → 记忆回滚重抽 → 矛盾提示，只动记忆不动正文）/ status / learn-craft（从书学写法，App 学习工作区直读内联，不走小说命令通道）/ writer-wizard（作家向导访谈，App 向导工作区直读内联，不走小说命令通道）
- **Agents (5):** outline-architect / chapter-writer（热写薄 prompt，只读任务书与自身写作纪律，候选判优模式已撤下）/ continuity-editor / world-curator / memory-keeper（保名改内）
- **Skills (5):** novel-structure（仅注入 outline-architect）/ novel-web-craft（写法素材库：番茄向平台写作功底的可选参考卡集合，不常驻注入任何 agent，由 write 主会话在 3a 压缩任务书时按需 Read 挑选）/ novel-memory-integration（主会话查询指南）/ novel-style-reference（远程真人范例服务查询壳）/ novel-reference-analysis-method（仅 /narracat:reference 显式调用）。旧反模式扫描 skill 已退役并删除：可机械检测子集下沉为代码扫描，词表并入 `mcp-server/src/data/prose-hygiene-lexicon.ts`
- **Schemas (11):** OutlineStructure · ReviewReport · MemoryExtraction · WritingContextPack · ForeshadowingSystem · CascadeImpactReport · PremiseCards · DialogueSamples · StateVocabulary · CharacterEntity · AuthoredState。纪律：零 deprecated、零双形态、enum 全英文 snake_case 每个 ≤8 值（中文展示归渲染层）、单工具单次提交对象叶子字段 ≤15
- **MCP 工具:** 全名前缀 `mcp__plugin_narracat_novelmemory__`；契约总表（新增 / 改名 / 删除、各工具签名与持有者）见总设计 §4，数据表见 §3。错误返回统一 `{ok:false, errors:[{field, expected, actual, hint}]}`

| Agent | Skills |
|---|---|
| outline-architect | novel-structure |
| chapter-writer / continuity-editor / world-curator / memory-keeper | （无） |

## 写权限模型

**每个 agent 只持有自己产物的提交工具**（框架级 `tools` 字段强制），结构化数据不存在第二条写入路径：

| 持有者 | 写入口 |
|---|---|
| memory-keeper | `novel_commit_chapter` / `novel_submit_extraction` / `novel_stage_extraction` / `novel_consolidate` |
| 主会话（write） | `novel_commit_extraction_union`（读各轮暂存合并落库；submit/stage 共用同一段落库逻辑）/ `novel_check_state_delivery`（计划状态变更兑现比对：机械匹配命中落 delivered，未兑现出报告卡，软门不阻断） |
| continuity-editor | `novel_submit_review`（审校报告由工具机械渲染，agent 不写文件） |
| outline-architect | `novel_submit_outline` / `novel_submit_chapter_outline`（大纲 md 由工具机械渲染） |
| world-curator | `novel_submit_state_vocabulary` / `novel_submit_character_entity`（角色结构化半边：状态词表 + 核心角色实体，md 文学正文仍走返回值交主会话落盘） |
| chapter-writer | Write/Edit 仅写 manuscript 正文（零元数据、零 MCP 写） |
| 主会话（setup） | `novel_submit_premise`（立项卡，premise.md 由工具机械渲染）/ `novel_update_progress` / `novel_checkpoint` / `novel_sync_structure`（state.yaml 对 LLM 零直写） |
| 主会话（sync-chapter-memory） | `novel_restore_progress`（作者手改正文后恢复完成进度，不做审校新鲜度校验；豁免边界即该命令的 allowed-tools 白名单，写作链拿不到它） |
| App（作者编辑，确定性直调） | `novel_submit_authored_state`（角色结构化状态作者修订：set_current/backfill/correct/retract/endorse 五 action，一次性 MCP client 直调，不进 agent 工具面）/ `novel_resolve_planned_state`（计划状态变更处置：defer/cancel/acknowledge/mark_delivered 四动作，同为 App 直调不进 agent 工具面）/ `novel_update_chapter_state_changes`（章纲计划状态变更整段替换：json+md+计划表协调写入，CAS 防并发，同为 App 直调不进 agent 工具面） |

## 关键目录规则

| 目录/文件 | 规则 |
|---|---|
| `narracat.manifest.json` | 自有契约清单（App 发现/校验 SSOT）：name/version + commands/agents/skills/schemas/templates 全量清单；新增/删除这五类文件必须同步本清单 |
| `schemas/` | 数据契约 SSOT；prompt 只引用 schema 名+关键字段摘要，不重复完整定义、不写版本戳 |
| `commands/*.md` · `agents/*.md` | 运行时 prompt：Markdown + YAML frontmatter，frontmatter 字段严格遵循 Claude Code 官方 Plugin 规范 |
| `skills/*/SKILL.md` | SKILL.md 主体在 subagent 启动时全量注入，references/ 按需 Read；非高频内容下沉 references/ |
| ~~`hooks/`~~ | 已删除（随 claude-sdk 退役）。四条钩子判据移植进 App 侧 `electron/main/engine/engine-hooks.ts`，挂载在 `pi-engine-hooks.ts` 与 `engine-subagent-gates.ts`；引擎侧不再新增 shell 钩子 |
| `mcp-server/` | NovelMemory MCP Server；修改 `src/` 后须 `cd mcp-server && npm run build` |
| `templates/` | init 复制的项目模板；`premise-template.md` / `relationships-template.md` 文件名是 App 硬契约 |
| `docs/plans/` · `docs/adr/` · `docs/contracts/` | 维护者层：设计文档 / 架构决策 / 跨组件共享契约（调用方按需 Read，引用须带 `${CLAUDE_PLUGIN_ROOT}/` 前缀） |

**App 硬契约（任何改动不得破坏，全文见总设计 §1）：** 小说目录与文件名、state.yaml 字段集、13 个 command 与 5 个 agent 文件名（含 learn-craft / writer-wizard——不走小说命令通道、由 App 直读内联的工作区命令，文件名同为 App 硬契约）、MCP 握手（server 名 / 入口 / `NOVEL_CONFIG_PATH`）、内容格式锚点（章纲首行 / 叙述者腔调节）、审校报告数据契约（`reviews/ch-NNN-review.json`，见 ADR-0018）、立项卡数据契约（`bible/premise-cards.json`，见 ADR-0019）、/write 步骤编号语义。工具改名/新增必须同步 App `electron/main/orchestrator/sdk-runner.ts` 白名单。

## 核心纪律

- **三层分界（ADR-0030）:** 约束保「不矛盾/不失忆/不编造」（客观机械事实）→ 账房层，做硬门；想控「写得好/够爽/够揪心」（主观质量）→ 创作层引导（模型+范例+persona）+ 评价层度量（reader-sim/分布对照，只度量不阻断），绝不做硬门。账房对写作动作隐形：一致性靠事前投递干净上下文 + 事后审校标注，不靠写作时逐条回应清单
- **创作层 prompt 纪律:** 宁短勿长；删一条规则永远优于加一条豁免；运行时 prompt 禁止数值处方、自检问卷、手法轮换 KPI、对冲条款与「克制/留白/收敛」类规训措辞——克制类校准的解法是根本不写克制类校准。persona 是随包投递的数据（壳+卡），不硬编码进 agent prompt
- **写作质量北极星:** 改写作质量层（chapter-writer / 审校 / 写作类 skill）时，唯一目标是第一稿阅读吸引力与可连续写作能力。三条纪律：(1) 以真实章节产出验收（用户亲读 + reader-sim 对照），不以 prompt 行数 / 架构整洁验收；(2) 提质量优先「拿掉噪声 + 信任模型 + 喂真人范例」，而非加规则 / 门禁 / 检查；(3) 不用 map / 调研 / 设计稿的流程厚重感替代写作判断与真稿验证。与工程护栏冲突时，写作质量优先
- **约束投递与数值锚定:** 想让 agent 执行的编排约束，优先做成 Envelope 里的具名数据行（靶 / 锚点），不写成 prompt 纪律段——纪律段会被当成灵感参考，数据行才会被当成排期输入。预算表给 LLM 的数值下限会被锚定成目标值——底线字段不用来表达期望密度，设计底线时把锚定效应算进去
- **细节两分法:** 章纲与任务书只承载事件与功能——删掉戏就断的细节（承载功能的动作 / 道具 / 关键台词）必须写，删掉戏仍成立的演法（比喻 / 生理反应 / 感官执行的具体写法）不写也不搬运。预写的演法会被写手原样转写进正文，绕过样章语感机制；演法归写手
- **质量病灶诊断顺序:** 归因写作质量问题先查上游指令（章纲 / Envelope）再定罪下游写手；prompt 迭代 2-3 轮不奏效就停手，转去找机械结构约束与规则间的内在矛盾——多臂一致的行为是结构信号，不是模型任性
- **生成端零负面:** 反模式等负面知识不进生成端 prompt；可机械检测子集（原文滑窗照搬 / blacklist 模式）下沉为代码扫描
- **一手拆解优先:** 写作技艺知识优先拆解真人小说文本（beat 结构 / 钩子机制 / 情绪曲线 / value-turn），提炼「范例 + 机制注解」后再编写；调研只作交叉验证。范例资产铁律：无机制注解不入库（语料本体与其入库校验已迁往语料服务私有仓，本仓不再持有）
- **不编造:** NovelMemory 是权威记忆，只入库用户确认的设定与已观察的章节事实；缺失留空，不推断填充——编造字段会被下游当作既定事实
- **运行时 prompt 出处中立:** agents / skills / commands 正文不携带 issue 号、ADR 引用、版本戳、里程碑码、设计选项标签；只写现在时执行指令，溯源归维护者层（本文件 / docs/ / CHANGELOG / git）。CI `lint:provenance` 机械拦截
- **路径规则:** 运行时 prompt 引用 plugin 内静态资源（docs/contracts/、templates/、skills/*/references/）必须带 `${CLAUDE_PLUGIN_ROOT}/` 前缀（裸相对路径在用户项目 cwd 下读不到）；豁免 `bible/references/`（小说项目目录）。`npm run lint:plugin-paths` 机械拦截
- **Prompt 语言:** 正文全中文；Agent `description` 英文（框架要求）；Skill `description` 第三人称英文
- **错误处理:** A. 前置条件不满足→终止；B. subagent 失败→checkpoint；C. MCP 连接失败→排查建议；D. 工具校验失败→按 errors[].hint 自修正重试 ≤2 次→停 checkpoint 报人工

## 散文块（作者可编辑区）

App 层「Agent 档案」页让作者在设置页覆盖官方 Agent 的部分正文（不改磁盘源文件，运行时按覆盖注入）。`agents/*.md` 里用 HTML 注释成对标记出可编辑段落：

```markdown
<!-- narracat:prose id="writer-persona" title="写手的人设"
     hint="决定这个写手是什么性格的说书人，影响全书叙述口吻" -->
你是专业的网络小说作家……
<!-- /narracat:prose -->
```

标记只对维护者与解析器可见，组装 prompt 时连同标记一起被剥离——**模型永远看不到注释本身**。未被标记的段落一律锁死、不可编辑，这是安全默认方向。

### 判据：什么能开放为散文块

**命中以下任一条即锁死（不可标记为可编辑）：**

1. **有下游机械消费者**——schema 字段名、枚举值、id 格式、工具名、步骤号、轮次上限、预算表纪律。改错了会被工具校验拒绝或走进错误的分支。
2. **失败 / 停止契约**——「该停时不停」类的段落。改错了会让 agent 该停不停，静默产垃圾且持续烧钱。
3. **安全 / 权限边界**——`tools:` 白名单、写入路径纪律、越权禁令。改错了会越权写入。

**三者都不占才是散文：改错了后果是「写得不好」，不是「系统坏了」。** 判据之外、边界模糊拿不准的段落，v1 尺度是**倾向开放**（可逆方向优先：锁多了没人知道少了什么，开多了会在 dogfood 里显形）——但**逐块人工过一遍是硬性前提**，不能批量默认开放。

### id 的待遇 = schema 字段

`id` 一旦发布（进了 `prose-blocks.lock.json` 并随版本发出），**不得改名**——作者的 override 是按 id 存的，改名等于让存量 override 静默孤儿化。删除一个块必须同步：

1. 从 `prose-blocks.lock.json` 移除该条目；
2. bump 引擎版本（三步 bump，见下节）。

`scripts/check-prose-blocks.mjs`（本地串进 `check:architecture`；CI 侧 `.github/workflows/agent-core-ci.yml` 的 `agent-core-prose-blocks-guard` job 直接跑同一条命令）机械校验：标记成对闭合、id 为 kebab-case、id 全局唯一、id 集合与 lock 文件双向一致。**新增或修改块后必须跑 `node scripts/check-prose-blocks.mjs`**，本地失败等价 CI 会红。

### 已实证的「伪装成散文的契约」

标注过程中三次抓到「读起来像写作偏好、实为契约」的段落，是本节最有价值的部分——后来者标注新块时，先对照这三例检查有没有同款陷阱：

1. **`chapter-writer` 的「对话要使用中文双引号」**（`agents/chapter-writer.md`「写作细节要求」）——看似纯格式偏好，实为契约：`mcp-server/src/handlers/state-sync.ts` 的 `novel_check_manuscript_contract`（正则 `CONTRACT_ASCII_QUOTE_CN_RE`、归一函数 `normalizeAsciiQuotesInChinese`）会机械归一 ASCII 引号包中文的写法并附带一条 warning。若作者把这条改成「用英文引号」，写手产出与机械门互斥，整章在复检 2 轮后终止。**此块从未开放，全库唯一试点（4.0.164）起就锁死。**
2. **`memory-keeper` 的「丰盛原则」**（约束 `summary` 与 `continuation_hook` 的详略度）——`mcp-server/src/handlers/validators.ts` 的 `COMMIT_CHAPTER_SCHEMA.summary` 定了 `minLength: 120`，是丰盛原则的机械镜像。作者若把这条改成「越简洁越好」，产出摘要低于 120 字直接被 schema 拒绝。
3. **`outline-architect` 的「arc 长短起伏」**（排 arc 时按剧情功能定长短，不要对齐同一数字）——`validators.ts` 的 `checkStructureRhythm` D1（arc 匀速）ERROR 分支的 `hint` 文案与这段散文近乎逐字同源（「按剧情功能定 arc 长短……全书长短要有可读出的起伏、不对齐同一数字」）。作者若把这条改成「arc 长度尽量整齐」，会直接对撞 D1 硬 ERROR。

**维护这份清单时的纪律**：每加一条都必须现场去代码核实文件路径与函数名，不能凭上游文档或印象顺手补充——本节曾有一句失实断言（称 `novel_check_prose_hygiene` 也查引号）未经核实就写入，事后核查它其实只查破折号密度与对仗转折、与引号无关。

### 识别指纹

**「prompt 正文与门控 / schema 的文案逐字同源」是最可靠的契约信号**——上面三例都能在校验器代码里找到几乎一模一样的措辞，这不是巧合：门控的 `hint`/schema 注释本就是从对应的 prompt 段落誊抄来提醒写手的，逐字同源恰恰暴露了「这段散文其实是契约的自然语言镜像」。

**判据问的是「有没有下游机械消费者」，不是「这道门凶不凶」。** 本战役中曾有一个块（`outline-architect` 的开局给糖密度）先被判定可开放，理由是对应门（`checkOpeningRetention` D-open-2）只报 WARN、不是硬 ERROR；评审用同一指纹驳回并改判锁死——一道只报 WARN 的门同样构成机械消费，"温和"不等于"没有下游"，且该块作者最可能的改法（「开局慢慢来」）恰好会撞上同一函数里另一条 D-open-1 硬 ERROR。判据是二元的（有/无消费者），不是按门的严重程度打折。

## 验证方法

```bash
cd mcp-server && npm install   # 首次或依赖变更后（install 与运行时 Node 版本必须一致，mismatch 时重装）
cd mcp-server && npm run build # TypeScript 编译检查（零错误 = 通过）
cd mcp-server && npm run test  # vitest
```

修改 Command/Agent/Skill 的 frontmatter 后，检查字段是否符合 Claude Code Plugin 规范。改 prompt 后自查：引用的工具名 / schema 字段 / 文件路径与总设计 §4/§5 零漂移。写作类改动以真稿 dogfood 验收（setup→world→plan→write 全链，统计工具 validation_error 率）。

### CI（GitHub Actions）

CI workflow 住在**仓库根** `.github/workflows/`（不在本目录的 `.github/`——GitHub Actions 只读仓库根，子目录 workflow 从不执行，ADR-0007 cutover 遗留已修，见 issue #237）。`agent-core/**` 变更触发 `agent-core-ci.yml`，Node 22、working-directory 切到 `agent-core/narracat`：

- `npm run lint:schema-drift`：schema 漂移
- `npm run lint:provenance`：运行时 prompt 出处中立
- `npm run lint:corpus-deid`：能力 packs 与 skill 文档去标识化（无书名/作者渗透）
- `npm run lint:craft-pack`：写手向能力包机制卡四要素 + 索引一致 + tags 受控 + path 前缀
- `npm run lint:structure-pack`：大纲向结构包机制卡四要素 + 索引一致 + evidence ≤300 + path 前缀
- `npm run lint:plugin-paths`：plugin 资源路径 `${CLAUDE_PLUGIN_ROOT}/` 前缀
- `npm run lint:skill-triggers`：按需挂载型 Skill（`mount-mode: on-demand`）须在 SKILL.md frontmatter 声明非空 `triggers`
- `npm run lint:manifest-sync`：五类目录（commands/agents/skills/schemas/templates）与 `narracat.manifest.json` 双向一致（新增/删除文件忘改 manifest 时 CI 变红）

八个 lint 各步 `if: always()` 互不短路；另起一 job 跑 `mcp-server` 的 `npm install && npm run build && npm test`。改 `schemas/*.json` 的 PR 另由仓库根 `agent-core-schema-pr-check.yml` 强制 description 含「下游影响」评估（ADR-0008）。本节描述的 lint 在本地以 `npm run lint:*` 同入口复跑。

## 版本号规则

三位版本号 `x.y.z`：x = 架构方向 / 重大转型；y = 功能阶段迭代；z = 每次非 trivial 提交递增。x / y 仅在用户明确要求时增加。

当前基准：**4.0.179**（narracat.manifest.json、mcp-server/package.json，以及 App 层 `agent-core/narracat-agent-core.lock.json` 的 version 字段均保持与此一致）。

**bump 流程**（每次非 trivial 提交，三处版本号 + 本节基准必须逐字一致）：(1) 更新本节「当前基准」；(2) 同步 narracat.manifest.json 与 mcp-server/package.json 的 version 字段；(3) 同步 App 层版本闸门 `agent-core/narracat-agent-core.lock.json` 的 `version`——漏改会导致 App 启动报「Agent Core version 应为 X，实际为 Y」、且 `bun --no-cache run verify:narracat-agent-core` 失败。

**变更说明写进 commit message，不要写 CHANGELOG.md。** 本仓 `.gitignore` 把 `agent-core/narracat/CHANGELOG.md` 归为过程私产（`scripts/check-public-boundary.test.mjs` 的 `FORBIDDEN_TRACKED_PREFIXES` 硬校验它不得被 tracked，根 `CONTEXT.md` 的分发资产分级把它列为「研发痕迹」），**写了也不进版本库**。这个坑踩起来很隐蔽：编辑成功、文件确实改了、`git add -A` 也不报错（git 静默跳过 ignored 文件），只是永远不进 commit；而且它是未跟踪文件，`git checkout` 换分支时原地不动，会把 A 分支写的段带到 B 分支，造出两段同号记录。本地那份留作自己查阅无妨，但它不是交付物——**入仓的变更记录 = commit message（细节）+ `docs/agents/progress.md`（阶段）**。

多条 agent-core PR 并行时：各自从 main 拉出会 bump 到同一个 z，四个版本文件在同一行冲突（`git merge-tree` 可预先确认）。先落一条，另一条 rebase 后重新定 landing 版本；版本号只需单调递增，跳号无害。

## Agent skills

- **Issue tracker:** GitHub Issues via `gh` CLI（origin: 本仓库）。详见 `docs/agents/issue-tracker.md`
- **Triage labels:** 默认五标签（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。详见 `docs/agents/triage-labels.md`
- **Domain docs:** 仓库根 `CONTEXT.md` 术语表 + `docs/adr/` 架构决策；本文件顶部章节承担架构说明。详见 `docs/agents/domain.md`

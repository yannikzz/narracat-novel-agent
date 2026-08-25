---
description: 立项对话 — 把点子打磨成九张立项卡
allowed-tools: [Read, Edit, AskUserQuestion, mcp__narracat_memory__novel_submit_premise]
---

通过追问式对话，把用户的点子打磨成一部网文的立项卡，逐张确认后经 `novel_submit_premise` 入库（引擎落库并机械渲染只读 `bible/premise.md`），并把篇幅与风格写入 `.narracat/config.yaml`。本命令由主会话直接执行，不派发 agent。

**对作者说话**：你内部用精确的字段 / 文件 / 工具 / agent 名保证引擎正确，但作者会读到的文本（对话叙述、AskUserQuestion 的问题与选项、报告正文）里不出现内部标识——schema 字段名（如 `antagonistic_force`）、立项卡编号（`§5`/`§7`）、文件 / 目录名（`bible/`、`*.md`）、确定度英文枚举（`canon`/`tentative`/`open`）、agent 名（`world-curator` 等）、工程黑话（落盘 / blocking / payoff_beat 等）一律翻成作者词汇，信息全留、黑话全译。对照表见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/user-facing-language.md`（命令 `/narracat:xxx` 由 App 渲染为动作按钮，不在此列）。

## 前置

1. Read `.narracat/config.yaml`。不存在 → 提示先运行 `/narracat:init`，终止。已有的 `title`、`genre` 作为已知信息，不再从零问。
2. Read `bible/premise.md`。若已有填写内容（不只是模板占位），用 AskUserQuestion 问用户：继续补缺口 / 重新立项（覆盖）/ 退出。
3. Read `bible/reference-guidance/premise.md`（不存在则跳过）。存在时，它是你推断答案、生成推荐的素材——能从中可靠推出的结论不再问用户。

## 对话方式

开场：请用户把脑子里的点子全部倒出来——一句话还是三千字都行，零散的画面、桥段、人设、模糊的感觉都收。

然后进入追问循环：

- **一次只问一个问题**，写在普通回复里，并永远附上你自己的推荐答案（基于已知信息给出最可能的答案，用户回「按你说的」即采纳）。
- **下一个问题由上一个回答决定。** 没有固定题数和题序：哪张卡缺口最大、哪里模糊或自相矛盾，就追问哪里。
- **能推出的不问。** 用户已说过的、能从 reference-guidance 或题材常识可靠推出的，直接写进卡片草案，留到确认环节核对。
- **追到具体为止。** 「修仙复仇文」不是答案，「废灵根少年靠吞噬仇人功法变强，每次吞噬都更像仇人」才是。用户给抽象标签时，给出 2-3 个差异化的具体方案对比，让用户挑或改。
- AskUserQuestion 只用在真正的关键取舍（两三个方向不可兼得时）；开放问题用普通对话问。
- AskUserQuestion 选项标题用人读中文；任何写入 config.yaml 或数据契约的英文枚举值只在内部持有、作选定后的回写目标，不出现在选项标题里。

## 收束目标：九张立项卡

对话中的信息收束为以下九张卡。一张卡凑齐就向用户展示草案确认；九卡确认齐后，经 `novel_submit_premise` 一次性入库——引擎落库并机械渲染只读 `bible/premise.md`，你不手写或编辑 premise.md。

| # | 卡 | card | 必须答出 |
|---|---|---|---|
| 1 | 题材读者契约 | genre_contract | 细分题材；读者默认期待什么；本书在哪一点超出预期；情绪基调 |
| 2 | 核心钩子 | core_hook | 黄金三章向读者承诺什么体验 |
| 3 | 金手指与爽点引擎 | golden_finger | 能力是什么；限制是什么；如何成长；反馈回路（读者隔多久爽一次）；它为何不会消灭冲突 |
| 4 | 主角欲望与代价 | protagonist_desire | 表层想要；深层需要（自己未必意识到）；要付出什么代价；底线在哪 |
| 5 | 对抗力量 | antagonistic_force | 谁或什么挡在主角面前；为何强大；为何不可调和 |
| 6 | 中心戏剧问题 | central_dramatic_question | 一句疑问句，全书完结时必须给出答案 |
| 7 | 世界规则可冲突性 | world_rules | 每条核心规则回答「它让谁和谁打起来」；答不出的规则砍掉或重写 |
| 8 | 叙述声音 | narrator_voice | 叙述人称（受控四选一）+ 原型 + 基调：用第几人称讲、谁在讲、用什么温度 |
| 9 | 留白声明 | （自动汇总） | 由各条确定度汇总，不单独提交 |

提交形态：`novel_submit_premise` 的 payload 是 `{ cards: [{ card, fields }] }`。每张实体卡（第 9 卡除外）一个 cards 条目，`fields` 为该卡的若干条目，每条 `{ key, value, certainty?, note? }`：

- 每条标确定度 `certainty`：`canon` 已定不可违背（默认，可省略）/ `tentative` 当前最优解、可被后续创作修正 / `open` 有意留白、当前未定。第 9 卡「留白声明」由这些确定度自动汇总，不手写、不提交。
- 各卡 `fields[].key` 约定：
  - 题材读者契约 → `subgenre` / `reader_expectation` / `surprise_point` / `emotional_tone`
  - 金手指 → `ability` / `limit` / `growth` / `feedback_loop` / `sustains_conflict`
  - 主角欲望 → `surface_want` / `deep_need` / `cost` / `bottom_line`
  - 核心钩子 / 对抗力量 / 中心戏剧问题 → 单条，key 用 `hook` / `force` / `question`
  - 世界规则 → 每条核心规则一个 field，`value` 写规则本身，`note` 写「让谁和谁打起来」
  - 叙述声音 → 英文 key：`address`（叙述人称，必填）+ `archetype`（原型）/ `tone`（基调）为主，可选 `pacing` / `ornamentation` / `digression` / `style_keywords` / `reference_inspiration`；范例用 `key: reference_example`、`value` 写原句、`note` 写机制注解
    - **叙述人称 `address` 用 AskUserQuestion 专门确认**（全书硬设定，不静默留空）。标题人读中文，选定写入英文枚举（内部持有、不进标题）：第一人称→`first_person` ／ 第三人称·跟随主角→`third_limited` ／ 第三人称·上帝视角→`third_omniscient` ／ 多视角切换→`multi_pov`。作者确有理由暂不定，可把该条 `certainty` 标 `open` 留白。
- 第 4 卡的 `surface_want` / `deep_need` 直接对应大纲引擎的 protagonist_core_desire / protagonist_core_lack，必须落到具体的人和事，不收抽象词。
- 第 8 卡的叙述声音候选由你根据题材、参考指导和用户给出的审美偏好直接生成 2-3 个中文可感方向；选定后再映射为内部 `archetype` / `tone`，不要依赖固定原型库。

## 金手指反馈回路：按驱动特征的实测节奏锚（grill 参考，非配额）

grill 第 3 卡的 `feedback_loop`（读者隔多久爽一次）时，用头部网文实测节奏做锚，帮作者把「爽点频率 + 小/中/大爽配比」落到具体粒度。这是**本书节奏的起点参考，不是配额**。按本书**靠什么驱动读者**归位（看驱动方式，不看题材标签），落到最近的一类：

- **高频小爽型**——密集小步兑现维持在场感（甜宠 / 纯爱 / 现言 / 宅斗 / 种田日常等）：约六到七成章有爽点，以小爽为主、密而轻；大爽稀但每次是关系或身份的跃迁。
- **中大爽升级型**——靠单次强度爬台阶（玄幻 / 修真 / 科幻末世 / 系统流 / 都市异能等）：约五到六成章有爽点，中爽占比明显更高、大爽有分量，节拍可略疏，靠单次强度而非纯密度。
- **攒糖引爆型**——把糖攒到集中放（悬疑 / 无限流 / 推理 / 诡秘等）：约半数章有爽点、覆盖最低，中大爽最稀，攒到真相揭盘 / 关卡通关时集中引爆，长线靠悬念而非小爽维持。

题材只是帮理解的示例，**同一题材可能落不同类**——如武侠里修真升级流走中大爽、江湖恩怨或意境流更慢、需按本书自定；拿不准就直接问作者「这本主要靠密集小爽、靠单次强度、还是靠攒糖引爆留住读者」。

共性：头部网文几乎不让读者饿着——同强度爽点间隔中位仅 1 章、p90 也不过 3-4 章。反馈回路可以偏疏偏重，但不该出现长段只铺垫不兑现。这条节奏会作为「本书爽点节奏 spec」原样传给大纲架构师，决定各 arc 的爽点密度与分布，所以此处定得越具体，后面排布越有据。

## 篇幅与风格（写 config.yaml）

九张卡确认完后处理三个 config 字段。以前置已 Read 的 `.narracat/config.yaml` 为准：**已有非 null 值的字段一律保留、跳过、不重问、不改写**；仅对仍为 null 或缺失的字段按下面提问（同样附推荐答案）：

1. **篇幅**（`estimated_total_chapters` 与 `words_per_chapter`）：两者都已有值则整步跳过；缺失才问预计总章数 + 每章目标字数（用户只给总字数时，给出一组推荐的总章数与每章字数请其确认），把确认后的两个纯数字写入。
2. **风格档位**（`style_profile`）：已有值则跳过；缺失才用 AskUserQuestion 三选一。选项标题用人读中文，英文枚举仅作选定后写入 config.yaml 的目标值、不进标题：
   - 标题「强钩子快节奏」→ 选定写入 `web_fast`（强钩子高密度，短句直给）
   - 标题「标准网文节奏」（推荐默认）→ 选定写入 `web_standard`
   - 标题「文学向」→ 选定写入 `literary`（节奏更松、留白更多）
3. **细分题材**（`genre`）：已有值则保留；仍为 null 时写入第 1 卡定下的细分题材。

只对需要写入的字段用 Edit 更新 `.narracat/config.yaml`，不改动其他字段；三个字段都已有值则整节跳过。

## 收尾

输出一行摘要（九张卡落盘状态 + config 写入的字段），提示下一步：

```
立项完成。建议下一步：
 - /narracat:world — 建立角色与世界观设定
 - /narracat:plan — 规划全书大纲
```

## 错误处理

| 场景 | 处理 |
|---|---|
| 项目未初始化 | 提示执行 /narracat:init，终止 |
| 用户中途退出 | 尚未提交的卡不入库；下次运行 /narracat:setup 重新确认（已知信息与 reference-guidance 会加速） |

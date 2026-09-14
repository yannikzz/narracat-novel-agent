---
description: 分析参考作品 — 从 bible/references/ 提取项目级参考指导
allowed-tools: [Read, Write, Glob, AskUserQuestion, TaskCreate, TaskUpdate, Skill]
---

分析用户提供的参考作品，生成后续 command 可消费的项目级参考指导。

本命令由主会话直接执行，不派发 subagent。完整覆盖 5 个维度（premise / world / characters / structure / style），产出 `bible/reference-guidance/` 目录下的 6 个文件。

> **职责分工：** `novel-reference-analysis-method` Skill 提供「如何分析」（方法论 + 维度框架）；本命令文档定义「分析结果写到哪里、按什么文件结构组织」（输出路径 + 文件模板）。两者解耦——Skill 不涉及具体路径；本命令不重复分析方法。

**对作者说话**：你内部用精确的字段 / 文件 / 工具名保证引擎正确，但作者会读到的文本（对话叙述、AskUserQuestion 的问题与选项、报告正文）里不出现内部标识——文件 / 目录名（`bible/reference-guidance/`、`*.md`）改说「参考指导（前提 / 世界观 / 角色 / 结构 / 文风参考）」，schema 字段名 / 英文枚举 / 工程黑话同样翻成作者词汇，信息全留、黑话全译。对照表见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/user-facing-language.md`（命令 `/narracat:xxx` 由 App 渲染为动作按钮，不在此列）。

## 进度跟踪

前置检查通过后，立即创建任务列表显示执行进度：

| 任务 subject | activeForm | 对应步骤 |
|---|---|---|
| 检查参考来源 | 检查参考作品… | 0 |
| 分析参考作品 | 分析参考作品… | 1-2 |
| 生成参考指导 | 生成参考指导… | 3 |
| 写入文件 | 写入参考指导… | 4 |
| 抗抄袭自检 | 自检 style.md… | 4.5 |

如 guidance 已存在或 references 为空，可直接提示并结束，不必创建任务列表。

每个步骤开始时 `TaskUpdate(status: in_progress)`，完成时 `TaskUpdate(status: completed)`。

## 执行流程

### 步骤 0: 前置检查

1. 确认 `.narracat/config.yaml` 存在。**工具报错 ≠ 文件不存在**：读取工具返回错误时如实报出错误与原因，不要据此推断项目未初始化。确认不存在 → 如实说明这本书的项目文件读不到、本次无法继续；不要自行初始化，也不要建议作者重新建一部，终止
2. 确认 `bible/references/` 目录存在；不存在 → 提示作者先添加参考作品，终止
3. 用 Glob 列出 `bible/references/*.md` 和 `bible/references/*.txt`
   - 文件列表为空 → 提示「`bible/references/` 为空。请添加 `.md` 或 `.txt` 参考作品后重新运行」，终止
4. 检查 `bible/reference-guidance/index.md` 是否已存在
   - 已存在 → 提示「检测到已有参考作品分析（`bible/reference-guidance/index.md`）。本命令不支持覆盖。请删除整个 `bible/reference-guidance/` 目录后重新运行」，终止

### 步骤 1: 显式调用 novel-reference-analysis-method Skill

使用 Skill tool 显式调用 `novel-reference-analysis-method` Skill，加载分析方法论与维度框架。

> 本 Skill 仅供本 command 使用，不通过自动匹配触发，也不被任何 Agent 注入。

### 步骤 2: 读取并分析参考作品

1. 列出检测到的参考文件清单，AskUserQuestion 确认：
   - 「确认分析全部 N 个文件」
   - 「排除某些文件」（多选）
2. 用 Read 工具读取所有要分析的参考文件
   - 仅读 `.md` / `.txt`；遇到其他格式（EPUB/PDF/DOCX）跳过并告知用户「文本导入由 App 或用户文件系统完成」
   - 单文件 > 2 万字时警告，建议截取核心章节
3. 按 novel-reference-analysis-method Skill 中定义的 5 维度框架，逐文件分析、跨文件融合
4. 心理输出（不写盘）：5 个维度各自的「注入摘要 / 应该影响的决策 / 可借鉴片段 / 不应继承 / 来源依据」

### 步骤 3: 生成 guidance 文件清单，向用户确认

向用户展示将要写入的 6 个文件清单 + 每个文件的一句话摘要：

```
将写入 bible/reference-guidance/：
- index.md（索引，{N} 个来源，{date}）
- premise.md（{一句话摘要}）
- world.md（{一句话摘要}）
- characters.md（{一句话摘要}）
- structure.md（{一句话摘要}）
- style.md（{一句话摘要}）
```

AskUserQuestion：「确认写入 / 需要调整某维度」

if 调整 → 用户提供调整意见，回到步骤 2 重新分析该维度

### 步骤 4: 写入 guidance 文件

1. 创建 `bible/reference-guidance/` 目录
2. 按下文「guidance 文件结构」中定义的模板，逐文件写入：
   - `index.md`
   - `premise.md`
   - `world.md`
   - `characters.md`
   - `structure.md`
   - `style.md`（在共用模板之外**额外**包含「## 叙述者腔调」子节，见下文「style.md 专属扩展：叙述者腔调子节」）
3. 写入完成后输出摘要：「已写入 6 个文件到 `bible/reference-guidance/`」

### 步骤 4.5: 抗抄袭自检

`style.md` 写盘前，主会话用纯代码扫描自校（其余 5 个 guidance 文件不在本步骤范围）——在产出端拦截原文 / 专名漂移，避免污染下游写作上下文。

#### A. ≥10 字连续原文检测

- **基本算法**：滑动窗口对比 `style.md` 全文 vs `bible/references/*.md` 中每个 ≥10 字 substring。命中（任一 ≥10 字连续片段在 references 中也出现） → reject
- **性能降级**：若 `bible/references/` 文件总长 > 50KB，降级为「关键句 SHA256 hash 集合」检测——
  - 取 references 中所有句末标点（`。 ！ ？ ； . ! ?`）分割后的句子，分别 SHA256 hash 入 set R
  - 取 `style.md` 句子同方式 hash 入 set S
  - 命中条件改为 `R ∩ S ≠ ∅`
  - trade-off：放过非完整句的 ≥10 字片段，换 O(N+M) 性能；下游跨章代码扫描兜底未命中部分

#### B. 专名命中检测

- 从 `style.md` 「## 叙述者腔调 → ### 不应继承 → 专名」清单（self-referential SSOT）反向 grep `style.md` 其他子节
- 命中 → reject

> **「不应继承.专名」清单的 SSOT 性质：** 该清单由 LLM 在步骤 4 的 produce 阶段从 `bible/references/*.md` 全文中尽量完整 enumerate（不限于 LLM 自己想到的，而是穷尽 references 中出现的全部专名候选）。漏列项靠下游跨章代码扫描兜底，本步骤不处理 enumerate 完整性。

#### reject 流程

1. 命中 A 或 B → 主会话生成提示：「`style.md` 出现原文 / 专名漂移：{具体位置 + 命中片段}。请重生该子节（{所属子节名}）并按 novel-reference-analysis-method「去文本化」+「拒绝原文复制」原则改写」
2. 重生该子节后回到步骤 4.5 重新自检
3. **重试上限 2 次**（即第 3 次重写仍命中 → 终止 + 提示用户：「自检 2 次重试后仍命中。请人工审改 `style.md` 后重新运行 `/narracat:reference`」）

### 步骤 5: 完成输出

提示下一步：

```
参考作品分析完成。建议下一步：
- /narracat:setup — 立项对话（会自动消费 reference-guidance/premise.md）
- /narracat:world — 建立角色与世界观（会自动消费 reference-guidance/world.md + characters.md）
- /narracat:plan — 规划大纲（会自动消费 reference-guidance/structure.md）
```

`style.md` 作为叙事风格参考资料保留，供立项时讨论叙述声音与人工改稿查阅。

## 输出目录约定

本命令的全部产出落在 `bible/reference-guidance/` 目录下，文件结构固定为 6 个：

| 文件 | 维度 | 用途 |
|---|---|---|
| `index.md` | 索引 | 记录分析时间、来源数量、文件清单、使用边界 |
| `premise.md` | premise | 题材承诺与核心冲突参考 |
| `world.md` | world | 世界观呈现与信息控制参考 |
| `characters.md` | characters | 角色塑造与语言指纹参考 |
| `structure.md` | structure | 章节结构与节奏参考 |
| `style.md` | style | 叙事视角与文本风格参考 |

> 上述路径是本命令的硬约定；后续 command 按此路径读取，不允许变更命名或目录层级。

## guidance 文件结构

### index.md 模板

```markdown
# 参考作品分析索引

## 状态
- 分析时间：{YYYY-MM-DD}
- 参考来源数量：{N}
- 参考来源：{文件列表}
- Guidance 文件：premise.md / world.md / characters.md / structure.md / style.md
- 适用范围：本项目后续所有 command

## 使用边界
- 这些文件是参考作品分析结果，不是正式设定
- 后续命令可读取对应 guidance，但不得重新分析原始参考文本
- 不得照搬参考作品的专名、桥段或角色关系

## 文件说明
- premise.md：题材承诺与核心冲突参考
- world.md：世界观呈现与信息控制参考
- characters.md：角色塑造与语言指纹参考
- structure.md：章节结构与节奏参考
- style.md：叙事视角与文本风格参考
```

### 单维度 guidance 模板（premise / world / characters / structure / style 共用）

```markdown
# {维度}参考指导

## 注入摘要
（3-7 条，可直接放入 prompt 的高密度指导。一句一条，不展开论述。）

## 应该影响的决策
（本 guidance 应影响哪些后续创作/设定决策——指明消费端 command）

## 可借鉴片段
### 片段 1
> 原文短片段（80-250 中文字，不超过 500 字）

- 适用场景：{什么情境下应参考此片段}
- 借鉴点：{具体的手法决策}
- 不应照搬：{专名/桥段/关系原型等不能迁移的内容}

### 片段 2
...

## 不应继承
（明确不能迁移的专名、桥段、关系原型、类型冲突点——这是审修端读取的项目特化黑名单）

## 来源依据
（来自哪些参考文件，简短说明每个来源贡献了什么）
```

> 文件模板的字段约束（片段数量上限、字数上限、必填三项「适用场景/借鉴点/不应照搬」）由 `novel-reference-analysis-method` Skill「片段约束」一节定义。

### style.md 专属扩展：叙述者腔调子节

`style.md` 在上述「单维度 guidance 模板」5 段结构（注入摘要 / 应该影响的决策 / 可借鉴片段 / 不应继承 / 来源依据）之外，**额外**追加「## 叙述者腔调」子节。模板如下：

```markdown
## 叙述者腔调

### 腔调来源
- reference_inspiration: 《作品名1》《作品名2》

### 风格描述（200-400 字 paraphrase）
{整体气质的「做什么 / 怎么做」连续散文段，全程 paraphrase；不出现专名、不出现 ≥10 字原文}

### 专属词汇（10-30 个去文本化 tag）
- {带肌肉感的短动词}
- {文白夹杂的虚词}
- ...
（每个 tag 描述词汇类型，不写参考作品原词；如必须举例则需明确标注「示意，非作品原词」）

### 概念体系（5-15 条要点）
- {概念群 / 对应关系 1}
- {概念群 / 对应关系 2}
- ...
（每条描述一组结构和坐标系，不写参考作品的具体专名）

### 标志金句机制（3-5 条机制描述，不是金句库）
- {机制 1：句长区间 + 嵌入位置 + 语用功能 + 限定条件}
- {机制 2：...}
- ...
（**严禁列出原句**——即使是「最有名的那句」也必须 paraphrase 为机制；示例措辞：「嵌入式 8-15 字短句 + 借次要人物口说出 + 用于场景结尾点睛 + 必带一处辩证转折」）

### 不应继承
- 专名：{enumerate 参考作品的人名 / 地名 / 物品名 / 门派 / 招式名等具体专有名词}
- 桥段：{标志性桥段类型描述，不是细节复述}
- 原文 ≥10 字：{具体禁止片段 enumerate，作为下游抗抄袭代码扫描的源数据}
- 关系原型：{原型类型描述，如「主角 + 师门 + 师姐」的具体三元组}
```

**字段约束与产出方法说明：**

- **4 个文本子节**（风格描述 / 专属词汇 / 概念体系 / 标志金句机制）的产出方法详见 `novel-reference-analysis-method` Skill「style 维度的『叙述者腔调』子项分析框架」节，全程遵循该 Skill「去文本化」与「拒绝原文复制」原则。
- **「不应继承」节是 self-referential SSOT**：「专名」清单由 LLM 在 produce 阶段从 `bible/references/*.md` 全文中尽量完整 enumerate（不限于 LLM 自己想到的，而是穷尽 references 中出现的全部专名候选）；该清单同时作为步骤 4.5 自检 B 项的 grep 源数据，漏列项靠下游跨章代码扫描兜底。
- **「原文 ≥10 字」清单是合法 enumerate**：作为下游抗抄袭代码扫描的源数据 enumerate 出现在「不应继承」节内，不违反「拒绝原文复制」原则（该原则禁止的是其他子节中的原文残留）。

## 约束

- 不读写 `bible/premise.md`、`bible/characters/*.md`、`bible/world/*.md`、`outline/`、`manuscript/` 或 NovelMemory
- 不创建 `bible/style-guide.md` 或 `bible/style-analysis-report.md`（这两个文件在新契约下已废弃）
- 不支持 `--force` 覆盖；如需重新分析，用户必须先删除 `bible/reference-guidance/` 整个目录
- 不支持局部重跑（如单独重生 `style.md`）

## 错误处理

| 场景 | 处理 |
|---|---|
| 读不到项目配置文件 | 如实说明这本书的项目文件读不到、本次无法继续；不要自行初始化，也不要建议作者重新建一部，终止 |
| `bible/references/` 不存在 | 提示作者先添加参考作品，终止 |
| `bible/references/` 为空 | 提示添加 `.md` / `.txt` 后重试，终止 |
| `bible/reference-guidance/index.md` 已存在 | 拒绝覆盖，提示删除目录后重试，终止 |
| 参考文件格式不支持（非 .md/.txt） | 跳过该文件，告知用户支持的格式 |
| 单文件过大（> 2 万字） | 警告并建议截取核心章节 |
| 抗抄袭自检 2 次重试后仍命中（步骤 4.5） | 终止 + 提示用户人工审改 `style.md` 后重新运行 `/narracat:reference` |

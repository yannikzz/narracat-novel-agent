# 契约：大纲规划共享逻辑

> **定位：** 本文件是大纲推进逻辑（细纲状态同步 / earliest-missing 推进 / 叙事断点窗口 / 不覆盖 / 阶段一范围）的 SSOT，主要调用方是 `commands/plan.md`。调用方在进入对应步骤前用 Read 加载本契约（引用格式「详见 `${CLAUDE_PLUGIN_ROOT}/docs/contracts/outline-planning.md` §X」），不复制算法细节。规则语义变更只改本文件。

---

## §1 细纲状态同步（文件系统是 SSOT）

已细化章号集合 `C_outlined` 的唯一真值来源是文件系统：

1. 用 Glob 扫描 `outline/vol-*/ch-*.md`
2. 从文件名解析章号集合 `C_outlined`（格式 `outline/vol-{VV}/ch-{NNN}.md`，VV 两位补零卷号、NNN 三位补零章号；解析失败的文件名跳过并提示，不阻断）
3. 不读、不维护任何缓存字段——细纲文件由 `novel_submit_chapter_outline` 机械渲染，文件即状态；任何中断后重跑，本扫描自动得到正确状态（idempotent 自愈）

调用点：`/narracat:plan` 模式判定前。`/narracat:write` 入口对单章细纲的存在性检查与本节同源（直接查文件）。

---

## §2 earliest-missing 与叙事断点窗口

**前置：** 阶段一已提交（`novel_submit_outline` 已机械同步 `state.yaml.structure` 并入库 arc / storylines / 伏笔注册表）；已按 §1 得 `C_outlined`。

**定义：**

- `C_planned` = `state.yaml.structure.chapter_to_volume` 覆盖的章号集合（Read 该文件取值，不写）
- `C_missing` = `C_planned − C_outlined`。章号从 1 连续覆盖，因此**最早缺失章** `start` = 从 1 起第一个不在 `C_outlined` 的已规划章号
- `earliest_arc` = `novel_get_arc(chapter=start)` 返回的 arc（含 arc_id / chapter_start / chapter_end / 三件套 / payoff_beats）
- 后续 arc 取法（arc 区间连续不留缝）：`novel_get_arc(chapter=当前 arc 的 chapter_end + 1)`；返回空即已到规划末尾

**输出三分支：**

| 条件 | 判定 |
|---|---|
| `C_missing ≠ ∅` | 补纲：从 `start` 起按叙事断点窗口推进（§3） |
| `C_missing == ∅` 且 `C_planned` 章数 < 预算总章数（`novel_get_structure_budget`） | 补卷：还有未规划的卷（§4） |
| `C_missing == ∅` 且规划已覆盖预算总章数 | 全部完成 |

**叙事断点（窗口收口点）：** 派发以章为粒度的窗口 `[start, target]`，`target` 是从 `start` 起最近的一个**叙事断点**——剧情上自然成段的收口章。断点取自结构化大纲数据（书级 `storylines` 的 `entry_chapter` / `planned_payoff_chapter`、伏笔注册表的 `planted_chapter` / `target_reveal` 章号锚点、arc 的 payoff_beats 兑现点、arc 的 `chapter_end`=arc 闭合），每个断点带一句剧情理由（如「SL-02 入场」「F-MED-05 兑现点」「V01-A02 闭合」）。collaborative 档的断点候选由 outline-architect 读结构化大纲推算并提供，不在主会话硬算；auto 档不产候选，`target` 按 §3 的机械规则直接取 arc 闭合章。

**约束：**

- **起点固定：** 窗口必须从 `start`（最早缺失章）开始，不允许用户自选起点（远距离跳跃补纲禁止）；用户只决定窗口产到哪个断点（§3）
- **最小前瞻窗口 = 5 章：** 窗口跨度（`target - start + 1`）需 ≥ 5 章，以保证窗口内伏笔埋设-兑现的编排成立；断点不足此窗口时顺延到下一个满足的断点。已到规划末尾（无后续 arc）时取最后一个断点，跨度不足 5 章亦可——此时窗口就是剩余全部章
- 区间已局部细化（窗口内已有部分 ch 文件）仍整体纳入派发；§3 不覆盖规则保证已有文件不被破坏

---

## §3 叙事断点窗口批次与不覆盖

**窗口选取：**

- **手动模式（collaborative）：** outline-architect 依结构化大纲提供从 `start` 起的若干「产到第 N 章（断点理由）」候选（按章号升序、各满足最小前瞻窗口）；主会话经 AskUserQuestion 用人读中文标题（如「产到第 52 章 · F-MED-05 兑现」）让作者选定一个 `target`，另附「暂不细化」。断点理由是人读说明、不裸露主键到标题以外。
- **auto 模式：** 不询问，也**不派发断点候选**——`target` 由主会话按 arc 闭合章机械算出，零 LLM 裁量：

  1. `target` = `earliest_arc.chapter_end`（arc 闭合即引擎设计的剧情收口点：arc 的 `irreversible_change` 在此落地）
  2. 若 `target - start + 1 < 5`（最小前瞻窗口，§2），顺延到下一个 arc 的 `chapter_end`（后续 arc 取法见 §2），重复直至跨度 ≥ 5 章
  3. 无后续 arc（已到规划末尾）→ 取当前 `target`，跨度不足 5 章亦可

  同一项目状态重复跑本命令，铺纲范围必然一致；单次范围被 arc 跨度钉死（tier 档位 S 5-15 / M 10-25 / L 15-35 / XL 20-40 章），成本可预算。auto 档不消费 payoff_beat 兑现点这类更细的断点——确定性优先于断点精细度。

**单窗口即收口（硬边界）：** 一次命令运行只推进 `[start, target]` 这一个窗口。窗口内全部段提交完成后直接进入完成输出——不重新计算最早缺失章、不取下一个 arc、不追加新窗口；越过 `target` 的任何章一律留给作者下次运行本命令。auto 档同样受此约束（auto 免掉的是询问，不是窗口边界）。

**派发与提交：**

- 选定 `target` 后，窗口 `[start, target]` 按 arc 切分逐段派发 outline-architect（阶段二 Envelope 传章区间 + 该段 arc 三件套 + payoff_beats），由其自行调 `novel_submit_chapter_outline` 提交；**单次提交覆盖的 arc 数 ≤ 工具上限（4），窗口跨更多 arc 时拆成多次提交**，逐段提交便于失败隔离与重试
- **不覆盖：** `novel_submit_chapter_outline` 渲染 `outline/vol-{VV}/ch-{NNN}.md` 时跳过已存在文件（结构化数据照常入库），回执列出跳过清单。修改已有细纲不在补纲流程内

**失败处理：**

- 某段提交重试超限（agent 内按 errors[].hint 自修正最多 2 次）→ 保留已成功段的产物不回滚，询问用户重试该段或停止
- 中断后重跑由 §1 扫描自愈，下次从新的 `start` 重新计算窗口，不需要人工对账

---

## §4 阶段一范围（含 XL 与补卷）

- **S / M / L 档：** 阶段一一次提交书级 + 全部卷级 + 全部 arc
- **XL 档：** 阶段一只提交书级 + 第一卷（含完整 arc_list）；远期伏笔的 `target_reveal` 可用「vol-08」形态的卷级粗锚点
- **补卷：** §2 判定为补卷时，派发阶段一·补卷 Envelope——只产下一个未规划卷的卷级 + arc_list，用 `novel_submit_outline`（scope="volume"，payload 只含该卷）提交；书级与已有卷不透传、不改动，由工具按卷号合并、渲染新增 vol-outline.md 并扩展 structure 同步
- **collaborative 新建（两段制）：** 阶段一拆两段。书级段（scope="book"）只提交引擎字段 + storylines + 伏笔注册表，工具渲染 master-outline.md 且卷结构标待展开；作者确认后卷级段逐卷提交（scope="volume"，每次 payload 只含一卷的 volumes + arc_list，每规划好一卷立刻交一卷），书级以库内为准不覆盖（作者确认窗口内的直接修改自然保留）。卷级段范围仍按本节 tier 规则（非 XL 全部卷 / XL 第一卷）。整组替换形态（scope="volumes" / 缺省 full）只用于整体重排；会让既有卷消失时必须显式带 `confirm_volume_removal=true`，否则工具拒绝。auto 新建 / 修改不走两段制，仍全量提交；补卷见上一条。
- **书级待展开判定：** `outline/outline-structure.json` 存在且 `volumes` 为空数组。该判定必须先于修改与补卷判定——先于修改是防带指令重跑绕过书级确认门（指令应作为骨架调整意见），先于补卷是防「已规划 0 章 < 预算总章数」误命中 §2 补卷条件。

---

## 引用规则

- 命令/agent 文件引用本契约必须带 `${CLAUDE_PLUGIN_ROOT}/` 前缀——运行时 cwd 是用户项目，裸相对路径读不到 plugin 内文件
- 命令文件不复制本契约的算法步骤、参数定义、约束条件，只保留：调用时机、场景特化、输出消费分支，以及核心安全约束的一句话重复（「起点固定」「最小前瞻窗口」「不覆盖」）

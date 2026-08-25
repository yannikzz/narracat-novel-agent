# 写作 Prompt 真稿 A/B 验收 Runbook

> 写作类 prompt（chapter-writer / continuity-editor / novel-craft 等）改动的**可选深度验证流程**：
> 同一冻结输入，改动前 / 改动后各产出一章真稿，盲评后按北极星判定采纳或回退。
> 本流程是纯维护者层，不写入任何运行时 prompt。

## 定位与路由

写作 prompt 改动有三级验证，按改动大小路由：

| 级别 | 工具 | 适用 |
| --- | --- | --- |
| 推理判断 | 无需跑稿 | 微小改动（措辞微调、删冗余摘要）——单章效应低于噪声底，跑 A/B 测不出 |
| Fixture A/B | `agent-core/narracat/eval/`（README 有完整跑法） | 开发期快速迭代 + **多 issue 改动链的整链收尾终判**：冻结 fixture、每臂 N=3 控方差、自动护栏 + 人盲评首尾 |
| 真稿 A/B（本文档） | dogfood 小说 + 真实 `/narracat:write` 全流程 | **可选深度工具**：真实项目状态、真实 MCP/Skill 注入，全维度盲评——单次 ~1h / $8-10，按需启用 |

> **2026-06-06 路由调整**：真稿 A/B 不再作为逐 issue 采纳门槛（单次 ~1h / $8-10 过重，逐 issue 跑不可持续）。
> 多 issue 改动链改为**整链收尾跑一次 Fixture A/B（eval 壳 Workflow）终判**，旧臂取链起点 sha、新臂取链终点（首例 #212）。
> 真稿 A/B 降为可选深度工具：仅在 dogfood 体感怀疑退步、需要全保真归因（MCP 层 / style 锚点 / 命令编排）时启用。

eval 壳测不了的（真人范例 MCP 层、style.md 风格锚点分支、命令编排流程），只有真稿 A/B 能覆盖。
反过来，真稿 A/B 单臂 N=1、成本高（约 $4-5 / 20 分钟每章），方差控制应在 eval 壳阶段完成——
**别拿真稿 A/B 当迭代工具，它是闸门。**

## 流程总览

```
1 冻结输入   快照 dogfood 小说目录（含 .narracat/memory.db）
2 跑 A/B    旧臂(git ref) / 新臂(工作区) 各跑一次 /narracat:write N，跑完即恢复快照
3 归档盲化   产物按命名规范归档，章稿剥离元数据后随机盲标签
4 盲评      8 维度清单（dogfood 验收 7 维度 + 章末继续读意愿）+ 整体盲选
5 判定回退   硬护栏 → 盲评比较 → 北极星回退规则，verdict 揭盲归档
```

## 步骤 1：冻结输入

1. 选 dogfood 小说与目标章 `N`（取 earliest missing chapter，保证 `/narracat:write N` 是自然下一步）。
2. 快照整个小说目录（含 `.narracat/`，SQLite 文件复制前确认无进程占用）：

```bash
NOVEL=~/Documents/NarraCat/novel-<id>
RUN=<run-id>                       # 命名规范见步骤 3
cp -R "$NOVEL" "$NOVEL/.narracat/dogfood-backups/$RUN-pre-ch<NNN>" 2>/dev/null || \
  { cp -R "$NOVEL" "/tmp/$RUN-pre" && mv "/tmp/$RUN-pre" "$NOVEL/.narracat/dogfood-backups/$RUN-pre-ch<NNN>"; }
```

> 快照目录命名沿用既有 `dogfood-backups/<日期或run-id>-<目的>` 模式。
> 恢复 = 用快照内容覆盖 `manuscript/ outline/ reviews/ .narracat/`（保留 dogfood-backups 自身）。

**同输入的可验证定义**：WritingContextPack builder 是确定性代码（ADR-0011），
同一项目状态下两臂生成的 `.narracat/context-packs/ch-NNN.json` 必须一致。
步骤 2 跑完两臂后 `diff` 这两份 JSON——不一致说明输入冻结失败，本次 A/B 作废。

## 步骤 2：跑 A/B 两臂

**物化旧臂**（A 臂 = 改动前，通常是 main 或改动 PR 的 base）：

```bash
git worktree add /tmp/narracat-ab-old <old-ref>
cd /tmp/narracat-ab-old && bun install --no-cache
# 旧臂 Agent Core 路径：/tmp/narracat-ab-old/agent-core/narracat
```

- 引擎按 app root 就近解析（`electron/main/engine/engine.ts` 优先取该 checkout 的 `agent-core/narracat`），
  所以**换臂 = 换在哪个 checkout 里启动 App**，没有"把 App 指向别处引擎"的命令行开关。
- 纯 prompt 改动（不涉及 `mcp-server/src`）：把工作区已 build 的 `mcp-server/node_modules` 与 `mcp-server/dist`
  拷进旧臂，两臂共享同一 MCP build，更快且排除 build 差异。
- 改动涉及 `mcp-server/src`：两臂各自 `cd mcp-server && npm install && npm run build`。

**逐臂执行**（先 A 后 B，顺序不影响判定——盲化靠步骤 3 的随机映射，不靠跑序）：

```bash
bun --no-cache run dev          # 必须在该臂的 checkout 里启动
# 应用内：打开 dogfood 小说 → Agent 面板执行 /narracat:write <N>
```

- 没有等价的 headless 跑法：一次 Agent run 由主进程装配（pi runtime + 每项目一个 NovelMemory
  utilityProcess + 权限闸），命令行单跑引擎 prompt 不等价，别拿它出 A/B 结论。
- 工具白名单由 App 装配，`NARRACAT_COMMAND_ALLOWED_TOOLS` 已含全量 NovelMemory 工具
  （`mcp__narracat_memory__*`）；若自己写临时 runner，必须显式带上——
  这是 2026-06-05 dogfood 踩过的坑。
- 模型基准对齐 dogfood 现状（当前 DeepSeek V4 Pro），两臂必须同 provider 同模型。

每臂跑完：

1. 收产物：`manuscript/vol-VV/ch-NNN.md`、`.narracat/context-packs/ch-NNN.json`、`reviews/ch-NNN-review.md`，
   存入该臂归档目录（步骤 3）。
2. 用快照**完整恢复**小说目录，再跑下一臂。
3. 两臂跑完后 `diff` 两份 context-pack JSON，验证同输入。

## 步骤 3：归档与盲化（命名规范）

归档根：`docs/report/ab-runs/<run-id>/`，run-id 格式 `YYYY-MM-DD-<改动主题>`（如 `2026-06-07-craft-s7-hooks`）。

> 本节涉及的 `docs/report/`、`agent-core/narracat/eval/` 都是维护者私产目录，不随本仓公开
> （见 `CLAUDE.md` 的实验室仓说明）；照本流程跑的人可在自己的工作区按同一命名规范建目录。

```
docs/report/ab-runs/<run-id>/
├── KEY.json            # 盲化映射 + 两臂 git sha + 输入快照 id —— 盲评结束前不打开
├── drafts/             # 盲评人唯一可看的目录
│   ├── ch-NNN.draft-x.md     # 剥离 ChapterMetadata HTML 注释的正文副本
│   └── ch-NNN.draft-y.md
├── raw/
│   ├── arm-old/        # 原始章稿（含元数据）+ context-pack + review
│   └── arm-new/
└── verdict.md          # 盲评记录 + 揭盲结论（模板见步骤 5）
```

规则：

- **输入版本**由 KEY.json 的 `input_snapshot`（快照目录名）+ 章号标识；**prompt 版本**由两臂 git sha 标识。
  两者都只存在于 KEY.json 与 raw/，盲评人接触不到。
- 盲标签 x/y 与 old/new 的映射**随机分配**（如 `openssl rand` 取一位定奇偶），写入 KEY.json。
- drafts/ 副本必须剥离章稿尾部的 ChapterMetadata HTML 注释块——元数据措辞会泄露臂身份，且盲评对象是正文阅读体验。
- KEY.json 字段：`{ run_id, chapter, input_snapshot, novel_id, arms: { "draft-x": { role: "old|new", ref, sha }, "draft-y": {...} } }`。

## 步骤 4：盲评

盲评人只读 `drafts/` 两份正文。先读哪份随机；两份都读完再动笔。

**维度 1-7**：直接使用 `docs/report/2026-06-05-dogfood-writing-quality-acceptance.md` 的
Acceptance Dimensions（句段接力 / 场面可执行性 / 上下文连续性 / 伏笔自然度 / 信息释放 /
角色能动性 / 元数据与契约稳定），逐份按该文档的 Pass/Fail 标准判。
维度 7 用 raw/ 里的元数据与 review 判定，由非盲评人（或揭盲后）补填。

**维度 8 · 章末继续读意愿**（本 runbook 新增，盲评核心项）：

Pass:
- 读完结尾，能说出一个具体的"下一章我想知道什么"。
- 结尾停在张力、悬念或情绪的未完成态；钩子由场景动作或代价承载，不是叙述者的抽象预告。
- 不依赖把本章张力总结收平来制造"完整感"。

Fail:
- 结尾把冲突收拾干净，没有留下任何未决问题。
- 钩子是概念陈述（"危机正在逼近"）而非具体压力（人物处境、未兑现的代价）。
- 读者对下一章无所谓。

Primary attribution:
- Data contract：outline 章末钩子 / ending_hook 输入缺失或抽象。
- Prompt：WCP 钩子数据完整但收尾仍然平。

**整体盲选**：八维度之外必答一题——"只能继续读一份，你选哪份？（可答：选 x / 选 y / 真分不出）"。

## 步骤 5：判定与回退

按顺序走，先到先判：

1. **硬护栏（先于好不好看）**：任一臂 review verdict 失败、ChapterMetadata 破损、伏笔动作违规
   （维度 7 类问题）→ 先归因修复，本次 A/B 不进入偏好判定。新臂护栏退步 = 直接回退。
2. **不退步门槛**：新臂在维度 1/2/3 任何一项明显差于旧臂 → 不采纳（参照 dogfood 报告
   Decision Rule：1/2/3/7 是基础线）。
3. **采纳条件**：维度 8 + 整体盲选指向新臂，或两者打平且维度 4/5/6 中新臂至少一项明显更好。
4. **北极星回退**：自检 / 合规 / 简洁变多，但盲评没有更想读 → **回退**。
   "更整洁的 prompt"不是采纳理由，真稿更好看才是。
5. **分不出**：单章 N=1 贴得太近 → 回 eval 壳加 N 或换更敏感的输入复测；
   不在真稿层重复烧钱，默认维持旧臂（采纳需要证据，回退不需要）。

判定后揭盲，写 `verdict.md`：

```markdown
# A/B Verdict · <run-id>
- 改动：<一句话> （new = <sha>，old = <sha>）
- 输入：<novel-id> ch-NNN，快照 <input_snapshot>
- 同输入验证：context-pack diff 一致 ✅/❌
- 盲评：维度 1-8 逐项（x/y 各 Pass/Fail 或胜负）+ 整体盲选
- 揭盲：draft-x = <old|new>，draft-y = <old|new>
- 判定：采纳 / 回退 / 复测，依据上方第 <n> 条
- 归因：赢（输）在哪个维度，对应 prompt 的哪一处改动；后续 issue（如有）
```

## 成本与纪律

- 一次真稿 A/B ≈ 2 章生成 ≈ **$8-10 / 40-50 分钟**（DeepSeek 基准，2026-06-05 实测单章 $4.17 / 20 min）。
- 跑前确认改动"大到能动草稿"，否则先走 eval 壳或推理判断（见定位与路由）。
- 本流程产物全部在维护者层（docs/report/ + 小说项目本地），不写入 agents/ skills/ commands/ 任何运行时 prompt。
- 旧臂 worktree 用完清理：`git worktree remove /tmp/narracat-ab-old`。

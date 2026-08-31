# CLAUDE.md — NarraCat-app

> Claude 在本项目工作的根级指引。只放三件事：**目标 / 地图 / 约束**。
> 细节按需读：仓库结构见下方地图，创作引擎规则见 `agent-core/narracat/CLAUDE.md`，流程文档见 `docs/`。

## 目标

NarraCat-app 是面向中国网文作者的桌面端创作工具，把小说创作流程产品化。产品北极星（ADR-0030）：**让任何人的写作能力，都能安全地开在超长篇小说上的底座——账房归我们、花归用户、尺归读者**（账房层确定性纪律 / 能力层信任模型与可插拔 / 评价层只度量不阻断）。

它由两层组成，边界要始终分清：

- **App 层**（`electron/` + `src/`）：GUI、状态管理、IPC、pi Agent runtime 装配、运行资源打包、产品化交互。
- **NarraCat Agent Core**（`agent-core/narracat/`）：本仓库内部维护的创作引擎，提供创作命令、Agent/Skill、schema、NovelMemory MCP 和小说文件契约（不是上游插件镜像，ADR-0007）。

两条原则：

1. **App 只依赖引擎的稳定契约**（命令、manifest、小说文件结构），不臆造结构、不把 GUI 逻辑写死进引擎。
2. **改引擎分两套尺子**：创作质量层（agents/skills/commands 的写作 prompt）以 `agent-core/narracat/CLAUDE.md` 的北极星为准；工程护栏（schema、数据管线、写权限隔离、目录结构）按该文件的检查清单走，不顺手破坏。

## 地图

```
narracat-decktop/
├─ shared/               两进程共用层，唯一允许被 electron/ 与 src/ 双侧 import（ADR-0036）
│  ├─ types/             跨进程契约类型（config = Provider SSOT、ipc.d.ts、agent-run、novel…）
│  └─ lib/               跨进程纯函数（agent-durable-events·skill-budget·prose-blocks·result-notifications…）
├─ electron/
│  ├─ main/              主进程（ESM）：窗口、IPC 路由、Agent runtime 装配、本地资源解析
│  │  ├─ agent/          Agent 运行编排：runtime/adapters/pi（pi 双包唯一收口处，ADR-0036/0037）·runs（run-manager + 六条 run 路径）·events·permissions
│  │  ├─ chat/           角色聊天：画像·prompt·stream·runner
│  │  ├─ engine/         Agent Core 解析 + 引擎契约（engine / agent-core-contract / embedding-model）+ 用户 skill 装配/校验/同步
│  │  ├─ memory/         NovelMemory utilityProcess 宿主：worker 入口·host 管理器·冒烟（切片⑥）
│  │  ├─ novel/          小说项目文件读写：创建·删除·索引·状态·前提·角色·记忆库
│  │  ├─ packs/          能力包：学习·编译·清单·预览·发布
│  │  ├─ ipc/            IPC 路由按域拆分（agent/novel/packs/skills/chat/app，registry.ts 统一装配，无上帝文件）
│  │  └─ config.ts secrets.ts window.ts   未归域的基建文件：配置、keytar 密钥、窗口
│  └─ preload/           CJS，contextBridge 暴露 window.electron
├─ src/                  渲染进程（React + Vite + Tailwind v4 + Zustand + React Router 7）
│  ├─ routes/            三大页面：library / workbench / settings
│  ├─ components/        AppShell + 页面组件（brand·library·settings·workbench·ui）
│  ├─ lib/               渲染端状态与逻辑（agent-store·novel-store·workbench-*·premise-cards…）
│  ├─ types/             渲染端专属 UI 类型 + 兼容 re-export（跨进程契约类型已迁 shared/types）
│  ├─ design-system/     设计系统底座（typography / surfaces）
│  └─ assets/            运行时图片（品牌插图在 illustrations/narracat/）
├─ agent-core/narracat/  NarraCat Agent Core（创作引擎，本仓内部维护）
│  ├─ agents/ skills/ commands/   创作 prompt（质量层；改前读本目录 CLAUDE.md）
│  ├─ schemas/           受控数据契约
│  ├─ mcp-server/        NovelMemory MCP（改 src/ 后须在此目录重新 build）
│  └─ templates/ eval/
├─ scripts/              构建/打包/校验脚本（prepare-narracat-agent-core·prepare-embedding-model·ops-*·check-*，含 check-architecture.mjs 分层纪律硬校验）
├─ resources/            打包期注入的运行资源（Agent Core runtime / headless node / embedding 模型）
└─ docs/                 ADR、流程文档、计划、设计资产
```

**文档去哪找**（不凭记忆改，先读）：

| 需要 | 看 |
|---|---|
| 统一术语（工作台/Agent/引擎…别混用） | `CONTEXT.md` |
| 当前阶段·已完成·下一步 | `docs/agents/progress.md` |
| 本次任务该读什么/更新什么（OPS 路由） | `docs/agents/workflow.md` |
| 阶段任务与 GitHub Issue 拆分 | `docs/agents/issue-workflow.md` |
| 架构决策 | `docs/adr/` |
| 单次复杂任务计划 / 规格 | `docs/superpowers/plans/`、`docs/superpowers/specs/`、`docs/plans/` |
| 验证级别选择 | `docs/agents/verification.md` |
| 设计交接（视觉资产落地） | `docs/agents/design-handoff.md`、`docs/design.md` |

文档分工：长期事实写 `CONTEXT.md` 或 ADR；过程进度写 `progress.md`；定型决策写 `docs/adr/`；交接按 `docs/agents/handoff.md`。

**关于本仓与私有实验室仓**：本仓是唯一开发仓，代码与工程契约（本文件 / `CONTEXT.md` / `docs/adr/` / `docs/agents/`）都在这里。语料工厂、eval 壳、reader-sim、poc 等研究工具，以及产品战略与过程私产（`docs/COMPASS.md`、`docs/report/`、`docs/superpowers/`、`docs/plans/`、`docs/research/`）留在私有实验室仓 `narracat-decktop`，与本仓**无代码依赖**——文中偶尔出现的这类路径指向那边，克隆本仓时不存在属正常，不影响构建与测试。边界由 `scripts/check-public-boundary.test.mjs` 硬校验。

## 约束

### 工程硬约束（不可逆，违反会炸）

- **主进程必须 ESM**：pi 双包是纯 ESM，CJS 主进程无法 `require`。
- **API Key 永不落盘明文**：用 keytar，经系统凭据库保存（macOS 钥匙串 / Windows 凭据管理器）。
- **不写 `class`**：React 用函数组件 + hooks。
- **`file://` 用 `HashRouter`**，不要换 `BrowserRouter`。
- **包管理用 bun，命令必须带 `--no-cache`**。
- import 优先命名导入；keytar 等 native 模块可用 default import。

### 协作约束

- 不主动 `git push`，除非用户明确要求。
- 手工编辑用 `apply_patch`，不要用 `cat > file` 一类 shell 写文件。
- 工作区已有非本次改动时不要回滚；先理解，再在现有改动上协作。

### Agent Core 接入

- 开发时 App 直接解析 `agent-core/narracat/`，按 `narracat.manifest.json`（唯一契约清单）发现与装配（pi runtime 内嵌会话，切片④/刀5）；打包时由 `scripts/prepare-narracat-agent-core.mjs` 复制进 `resources/`（ADR-0007 语义不变：引擎是内部维护物，不是插件）。
- 改 `agent-core/narracat/` 前先读它自己的 `CLAUDE.md`；改 `mcp-server/src` 后须在该目录重新 build。
- 渲染小说内容以 NarraCat 生成的文件结构为准，不臆造结构。
- 新增产品化 Agent 操作：先在 App 层定义动作契约，再决定是否沉淀进引擎。

### UI 与产品

- 基调简约、大气、少解释；界面只留完成任务必要的信息。
- 能用 icon 表达的操作优先纯 icon 按钮 + 可访问名称/tooltip。
- 小说详情页基线：左侧项目菜单 · 中间内容浏览与操作 · 右侧 Agent 对话；中间区以浏览为主，正文与结构化字段提供一等直接编辑（两档宪法 ADR-0029/0031），自由 markdown（角色/世界观）仍只读。
- 空状态克制：插图 + 标题 + 正文 + 一个主按钮。
- 设计系统工作用 `.agents/skills/build-design-system` 并遵循 `docs/design.md`；视觉资产按 `docs/agents/design-handoff.md` 做 Design Artifact Sweep。

### 工作流程

默认按小垂直切片推进（路由以 `docs/agents/workflow.md` 为准）：明确目标边界 → 读现有实现与文档 → 行为变更先补/确认测试 → 最小必要改动 → 按 `docs/agents/verification.md` 跑验证 → 更新 `progress.md`。

### 验证命令

```bash
bun --no-cache run typecheck
bun --no-cache run test
bun --no-cache run check:design
bun --no-cache run check:architecture
bun --no-cache run build
bun --no-cache run dev
```

不要每次全量跑。按 `docs/agents/verification.md` 选能证明本次改动的最小集合。

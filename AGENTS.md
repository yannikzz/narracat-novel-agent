# AGENTS.md — NarraCat-app

> 给 Codex 和其他代码 Agent 在本项目工作时的项目级指引。进入项目后先读本文件，再按任务类型阅读相关文档。

## 项目定位

NarraCat-app 是面向中国网文作者的桌面创作工作台，目标是把小说创作流程产品化：由 GUI 承载项目管理、内容浏览、Agent 对话和操作编排，由产品内维护的 NarraCat Agent Core 提供核心创作指令和小说文件规范。

本项目当前边界：

- App 层负责 GUI、状态管理、IPC、pi Agent runtime 装配、Agent Core 运行资源打包和产品化交互。
- NarraCat Agent Core 是创作引擎来源，源码位于 `agent-core/narracat/`。不要把它当作持续同步的上游 NarraCat plugin。
- 用户体验优先。桌面端可以新增产品化 Agent 指令，但要通过 App 层抽象表达，避免把 GUI 逻辑写死到插件内部。

## 必读顺序

1. `AGENTS.md`：项目约束、架构、工作方式。
2. `CONTEXT.md`：统一术语，避免“工作台/Agent/插件/引擎”等概念混用。
3. `docs/agents/progress.md`：当前阶段、已完成事项、下一步。
4. `docs/agents/workflow.md`：OPS 路由规则，决定本次任务该读什么、更新什么。
5. `docs/agents/issue-workflow.md`：阶段任务和 GitHub Issues 的拆分规则。
6. 相关 ADR：`docs/adr/` 下的架构决策。
7. 相关计划或规格：`docs/superpowers/plans/`、`docs/superpowers/specs/`、`docs/plans/`（**不在本仓**，见下方说明）。

> **本仓 vs 私有实验室仓**：本仓是唯一开发仓，代码与工程契约（`CLAUDE.md` / `AGENTS.md` / `CONTEXT.md` / `docs/adr/` / `docs/agents/`）都在这里。
> 单次任务计划与规格（`docs/superpowers/`、`docs/plans/`）、战略罗盘（`docs/COMPASS.md`）、过程报告（`docs/report/`、`docs/research/`）、
> 项目技能（`.agents/`、`.claude/`）与研究工具（语料工厂 / eval / reader-sim / poc）留在私有实验室仓，**与本仓无代码依赖**。
> 本文提到这些路径时，克隆本仓找不到属正常，不影响构建与测试；完整说明见 `CLAUDE.md`「关于本仓与私有实验室仓」。

## 架构

- **Electron 主进程**：ESM 模式，TypeScript，仅做窗口管理、IPC 路由、本地资源解析、pi Agent runtime 装配（pi 双包唯一收口在 `electron/main/agent/runtime/adapters/pi`，ADR-0036/0037）。
- **渲染进程**：React + TypeScript + Vite + Tailwind v4 + Zustand + React Router 7。
- **Preload**：CJS（Electron 限制），通过 `contextBridge` 暴露 `window.electron` API。
- **构建**：electron-vite 同时构建主进程、preload 和渲染进程。
- **包管理**：bun，执行命令必须带 `--no-cache`。

## 关键约束

- Electron 主进程必须保持 ESM。pi 双包是纯 ESM，CJS 主进程无法 `require`。
- API Key 永不落盘明文。使用 keytar，经系统凭据库保存（macOS 钥匙串 / Windows 凭据管理器）。
- 不写 `class`。React 用函数组件和 hooks。
- import 风格优先命名导入；keytar 等 native 模块可用 default import。
- 不主动 `git push`，除非用户明确要求。
- Electron `file://` 场景使用 `HashRouter`，不要换成 `BrowserRouter`。
- 手工编辑用 `apply_patch`。不要用 `cat > file` 一类 shell 写文件方式。
- 如工作区已有非本次改动，不要回滚；先理解，再在现有改动上协作。

## Agent Core 与资源

App 开发运行时直接解析 `agent-core/narracat/`，按其唯一契约清单 `narracat.manifest.json` 发现并装配 commands / agents / skills / schemas / templates（引擎路径解析见 `electron/main/engine/engine.ts`）。打包后使用 Electron resources 下的 `NarraCatAgentCore`。完整准备和打包验收流程见 `resources/README.md`。

`resources/` 只承担 Electron 打包资源说明，不再是 NarraCat Agent Core 的源码目录。不要把本机 sibling 上游仓库静默同步进 App；如需审计 accepted upstream commit，仅通过 `bun --no-cache run audit:narracat-prompts -- --source <locked-upstream-checkout>` 比对。

引擎接入规则：

- App 层只依赖稳定的 Agent Core command、`narracat.manifest.json` 契约清单和小说文件结构。
- `scripts/prepare-narracat-agent-core.mjs` 只负责准备内部 Agent Core 的 MCP runtime/build artifacts，不代表长期上游同步机制。
- 读取和渲染小说内容时，以 NarraCat 生成的文件结构为准，不臆造额外结构。
- 若需要新增产品化 Agent 操作，先在 App 层定义动作契约，再决定是否需要沉淀到 NarraCat Agent Core。

## UI 与产品约束

- 当前 UI 基调是简约、大气、少解释。界面只保留完成任务必要的信息。
- 能用 icon 清楚表达的操作优先用纯 icon 按钮，并配合可访问名称或 tooltip。
- 小说详情页的结构基线：左侧项目级菜单，中间内容浏览与操作，右侧 Agent 自然语言对话。
- 中间内容区域优先浏览 Markdown 输出，不把 Markdown 编辑作为默认能力。
- 空状态引导保持克制：插图、标题、正文、一个主要按钮。
- App 运行时图片素材放在 `src/assets/`，其中 NarraCat 品牌插图放在 `src/assets/illustrations/narracat/`；探索或交接用视觉资产仍按 Design Artifact Sweep 放在 `docs/design-assets/<feature>/`，确认进入产品后再迁移到 renderer asset 目录。
- 设计系统相关工作优先使用 `.agents/skills/build-design-system`（私有实验室仓），并遵循 `docs/design.md`；公开仓侧的硬约束由 `bun --no-cache run check:design` 校验。
- UI / 产品讨论中如果使用 visual companion、HTML mockup、截图或 imagegen 产出视觉资产，PRD 或 issue 前必须按 `docs/agents/design-handoff.md` 执行 Design Artifact Sweep；`.superpowers/` 只作临时探索，可复用资产导出到 `docs/design-assets/<feature>/` 并在 issue 中链接。

## 工作流程

默认按小垂直切片推进，具体路由以 `docs/agents/workflow.md` 为准：

1. 明确当前目标和受影响边界。
2. 阅读现有实现和相关文档，不凭记忆改。
3. 对行为变更先补测试或确认现有测试覆盖；文档-only 改动不强制补测试。
4. 实现最小必要改动。
5. 按 `docs/agents/verification.md` 跑对应级别验证。
6. 更新 `docs/agents/progress.md` 或相关计划，记录下一步和阻塞。

项目管理文档只承担各自职责：

- 长期事实写入 `CONTEXT.md` 或 ADR。
- 过程进度写入 `docs/agents/progress.md`。
- 单次复杂任务写入 `docs/superpowers/plans/`（私有实验室仓）。
- 已定型的产品/架构决策写入 `docs/adr/`。
- 交接信息按 `docs/agents/handoff.md` 模板整理。

## 项目技能

- **build-design-system**：装配在私有实验室仓的 `.agents/skills/build-design-system`（本仓不含），用于构建和迁移成熟 UI 设计规范。需要做设计系统时，先用该技能输出四层模型（Specification / Implementation / Injection / Governance），再按垂直切片落地到 Electron renderer。

## 验证命令

常用命令：

```bash
bun --no-cache run typecheck
bun --no-cache run test
bun --no-cache run check:design
bun --no-cache run build
bun --no-cache run dev
```

不要机械地每次全量运行。根据 `docs/agents/verification.md` 选择能证明当前改动的最小验证集合。

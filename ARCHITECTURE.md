# 架构导览

NarraCat 由两层组成：

- **App 层**（`electron/` + `src/`）：GUI、状态管理、IPC、Agent runtime 装配、打包资源
- **创作引擎**（`agent-core/narracat/`）：创作命令、Agent/Skill prompt、schema、NovelMemory MCP、小说文件契约

App 只依赖引擎的稳定契约（`narracat.manifest.json`、命令、小说文件结构）。

## 目录职责

| 目录 | 职责 |
|---|---|
| `shared/` | 两进程共用层：跨进程契约类型与纯函数（唯一允许被 electron/ 与 src/ 双侧 import） |
| `electron/main/` | 主进程（ESM）：窗口、IPC 路由（按域拆分于 `ipc/`）、Agent 运行编排（`agent/`）、引擎解析（`engine/`）、小说文件读写（`novel/`）、能力包（`packs/`）、角色聊天（`chat/`）、记忆宿主（`memory/`） |
| `electron/preload/` | CJS contextBridge，暴露 `window.electron` |
| `src/` | 渲染进程：React + Vite + Tailwind v4 + Zustand + React Router 7（HashRouter）；三大页面 library / workbench / settings |
| `agent-core/narracat/` | 创作引擎：`agents/ skills/ commands/`（创作 prompt）、`schemas/`（受控数据契约）、`mcp-server/`（NovelMemory，改 src 后需在该目录重新 build）、`templates/ hooks/` |
| `scripts/` | 构建/打包/校验脚本，含 `check-architecture.mjs` 分层硬校验 |
| `workers/` | 云端辅助（release-guard 远程门控 Worker） |
| `resources/` | 打包期注入的运行资源 |

## 硬约束

- 主进程必须 ESM；渲染路由必须 HashRouter（file:// 场景）
- API Key 永不落盘明文（keytar → macOS 钥匙串 / Windows 凭据管理器）
- 不写 class；React 函数组件 + hooks
- 包管理用 bun，命令带 `--no-cache`
- 分层纪律由 `bun --no-cache run check:architecture` 强制（shared 单向依赖等）

## 测试

测试文件与源码同目录（`*.test.ts(x)`），`bun --no-cache run test` 全量执行（含架构校验与公开仓边界守卫）。

# OPS Workflow

> 轻量路由规则。它只回答“当前任务该走哪条 OPS 路线”，不重复项目架构和设计规范。

## Start

先运行：

```bash
bun --no-cache run ops:status
```

然后按任务类型选择路线。

## Routes

| 用户意图 | 读取 | 执行 | 更新 |
| --- | --- | --- | --- |
| 继续任务 / 查看状态 | `AGENTS.md`、`CONTEXT.md`、`docs/agents/progress.md` | 汇报分支、Now、Next、Blockers，并推进最小下一步 | 必要时更新 `progress.md` |
| 产品或 UI 讨论 | 相关 spec / plan / ADR；如产生视觉资产读 `docs/agents/design-handoff.md` | 先讨论方案；确认后再实现；若使用 visual companion / imagegen / HTML mockup，PRD 或 issue 前先做 Design Artifact Sweep | 重要决策写 ADR，阶段变化写 `progress.md`；可复用视觉资产导出到 `docs/design-assets/<feature>/` |
| 品牌资产 / Logo / 插图 | `docs/design.md`、`src/components/brand/README.md`、相关页面实现 | 只通过 `BrandMark` / `BrandLockup` / `BrandIllustration` 入口使用；不在页面直接 import 原始品牌 PNG | 行为或治理变化同步 `progress.md`；长期规则写回 `docs/design.md` |
| 拆分任务 / 创建 issues | `docs/agents/issue-workflow.md`、`progress.md`；UI / 设计类 issue 读 `docs/agents/design-handoff.md` | 按垂直切片创建 GitHub issues，并标注优先级、类型、状态、执行模式；有视觉资产时写清 Design Assets / References | `progress.md` 只保留摘要 |
| 代码实现 | 相关源码、测试、计划 | 小垂直切片；行为变更优先补测试 | 完成有意义切片后更新 `progress.md` |
| 验证 / 提交前检查 | `docs/agents/verification.md` | 运行 `ops:check` 和匹配验证命令 | 不需要为了验证本身更新进度 |
| 暂停 / 交接 | `docs/agents/handoff.md` | 按模板写清分支、改动、验证、风险、下一步 | 可同步更新 `progress.md` 的 Blockers |
| 长期架构或产品边界决策 | `CONTEXT.md`、相关 ADR | 写新的 ADR 或更新已有 ADR | 如影响当前阶段，同步更新 `progress.md` |

## Keep It Light

- 小改动不写计划。
- 普通 UI 细节不写 ADR。
- 阶段任务进入 GitHub Issues，`progress.md` 只做摘要。
- Visual companion 和 prototype 输出默认属于探索；交接给后续 Agent 前，按 `docs/agents/design-handoff.md` 导出 curated assets。
- `progress.md` 不记流水账，只记阶段和下一步。
- `handoff.md` 只在暂停、交接、长任务中断时使用。
- 验证命令按改动类型选择，不机械全量运行。

## Client Version

- 客户端构建版本使用 `0.2.<release commit 提交数>`（版本线前缀是 `CLIENT_BUILD_VERSION_PREFIX`，2026-08-25 由 `0.1` 抬到 `0.2`，见 ADR-0006 修订——本仓干净历史重建后提交数从 0 重数，而线上 `v0.1.1930` 的数字来自旧主仓，仍走 `0.1.x` 的话新版在 semver 下反而更小，存量用户收不到更新）。
- 提交数由构建 / 发布脚本在打包时从当前 release commit 派生，例如 `git rev-list --count HEAD`。
- `package.json` 的 `version` 是源码清单 / 产品线基础版本，不承载提交数派生的客户端构建版本。
- About 版本展示、RC artifact 命名和发布验收记录必须使用同一套客户端构建版本解析逻辑。
- `bun --no-cache run ops:check` 应检查客户端构建版本解析逻辑存在且可得到当前 commit 的版本，不检查 `package.json.version` 是否等于提交数。

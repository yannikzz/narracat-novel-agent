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

- **客户端版本号的唯一真相源是 `package.json` 的 `version`，由人在发版时决定**（ADR-0038，2026-08-30 起；此前是从 `git rev-list --count HEAD` 派生，见已停用的 ADR-0006）。
- 递进规矩：修 bug 走 patch（`0.3.1`）；有明显新能力走 minor（`0.4.0`）；`1.0.0` 留给正式公开发布。当前版本线起点 `0.3.0`。
- **发版第一步是决定并抬版本号**——它现在是发版的输入，不再是打包的副产品。忘了抬会被 `release.mjs` 的重复版本闸在打包前拦下。
- 改版本号只能改 `package.json`。About 版本展示、artifact 命名、发布验收全部经 `scripts/client-version.mjs` 取值，两条构建期路径（electron-builder `extraMetadata` / vite `define`）必须同源。
- 新版本号必须严格大于 `HIGHEST_SHIPPED_VERSION`（已交付到用户手上的最高版本），否则那批机器收不到更新且无任何提示——`scripts/client-version.test.mjs` 钉住这条。**发版发出去之后要把那个常量抬上来。**
- `bun --no-cache run ops:check` 检查版本解析逻辑存在、版本号是合法三段 semver，且与 `package.json.version` 一致。
- 本地临时测试包要压过线上版本时用 `NARRACAT_CLIENT_VERSION=x.y.z`（打包链专用；正式发布链路不吃这个变量）。
- **发版必须显式声明覆盖平台**：`release --with-win <目录>`（双平台）或 `--mac-only`（只发 mac），两个都不给直接炸。「不给就只发 mac」这个旧默认在 Windows 成为正式分发平台后是静默陷阱——命令照常成功，Windows 用户静默停在上一版。

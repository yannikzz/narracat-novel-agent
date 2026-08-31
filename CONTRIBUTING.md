# Contributing

感谢你愿意给 NarraCat-app 贡献代码。本仓分两层：`electron/` + `src/` 是桌面 App（GUI/状态/IPC），`agent-core/narracat/` 是仓内维护的创作引擎（commands/agents/skills/schemas/mcp-server）。项目当前状态见 [`README.md`](README.md)，PR 前请先读一遍；下面依次是开发环境、PR 流程、报告问题，以及本文件最要紧的一节——**引擎 prompt 里哪些内容作者能在 App 里改、哪些不能碰**，这条纪律直接决定你重构 `agent-core/narracat/agents/*.md` 时会不会悄悄弄坏用户数据。App 层的工程硬约束见末尾「其他约束」。

> 本仓的 `CLAUDE.md` / `AGENTS.md` / `agent-core/narracat/CLAUDE.md` 是维护者与 AI 助手日常协作用的指引，同样在仓库里，欢迎翻阅（2026-08 起本仓是唯一开发仓）。它们偏重日常协作节奏，本文件才是面向贡献者的完整纪律；两者不一致时以本文件为准。

## 开发环境

- Node ^22.12、[bun](https://bun.sh)
- 开发机：维护者日常在 **macOS（Apple Silicon）** 上开发。App 本身已双平台分发（Windows 10/11 x64 + macOS Apple Silicon），但 **Windows 侧的本地开发流程（`bun --no-cache run dev`）未经系统性验证**——CI 在 Windows 上只跑设计守卫与打包 smoke，全套 typecheck/test 跑在 Linux 上。在 Windows 上开发踩到环境问题，欢迎开 issue，不必自我怀疑
- 打包需要维护者的签名/公证凭据，fork 后跑不通打包属正常；`bun --no-cache run dev` 与全套验证命令不受此限
- 安装依赖：`bun install --no-cache`（所有 bun 命令都带 `--no-cache`）
- 本地运行：`bun --no-cache run dev`
- 验证：`bun --no-cache run typecheck && bun --no-cache run test`
- 目录职责见 [ARCHITECTURE.md](./ARCHITECTURE.md)；架构分层由 `scripts/check-architecture.mjs` 硬校验，提交前请确保通过

## 提交 PR

1. Fork 并从 `main` 拉分支
2. 保持改动聚焦、附测试；提交信息用祈使句
3. 首次贡献需签署 CLA（机器人会在 PR 里引导，全文见 [docs/CLA.md](./docs/CLA.md)）
4. CI 全绿后等待 review

## PR 会被怎样审

先把立场说清楚：NarraCat-app 是给作者用的产品，主干上每一行代码都要有人长期维护下去。所以 review 不止看「代码对不对」，也看「这个改动该不该进主干」。三关按顺序走。

### 第一关：该不该做

请在 PR 描述里直接回答三件事，它们比大段 diff 说明有用得多：

- **你解决的问题是什么，不改会怎样，影响哪些用户**
- **它给主干留下什么长期成本**——新组件、新守卫、新约束都不是一次性代码，是永久维护义务
- **有没有更小的解法**，你为什么没选它

这一关没过，我们会先和你讨论方向，暂不进代码细节。这不是否定你的工作，是不想让你在一个最终不会被合并的方向上继续投入时间。

### 第二关：实现对不对

- **根因要被证实**，不接受「在我机器上好了」——贴复现步骤、日志、或你读到的上游源码位置
- **不破坏契约分层**（App 层 / Agent Core / `shared/`，见 [ARCHITECTURE.md](./ARCHITECTURE.md)）
- **测试锁住用户能感知的行为**，而不是实现细节；也请留意测试环境和真实运行环境的差异——服务端渲染测试通过不等于浏览器里真的生效
- **守卫不许静默通过**：任何校验脚本在自身失效时必须是「响的」。扫不到文件却打印 OK、产物过期却照样绿，这类假绿在本仓造成过真实事故，我们对它零容忍

### 第三关：担不担得起

碰到这些区域的 PR 会被升级审查，通常需要真机验收：

| 区域 | 为什么 |
|---|---|
| 打包 / 签名 / 自动更新 | 出错会让已安装用户收不到更新，或装不上 |
| 用户小说数据的读写 | 作者的稿子不可再生 |
| API key、写权限隔离 | 安全边界 |
| Agent Core 契约（schema / manifest / 版本闸门） | 破了会静默毁坏用户数据 |

同时会问：出问题能不能快速回滚？你之后不再维护这段代码时，它是否还能被别人看懂？

### 这些会被直接打回

1. 动 API key / keytar / 写权限隔离
2. 改创作 prompt 却没有 A/B 证据——我们反复实证过，「听起来更好」的 prompt 在盲评里经常输给原版，这类改动只认成稿对比结果
3. 为**单个平台**的问题给**全平台**加**永久**约束，且没写解除条件
4. 新增依赖，却没说明为什么非它不可
5. 只有「本地测过」，没有别人能复现的证据

### 会让 PR 走得更快的做法

- 改动聚焦，一个 PR 一件事
- 根因附证据（源码位置、崩溃日志、复现步骤）
- 引入长期约束时**主动写解除条件**：记下当时的依赖版本、将来怎么复测、确认修复后如何拆除。踩到上面第 3 条不代表不能合，但必须留下拆除说明书
- 只碰 UI 文案、文档、测试的改动走快速通道，不必按上面三关逐条论证

## 报告问题

- Bug/功能与使用求助请走 issue 模板
- **提交任何内容前请脱敏：不要粘贴你的小说正文、API key 或含个人路径的完整日志**

## 散文块：作者可编辑的写作指令

App 的「设置 → Agent 档案」页允许作者覆盖官方 Agent（`agent-core/narracat/agents/*.md`）的部分正文——不改磁盘源文件，运行时按覆盖注入 prompt。哪些段落允许覆盖，由文件里成对的 HTML 注释标记出来：

```markdown
<!-- narracat:prose id="writer-persona" title="写手的人设"
     hint="决定这个写手是什么性格的说书人，影响全书叙述口吻" -->
你是专业的网络小说作家……
<!-- /narracat:prose -->
```

标记对模型不可见（组装 prompt 时被剥离），只服务维护者与解析器。**没有标记的段落一律锁死、作者改不到**——这是默认安全方向；给某段散文加标记 = 主动承诺「作者随便改这段都不会弄坏系统」，所以标注新块前必须过一遍判据。

### 判据：这段能不能标成可编辑

命中以下任一条，**锁死，不要标记**：

1. **有下游机械消费者**——对应某个 schema 字段名、枚举值、id 格式、工具名、步骤号、轮次上限、预算表纪律。
2. **失败 / 停止契约**——「该停时不停」类的段落。
3. **安全 / 权限边界**——`tools:` 白名单、写入路径纪律、越权禁令。

三者都不占，才是真正的散文——改错了后果是「这段写得不好」，不是「系统坏了」。判据之外、拿不准的段落，倾向开放（可逆方向优先），但**必须逐块人工过一遍**，不能批量默认开放。

**最容易踩的坑：读起来像写作偏好、实为契约的段落。** 识别指纹——如果这段散文的措辞和某个 MCP 校验器的 `hint` / schema 注释近乎逐字同源，几乎可以确定它是契约的自然语言镜像，不是可调的写作品味。已实证的三个例子：

- `chapter-writer` 的「对话要使用中文双引号」——`novel_check_manuscript_contract` 会机械归一 ASCII 引号，改了这条会让写手产出与机械门互斥，整章复检 2 轮后终止。
- `memory-keeper` 的「丰盛原则」——被 `COMMIT_CHAPTER_SCHEMA.summary` 的 `minLength: 120` 逐字镜像，改成「越简洁越好」会让摘要直接被 schema 拒绝。
- `outline-architect` 的「arc 长短起伏」——被 `checkStructureRhythm` D1 ERROR 分支的 hint 文案逐字同源。

判据问的是「有没有下游机械消费者」，不是「对应的门凶不凶」——一道只报 WARN 的门同样构成机械消费，不能以「反正只是警告」为由放行。

### id 一旦发布，等同 schema 字段的待遇

`id` 是作者覆盖内容的存储键。它一旦随发布版本进入 `agent-core/narracat/prose-blocks.lock.json`：

- **不得改名**——重构时手滑改一个 id，会让用过这条覆盖的作者的调整静默失效（用户毫无感知）。
- **删除必须同步**：从 `prose-blocks.lock.json` 移除条目，并把版本号 `z` 位加一（三位版本号 `x.y.z`，`z` 在每次非 trivial 提交时递增），具体改三处、须保持一致：
  1. `agent-core/narracat/narracat.manifest.json` 的 `version` 字段；
  2. `agent-core/narracat/mcp-server/package.json` 的 `version` 字段；
  3. App 层版本闸门 `agent-core/narracat-agent-core.lock.json` 的 `version` 字段——漏改会导致 App 启动报「Agent Core version 应为 X，实际为 Y」，且 `bun --no-cache run verify:narracat-agent-core` 失败。

  （内部开发仓另维护一份私有变更记录，那部分由维护者在合并你的 PR 时补，与你无关。）

### 提交前必须跑的守卫

改动 `agent-core/narracat/agents/*.md` 里的散文块标记（新增、修改、删除任一）后：

```bash
node scripts/check-prose-blocks.mjs
```

它机械校验：标记成对闭合、id 为 kebab-case、id 全局唯一、id 集合与 `prose-blocks.lock.json` 双向一致。本地这条也串在 `bun --no-cache run check:architecture` 与 `bun --no-cache run test` 里；CI 侧由 `.github/workflows/agent-core-ci.yml` 在 `agent-core/**` 有改动时直接跑同一条 `node scripts/check-prose-blocks.mjs`，本地先跑一遍能更快定位问题。

## 其他约束

`agent-core/narracat/` 的其余工程纪律（写权限模型、关键目录规则、核心纪律、版本号规则）见 [`agent-core/narracat/CLAUDE.md`](./agent-core/narracat/CLAUDE.md)——本文件已收录其中与外部贡献最相关的部分，需要细节时再去翻它。

App 层（`electron/` + `src/`）的工程硬约束，改动前务必遵守：

- Electron 主进程必须保持 ESM——依赖是纯 ESM 包，CJS 主进程无法 `require`。
- API Key 永不落盘明文，用 keytar 经系统凭据库保存（macOS 钥匙串 / Windows 凭据管理器）。
- React 用函数组件 + hooks，不写 `class`。
- `file://` 场景下用 `HashRouter`，不要换成 `BrowserRouter`。
- 包管理用 bun，命令带 `--no-cache`。

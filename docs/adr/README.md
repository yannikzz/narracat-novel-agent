# ADR Index

> This index is the quick status map for NarraCat-app ADRs. ADR files remain decision history; superseded or partially historical ADRs are kept and linked instead of deleted.
>
> Three numbers (0007, 0009, 0027) are reserved but not published here: they document the retired Agent SDK runtime era and were superseded by [0037](0037-agent-runtime-pi-migration.md). Their rows below carry the decision they stood for, without a file link.

| ADR | Title | Status | Current reading / relation |
| --- | --- | --- | --- |
| [0001](0001-app-orchestrates-narracat-plugin.md) | App Orchestrates NarraCat Plugin | Accepted, partially superseded | App orchestration boundary remains; plugin/upstream-sync wording is historical after the 0007 Agent Core cutover. |
| [0002](0002-agent-workflow-and-project-docs.md) | Agent Workflow And Project Docs | Accepted | Current lightweight Agent Ops document system. |
| [0003](0003-explicit-recovery-for-interrupted-narracat-writes.md) | 中断的 NarraCat 写作由 App 显式恢复 | Accepted | Recovery product model remains current; old plugin wording should be read as Agent Core contract. |
| [0004](0004-workbench-titlebar-and-composer-handoff.md) | Workbench Titlebar Actions Use Composer Handoff For Existing Content | Accepted | Current Workbench titlebar/composer handoff interaction rule. |
| [0005](0005-rc-app-identity.md) | RC App Identity | Accepted | Current user-facing app identity for RC/package naming. |
| [0006](0006-client-build-version-is-derived-at-build-time.md) | Client Build Version Is Derived At Build Time | Superseded by 0038 | 提交数派生机制已停用；决策史保留。 |
| 0007 (not published) | Stage The NarraCat Agent Core Cutover | Accepted, migration completed | Staging steps are historical; the surviving decision is that the engine lives internally at `agent-core/narracat/`. |
| [0008](0008-model-service-verification-key-metadata.md) | Model Service Verification Uses Non-Sensitive Key Metadata | Accepted | Current BYOK verification persistence rule. |
| 0009 (not published) | Packaged Agent Runs Use A Bundled Headless Runtime | Superseded by 0037 | Premise (running the packaged runtime through the SDK CLI) no longer holds; the surviving rule is that packaged runs must never depend on the user machine Node/shell/PATH. |
| [0010](0010-character-chat-is-native-app-runtime.md) | Character Chat Uses A Native App Runtime | Accepted | Current Character chat runtime boundary. |
| [0011](0011-deterministic-writing-context-pack-builder.md) | Deterministic WritingContextPack Builder | Accepted | Current WCP assembly boundary. |
| [0012](0012-character-uid-is-canonical-character-identity.md) | Character UID Is The Canonical Character Identity | Accepted, field inventory partially historical | UID remains canonical; original field list predates Agent Core 4.0 and is superseded by #197/#198 notes inside the ADR. |
| [0013](0013-writing-agent-memory-retention-policy.md) | Writing Agent Memory Retention Policy | Accepted | Current agent-memory boundary; not superseded by NovelMemory graph-memory work (#302). |
| [0014](0014-novelmemory-mechanically-writes-structure-state.md) | NovelMemory Mechanically Writes Structure State | Accepted | Current structure state write boundary. |
| [0015](0015-progressive-growth-skeleton-vs-instance.md) | Progressive Growth - 结构骨架前置，内容实例懒生成 | Accepted | Current planning/growth product principle. |
| [0016](0016-machine-fields-stay-out-of-user-channels.md) | 机器字段不入用户通道 | Accepted | Current user-channel rendering rule. |
| [0017](0017-agent-core-local-distribution-is-not-a-confidentiality-boundary.md) | 本地分发的 Agent Core 不是保密边界 | Accepted | Current local distribution / IP protection boundary; #130 is downstream. |
| [0018](0018-structured-products-expose-server-ready-data-contracts.md) | 结构化创作产物对外暴露 server-ready 数据契约 | Accepted | Current DTO/data-contract principle for structured products. |
| [0019](0019-premise-is-engine-owned-data-not-author-edited-markdown.md) | 立项卡是引擎拥有的结构化数据 | Accepted, partially superseded | Boundary narrowed by [0029](0029-two-tier-editing-direct-vs-agent-cascade.md)：有下游依赖字段仍 only-through-AI（第二档）；经审计无依赖的纯描述字段允许 App 直接编辑保存（第一档）。原 confidence-marker 决策保留。 |
| [0020](0020-skill-mounting-model.md) | Skill 挂载是 (Skill × Agent) 绑定的四类模型 | Accepted, partially superseded | Mount/unmount 机制已整体退役（见 ADR 内 2026-08-07 补记）：官方 Skill 现全面只读，用户自定义 Skill 的文件夹挂载形态由「作者对它的要求」自由文本取代。 |
| [0021](0021-narrator-address-is-controlled-required-premise-field.md) | 叙述人称是立项卡的受控必填字段 | Accepted | Current narrator address contract. |
| [0022](0022-workbench-content-cache-stale-while-revalidate.md) | Workbench Content Cache Stale-While-Revalidate | Accepted | Current workbench content cache policy. |
| [0023](0023-candidate-character-importance-tiers.md) | Candidate Character Importance Tiers | Accepted | Current candidate-character importance tiering. |
| [0024](0024-style-directive-carries-positive-craft-not-restraint-calibration.md) | 风格指令只承载正向写法，克制类校准出口翻译 | Accepted, partially superseded | 正向化翻译（数据清洗）仍有效；「执行字符串」交付框架被 [0030](0030-north-star-v2-substrate-capability-evaluation.md) + 4.0.74 persona 具身 supersede——style_directive 降为 persona 的腔调基因。 |
| [0025](0025-corpus-essence-refinery-pipeline.md) | 网文精华提炼工厂——本地模型粗筛 + Claude 精修，三轨喂引擎 | Accepted | Current maintainer-layer corpus essence-refinery pipeline；#335 为第一炉。 |
| [0026](0026-staged-distribution-for-internal-test-and-beta.md) | 内测/公测分阶段分发——内测厚客户端、公测建只读语料服务端、引擎上云延后 | Accepted | Current distribution staging；内测不触发整个后端。 |
| 0027 (not published) | 旧 SDK 运行时暂不升级（维持 0.2.112），设触发条件再一次性升 | Superseded by 0037 | 版本策略随该 runtime 一起退役；留下的通用结论是「升级理由要有真实触发条件，不为新功能而升」。 |
| [0028](0028-agent-runs-load-only-project-file-settings.md) | Agent 运行只加载 project 级文件设置——用户全局 CLAUDE.md 不进 Agent | Accepted | Current 文件设置隔离边界；`settingSources:['project']` 刻意不挂 `'user'`，创作规则只来自引擎 + Project Agent guide + App 注入。 |
| [0029](0029-two-tier-editing-direct-vs-agent-cascade.md) | 用户编辑创作信息的两档交互原则——直接保存 vs Agent 评估后保存 | Accepted | Current 编辑交互原则；两档 UX 封装多态底层，按字段下游依赖确定性路由，第二档先报告级联后用户确认；放宽 0019 的纯描述字段。 |
| [0030](0030-north-star-v2-substrate-capability-evaluation.md) | 产品北极星 v2——底座+能力层+评价层，弱模型假设退守账房层 | Accepted | Current product north star（账房归我们、花归用户、尺归读者）；三层分界是所有创作层/账房层改动的归属判据；partially supersedes 0024 的交付框架。 |
| [0031](0031-manuscript-editing-save-first-two-tier.md) | 正文编辑「保存永远先落盘」的两档适配 | Accepted | Current 正文编辑保存语义与崩溃草稿归属；[0029](0029-two-tier-editing-direct-vs-agent-cascade.md) 框架内的正文变体。 |
| [0032](0032-character-structured-state-first-tier-editing.md) | 角色结构化状态开作者第一档直接编辑 | Accepted | Current 角色状态直接编辑边界；[0029](0029-two-tier-editing-direct-vs-agent-cascade.md) 框架内的角色状态变体。 |
| [0033](0033-app-directly-reads-memory-db-for-situation-pack.md) | 唠个嗑处境包由 App 主进程直读 memory.db 组装（引擎契约例外） | Accepted | Current 处境包组装边界；App 只读直读 `memory.db` 的显式例外，`buildCharacterSituationPack` 是替换接缝。 |
| [0034](0034-capability-pack-contract.md) | 能力包契约——卡片数据包、全局安装、按书启用、不可变版本与展示边界 | Accepted | Current capability-pack contract；包版本、来源、启用清单、回执与展示边界的长期真相。 |
| [0035](0035-app-owned-durable-production-continuity.md) | App 拥有耐久生产连续性——主进程真相、renderer 投影、显式恢复 | Accepted | Current P1A continuity boundary；正文资产归项目，Agent/App 状态归 userData，后台任务不依赖窗口，完整退出不自动续跑。 |
| [0036](0036-architecture-layering-discipline.md) | 架构分层与依赖纪律——shared 层 + 单向依赖 + runtime 收口 | Accepted | Current 依赖分层纪律；`shared/` 是唯一双侧 import 层，electron/ 与 src/ 互不 import，`check:architecture` 强制校验。 |
| [0037](0037-agent-runtime-pi-migration.md) | Agent Runtime 从 Claude Code SDK 迁移至 Pi（方案 A：先立骨架再换心脏） | Accepted, migration completed | 迁移已走完：pi 是唯一 runtime，旧 SDK adapter 目录已删、旧包被 `check:architecture` 全仓零容忍；supersedes 0009 与 0027。 |
| [0038](0038-client-version-is-declared-not-derived.md) | 客户端版本号由人在 package.json 声明 | Accepted | Current client version policy; supersedes 0006. |
| [0039](0039-anonymous-telemetry-informed-opt-out.md) | 匿名使用统计——先告知的默认开，红线由代码机械执行 | Accepted | Current telemetry policy；采集边界、模块级粒度、自有域名反代与「告知前零发送」闸门的长期真相；覆盖 0026 中未落地的 crash 上报设想并收窄为不做自动捕获。 |

## Status Vocabulary

- `Accepted`: decision is current unless the "Current reading / relation" column narrows it.
- `Accepted, partially superseded`: core decision remains, but part of the original wording is historical or replaced by a later ADR.
- `Accepted, migration completed`: migration rationale remains useful history, while the target state is now the current norm.
- `Accepted, corrected`: the ADR contains later corrections that must be treated as the current reading.

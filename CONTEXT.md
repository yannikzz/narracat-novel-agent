# CONTEXT.md — Shared Language

> 本文件用于统一项目讨论里的核心概念。新增长期术语时先更新这里，再在实现或计划中引用。

## Product Terms

- **NarraCat-app / NarraCast Desktop**：当前桌面 GUI 产品。它面向作者承载小说项目、内容浏览、Agent 对话和创作流程编排；NarraCast Desktop 是历史别名。
- **NarraCat app identity / NarraCat 应用身份**：安装包和系统中展示的桌面产品身份；NarraCat-app 是工程名，NarraCast Desktop 是历史别名。
- **NarraCat plugin**：历史上的上游 Claude plugin，提供小说创作命令、文件约定和自动驾驶流程；Agent Core cutover 后不再是 App 的长期创作引擎来源。
- **Final upstream import / 最后上游导入**：将已接受的 NarraCat plugin 版本作为最后一次外部来源吸收到 NarraCat-app 的迁移步骤；它不是新的长期同步机制。
- **NarraCat Agent Core**：Final upstream import 后由 NarraCat-app 产品内维护的创作 Agent 能力与小说文件契约。它不是 GitHub 上游 plugin 的持续镜像。
- **Agent Core cutover**：NarraCat-app 从持续依赖上游 NarraCat plugin，转为内部维护 NarraCat Agent Core 的产品边界变化。
- **Novel project**：一个具体小说项目目录，包含 NarraCat 生成的 `.narracat/`、`bible/`、大纲、卷、章节正文等文件。
- **Novel title / 小说标题**：作者为 Novel project 明确提供的作品名称，用于识别小说项目；它不是 App 生成或推荐的默认书名。
- **Novel genre / 小说题材**：作者在新建 Novel project 时明确填写的故事类型或复合类型，用于表达创作方向并影响后续 Agent 引导；它可以是单一题材或复合题材，不是 App 默认推荐的分类，也不应由客户端替作者预填。
- **Project Agent guide / 项目级 Agent 指南**：新建 Novel project 时生成在项目根目录的轻量 `CLAUDE.md`，用于向 Claude Code SDK 说明 NarraCat Agent 的能力边界和小说创作范围；它允许处理与当前小说创作直接相关的通用帮助，友好拒绝无关需求。它不是 NarraCat plugin 的维护者层 `CLAUDE.md`，也不在打开旧项目时静默补写。
- **Legacy NarraCat project / 旧结构小说项目**：使用 Final upstream import 之前文件契约的 Novel project。Agent Core cutover 路线下它不属于受支持的创作项目。
- **Workbench**：小说详情页的主工作界面。左侧是项目级菜单，中间是文本内容浏览和当前页面操作，右侧是统一 Agent 工作区。
- **Library**：小说项目列表和入口，不承载具体章节创作。
- **Delete Novel project / 删除小说项目**：Library 中由作者明确触发的可恢复移除操作，使目标 Novel project 不再出现在小说库中；作者需要输入小说标题确认。存在 Active Agent run 的 Novel project 不能删除。它不是 Agent action，也不是不可恢复的永久销毁。
- **Settings**：应用级设置页面。结构应和小说详情页保持一致：左侧菜单，右侧内容区域。
- **Model service / 模型服务**：应用级 BYOK 连接配置，用于让 NarraCat Agent Core 连接外部模型服务；它包含 Provider、endpoint、API Key、模型档位映射和连接测试。它不是 Agent profile，也不是单个 Novel project 的设置。
- **Model service setup / 模型服务接通流程**：让用户首次完成 Model service 可用连接的主路径，核心动作是选择服务商、填写 API Key、测试并启用。它不是完整参数编辑器；Base URL 和模型档位映射属于进阶配置。
- **Model service verification / 模型服务验证**：对当前 Model service 执行真实连接测试后得到的可用性确认。只有通过验证的配置才应被视为已验证可用；已填写但未验证的配置不能等同于可用连接，配置变化会让既有验证失效。
- **Recommended model service provider / 推荐模型服务商**：Model service setup 中默认引导用户选择的 Provider；当前为 DeepSeek V4 Pro。Anthropic 是官方 Claude 服务入口，自定义 Provider 属于进阶或内部网关入口。
- **Global notification center / 全局通知中心**：应用级通知入口，跨 Novel project 聚合需要用户知晓或处理的 Agent、项目和系统消息；第一版由全局铃铛打开轻量通知面板，默认露出最近结果通知，不是某个 Workbench 的一级项目菜单，也不是临时 toast。
- **Result notification / 结果通知**：Global notification center 中用于告知一次 Agent run 或系统任务到达结果状态的本机持久化轻量记录，包括成功、失败和等待用户确认；它只提供摘要和跳转，不承载完整 Agent 输出、长期消息历史或跨设备同步。
- **Notification target / 通知跳转目标**：Result notification 点击后应恢复的具体结果位置。成功通知优先打开对应 Workbench 产物页，失败通知回到对应 Agent run 的错误上下文，等待用户确认通知回到对应 Agent 确认卡片；它不是只打开项目默认页。
- **Unread notification / 未读通知**：用户尚未消费的 Result notification；打开通知面板不等于已读，点击通知跳转到 Notification target 或显式标为已读后才视为已读。
- **Push notification / 系统推送通知**：由本机操作系统通知中心（macOS 通知中心 / Windows 操作中心）展示的 NarraCat-app 结果提醒，只在 App 不活跃时提示 Result notification；它不是跨设备远程推送，也不依赖服务端通知。
- **Character chat / 唠个嗑**：单本 Novel project 内独立的小说角色对话板块，让用户以作者身份和已出场角色进行半破第四墙交流；未来同一能力可以面向读者。它不是 Agent conversation 的换皮，也不是让角色替代创作 Agent 分析或执行小说工作流。
- **Character contact / 角色联系人**：Character chat 中一个可对话的 Appeared character，以 Character UID 作为身份锚点，像联系人一样承载稳定装载的角色设定和本机一对一聊天记录。它不是 Agent profile，也不是群聊参与者；对话时可按需查询 NovelMemory 补充已完成剧情事实。
- **Character chat knowledge boundary / 角色聊天知识边界**：Character chat 中角色可使用的故事知识上限，第一版固定为当前 Novel project 最新的 Chapter completed。它不包含未来大纲、未完成章节、尚未发生的剧情或创作 Agent 才知道的工作流意图。
- **Character chat role boundary / 角色聊天身份边界**：Character chat 中角色必须以作品角色身份回应，只能表达自身经历、情绪、关系和有限认知。它不能切换成创作 Agent，不能分析大纲、评价角色弧线、建议写法、执行改稿或泄露未来剧情。
- **Character chat canon boundary / 角色聊天正史边界**：Character chat 的对话内容默认不是小说正史，也不改变 NarraCat 写作主流程。只有用户明确发起交接后，其中的想法才可能作为创作建议进入 Agent action。
- **Character chat transcript / 角色聊天记录**：Character chat 在 App 层保存的本机对话历史，按 Novel project、Character UID 和用户模式归属。它不是 Novel project 的创作产物，不写入 NovelMemory，也不参与 NarraCat 写作主流程。
- **Character ping / 角色来信**：未来由 Character chat 在剧情推进后生成的角色主动消息，用于让角色以自身口吻回应已完成正文中的关键经历。它不是 Result notification、Push notification 或 Agent run 结果提醒；MVP 不做后台主动投递。

## Agent Terms

- **Agent**：执行小说创作任务的后台能力；在 Agent Core cutover 前通过 Claude Code SDK + NarraCat plugin 运行，cutover 后归 NarraCat Agent Core 所有。
- **Agent profile / Agent 设定**：定义小说工作流中一个专业角色及其知识边界的配置；它不是一次 Agent run，也不是 Agent action。
- **Agent memory / 代理持久记忆**：Claude Code 为特定 Agent 保留的项目级操作偏好层，用于稳定用户偏好、项目风格锚点、反复确认的审修倾向和流程 guardrail。它不是 NovelMemory，不是章节事实库，不承载某一章的剧情、旧草稿经验、WCP JSON 或未来大纲事实；写作代理的留存策略见 ADR 0013。
- **Agent profile inspector / Agent 设定检查器**：查看 Agent profile、能力边界并管理其挂载 Skill（挂载 / 卸载）的应用级界面；它展示面向作者的产品化摘要，不把原始 prompt 作为首屏内容，也不编辑 Agent 的 prompt / tools / model 等出厂能力。它不是单本 Novel project 的配置项。
- **Skill / 技能包**：可挂载到 Agent profile 的领域知识包；它不是用户直接点击执行的 Agent action。Skill 与 Agent 的关系是 **(Skill, Agent) 绑定**——同一个 Skill 对不同 Agent 可呈现为不同类别、或根本不出现。官方 Skill 按与 Agent 的绑定分为内部 / Agent 默认 / 可挂载三类；作者另可挂载用户自定义 Skill。
- **内部 Skill / Internal skill**：不绑定任何 Agent、仅供命令或主会话内部调用的官方 Skill；不出现在任何 Agent 配置页。
- **Agent 默认 Skill / Agent default skill**：随某个 Agent 出厂、绑定该 Agent 的官方 Skill；在该 Agent 配置页可见且锁定，作者不可卸载。
- **可挂载 Skill / Mountable skill**：声明适配某些 Agent、开放给作者按需挂卸的官方 Skill；只在所适配 Agent 的挂载入口出现。
- **用户自定义 Skill / User skill**：作者从本地挂载到某个 Agent 的、符合 Claude Code 规范的 Skill；按预加载注入该 Agent，作者可随时卸载。_Avoid_: User skill overlay / 用户技能扩展
- **Agent action**：用户明确触发后向 Agent 下发的任务，例如生成全局大纲、生成风格设定、规划章节；它可以来自 Workbench context action，也可以来自 Agent composer 中选定的指令。
- **Workbench context action / Workbench 上下文动作**：中间内容区基于当前页面、当前对象或当前章节提供的 Agent action 快捷入口；它自动携带目标对象上下文，不是独立于 Agent composer 的另一套引擎能力。
- **Text selection handoff / 框选文本交接**：作者在 Markdown viewer 的文档正文区域框选文本后触发的 Composer handoff；它把选中文本作为 Composer reference context 交给右侧输入区，并匹配当前对象对应的 Agent action，不从 Title bar、Tab bar、目录、文件信息、Chapter metadata 或其它 UI 文案取文本。它遵守 Composer draft conflict 和 Active Agent run 约束，不能静默覆盖用户未发送输入，也不直接启动 Agent run。
- **Selection action mapping / 框选动作映射**：Text selection handoff 的 Agent action 由当前文档类型和当前对象决定，不由客户端分析选中文本语义。设定类文档映射到 world，创作根基映射到 setup，大纲类映射到 plan，章节正文和审修报告映射到 rewrite；参考作品相关内容第一版不提供框选 Agent action。
- **Active Agent run**：右侧 Agent 当前正在执行的任务。存在 Active Agent run 时，Composer handoff action 不可用，避免把待发送草稿和正在执行的任务混在一起。
- **Agent workspace / Agent 工作区**：Workbench 右侧的统一 Agent 面板，用于输入指令、自然语言补充需求、查看 Agent run、步骤状态、问题卡片、结果和失败恢复；它不是拆开的任务 tab 和聊天 tab。
- **Agent conversation / Agent 对话**：Agent workspace 中的自然语言交流，用于讨论剧情、设定、章节意图和修改方向；没有明确 Agent action 时，它默认不写入 Novel project。
- **Conversation-to-action handoff / 对话转执行交接**：Agent conversation 中的讨论沉淀为明确 Agent action 的产品化交接。Agent 可以主动生成执行提案，但不能自动执行；用户确认后才启动 Agent run，并在 Agent workspace 中查看状态。
- **Agent composer / Agent 输入区**：Agent workspace 中用户选择显性指令并补充自然语言需求的位置。用户发送带 Composer command chip 的输入后，会启动对应 Agent action，而不是停留在普通对话；它主要依赖用户输入和当前 Novel project 上下文，不默认把当前页面当作唯一修改目标。若目标对象不明确，Agent run 应通过 Agent 提问卡片确认，而不是由客户端静默推断当前页面。
- **Composer action bar / 输入区操作栏**：Agent composer 中独立于正文输入区的底部操作区域，承载指令入口、当前 Composer command chip 和发送或停止动作。它不是正文输入的一部分，也不承载用户要求。
- **Composer reference context / 输入区引用上下文**：Agent composer 中独立于用户输入正文的引用材料，例如框选文本和来源目标；它可被用户移除，发送时与用户要求一起交给 Agent，但它本身不等同于用户要求，也不要求在界面中展示为大块文本预览。
- **Composer handoff**：一种不会立即启动 Agent run 的产品化交接。App 把命令 chip、目标对象、受控 prompt 草稿或 Composer reference context 交给右侧 Agent composer，用户补充要求并主动发送后才执行。
- **Composer handoff action**：点击按钮后只把 NarraCat command、目标对象以及受控 prompt 草稿或引用上下文交给右侧 Agent composer 的动作；它不启动 Agent run。
- **Composer draft conflict**：Composer handoff action 试图写入草稿时，右侧 Agent composer 已有用户输入的状态；App 必须让用户选择替换或保留，不能静默覆盖。
- **Direct Agent action**：点击后立即启动 Agent run 的动作，只用于用户意图明确且不需要补充要求的流程推进。
- **Client action**：桌面端本身即可完成的操作，例如刷新、切换 tab、打开设置、返回。
- **Command**：NarraCat Agent Core 按契约清单暴露的具体命令，例如 `/narracat:setup`。
- **Agent Core command id / Agent Core 命令 ID**：NarraCat Agent Core 内部用于路由、测试、通知、恢复和日志的稳定动作标识。它不是用户界面的主要表达方式。
- **Composer command chip**：右侧 Agent composer 里可见的产品化短标签，用于表达当前消息会按哪个 NarraCat command 执行；它只承载指令状态，不承载用户输入正文，且必须能被用户看见和移除。
- **Agent command pill / Agent 指令胶囊**：Agent conversation 输出中把 `/narracat:*` 识别为可点击的用户动作标签；点击后只把对应指令填入 Agent composer 并聚焦输入，不直接启动 Agent run。
- **User-facing Agent action label / 面向用户的 Agent 动作名**：Workbench 和 Composer 中展示给作者的自然语言动作名称，例如“分析参考作品”“写下一章”。它优先于 slash command 成为用户心智；底层 `/narracat:*` 命令只能作为弱提示、tooltip 或调试信息。
- **Productized instruction**：App 为提升体验新增的高层 Agent 指令。它可以组合 NarraCat 命令，但不应绕过引擎契约。
- **Conversation stream**：右侧 Agent 面板的输出流。工具调用、思考和中间状态应合并为一条可滚动过程，直到出现最终文字输出。
- **Agent 提问卡片**：Conversation stream 中由 Agent 提出、需要作者选择或补充回答后才能继续的交互卡片；它不是普通 Agent 文本、系统通知或全局弹窗。
- **Agent run context isolation / Agent 运行上下文隔离**：每次 Agent run 是一次独立的 SDK 子进程查询，拥有自己的上下文窗口（上限 1,000,000 token）；一次 run 内主 Agent 经 Task 委派的每个子 Agent（chapter-writer、continuity-editor 等）又各自跑在隔离的上下文窗口里，只把最终产物或结论回传父级。不同 run 之间、父子 Agent 之间默认不共享上下文，跨 Agent 的信息只能经 WritingContextPack、NovelMemory 和项目文件产物传递（见 ADR-0011 / 0013 / 0014）。它不是一个所有 Agent 共享的单一长对话，也不是靠父 Agent 把全文塞进子 Agent 提示来传递上下文。
- **Setting source isolation / 文件设置隔离**：Agent run 只加载 project 级文件设置（`settingSources: ['project']`），因此从运行目录树向上发现的项目级 `CLAUDE.md`（含 Project Agent guide）会生效，而用户/开发者本机的全局 `~/.claude/CLAUDE.md` 个人偏好不会进入任何 Agent（见 ADR-0028）。它不是加载本机全部 Claude Code 配置，也不是完全不加载任何 `CLAUDE.md`。

## Content Terms

- **Creative blueprint**：创作蓝图。它是左侧一级菜单之一，子内容通常包括全局大纲和第 N 卷。
- **结构骨架层 / Structure skeleton**：大纲中定义全书结构锚点的稳定层，包含书级引擎字段、故事线注册表、伏笔注册表和 arc 弧线，是跨章编排（伏笔埋兑、故事线收放、arc 章范围）挂靠的锚点。它不是某一章的具体内容（那属于内容实例层）；它「前置规划但支持受控增量、不冻结」的策略见 ADR-0015。
- **内容实例层 / Content instance**：挂在结构骨架锚点下、随剧情推进才具体化的可变内容，包含章细纲、角色档案、关系细节和章节正文，会随写作增删演化。它不是定义全书锚点的结构骨架层；它「按剧情懒生成、支持随时新增与渐进深化」的策略见 ADR-0015。
- **Reference works / 参考作品**：Workbench 的一级菜单之一，用于管理作者提供的参考文本和查看参考分析产物。它不是单纯的风格参考。
- **Reference source / 参考原文**：作者导入或粘贴到 `bible/references/` 的 `.md` 或 `.txt` 文本，用作 Reference works 的原始输入。
- **Reference guidance / 参考指导**：Agent 分析 Reference source 后生成的项目级指导文件组，用于影响创作根基、世界观、角色、结构和文风等后续创作决策。它不是正式设定本身。
- **Stale reference guidance / 过期参考指导**：Reference guidance 已存在，但 Reference source 后续发生增删，因此分析结果不再完全对应当前来源集合。
- **Reset Reference works / 重置参考作品**：清空 Reference source 和 Reference guidance，让 Reference works 回到未添加参考作品的状态。它不是删除单个 Reference source。
- **Novel settings**：小说设定。它是左侧一级菜单之一，子内容来自 `bible/` 下的世界观、人物、写作风格、场景、规则等文件。
- **Character UID / 角色 UID**：Novel project 内小说角色的稳定身份标识，用于在角色设定、章节引用、NovelMemory 和 Character chat 之间关联同一角色。它不是角色显示名、角色文件名、头像资源名或 App 临时对象 ID。
- **Character reference / 角色引用**：跨章节、记忆和 App model 引用同一小说角色的轻量结构，机器身份使用 Character UID，并携带角色显示名供人读和模型理解。它不是完整角色设定，也不是只靠角色名匹配的字符串别名。
- **Appeared character / 已出场角色**：拥有已确认角色设定，并且已经进入至少一个 Chapter completed 的正文或记忆中的小说角色。它不是只存在于未来大纲、尚未完成章节或未确认设定里的候选角色。
- **Candidate character / 候选角色**：在大纲或正文里被引用、但尚未建立正式角色档案的小说角色，登记在候选池里、随剧情出场时再建档（promote）复用同一 Character UID。它不是已出场角色（无确认设定、未必进正文或记忆），也不是一次性龙套（不进候选池）。
- **Character importance / 角色重要度**：候选角色对剧情的影响程度，决定它是否进候选池、是否提醒作者建档。三档——一次性龙套（只出场一次、不影响剧情 → 不进池、不提醒）/ 次要候选（会复现但不推动主线 → 进池、目录可见、不提醒）/ 重要候选（推动剧情或承担核心关系 → 进池、提醒建档）。它不是 profile_stage（stub/sketch/full 衡量档案写了多少；重要度衡量该不该建、要不要催）。
- **POV character / 视角人物**：一章叙事所跟随的单一主视角角色，在章节规划期（写章纲时）确定并交给章节写手作为叙述视角。它不是本章 Appeared character 的集合——出场角色可有多个，主视角一章取一个；多视角章取主导视角。
- **Settings group / 设定组**：Novel settings 下同一类设定条目的集合，例如世界观、角色、场景或规则；当前客户端只把 `bible/<group>/*.{md,txt}` 的直接文件视为条目，它不是任意层级的文件管理器，`bible/<group>/**` 多级子目录属于后续 Engine contract 扩展。
- **World settings / 世界观设定**：Novel settings 下维护地理、历史、社会结构、功法/科技体系、地点和势力等世界相关设定的 Settings group；`/narracat:world` 输出的 `bible/world/<topic>.md` 直接文件在 Workbench 中以同组多条目切换展示，不等同于单一固定文档。
- **Writing context pack / 写作上下文包**：NarraCat Agent Core 在章节写作前交给章节写手的规范化章节输入，包含本章大纲、前文回放、角色动线、伏笔处理意图和叙述者腔调。它不是 NovelMemory 原始查询结果或临时提示词材料的直接拼接。
- **Blocking plausibility / 场面可执行性**：章节场面中的身体动作、空间位置、衣物遮挡、道具关系和观察结果必须能在读者心中成立。它不是要求补全每个动作过渡，也不限制玄幻设定、梦境、错觉或记忆碎片中的有意失真。
- **Inference overexposure / 推理外露过量**：章节中过多把线索意义、判断过程或结论直接说出，使场景读起来像线索注释而不是角色行动。它不是禁止调查章推理，而是要求推理的显性程度服务于当前动作、选择和风险。它与 Judgment sync rule 互补：外露过量管「过程不能变成线索注释」，同步律管「结论必须到位」。
- **Reader-knowledge contract / 读者知情契约**：写作质量层对「读者此刻应该知道什么」的约束总称，核心律令是 Judgment sync rule，覆盖主角判断、关键关联与设定语义（Setting-term task anchoring）的知情管理。它不要求读者知道全部事实，也不是悬念的对立面——悬念是读者和角色一起悬着，遮蔽是角色懂了读者还蒙着。
- **Setting-term task anchoring / 设定词任务锚定**：设定词在章节中承担戏剧任务（被使用、构成威胁、驱动选择）才出场，并在首次承担任务时通过动作或后果给读者一次功能性锚定。它不是词条式解释，也不限制氛围词的轻量提及；同时活跃设定词过多属于线索密度问题，由 Chapter question 收敛治理。
- **Chapter question / 章节问题**：一章唯一推进或回答的戏剧问题，补齐「全书悬问 → 单元 core_question → 章节问题 → 场景 pressure_point」的概念阶梯。场景的新信息只能作为该问题的进展或代价出现，不得各开独立新线索。它不是 dramatic_focus（后者是该问题的最强呈现时刻），也不限制情绪线的并行呈现。
- **Judgment sync rule / 判断同步律**：读者可以落后于事实，但不可落后于主角已形成的判断——主角每形成一个可指导行动的判断（推理结论、威胁评估、关联确认），同章内正文必须让读者拿到它。边界判据是**行动依赖**：主角接下来的行动或选择依赖该判断时必须露（此处直白句合法），仅为线索着色时受 Inference overexposure 约束。它不是 Inference overexposure 的对立面而是其对边；叙述者诡计类写法须由叙述者腔调层显式 opt-out，不是默认行为。
- **Scene-temperature modulation / 场景温度调制**：同一叙述者腔调在不同场景类型、压力强度和高潮位置下呈现不同句式温度与情绪释放方式。它避免把全书级热血、冷叙或急节奏误解为每个场景都必须使用同一种短句、留白或外放策略。
- **Style directive / 风格指令**：写作上下文包交给写手的、决定这本书「怎么说话」的运行时风格指令，由叙述声音卡与 style_profile 档位渲染而成，承载腔调、节奏与写法水位。契约上它只表达正向写法，不携带「克制／留白／节制抒情／收敛」类校准措辞——这类词会被弱模型误读为惜字如金、不写表情情绪、用句号堆砌伪深意，使正文失去画面感与代入。它不是叙述声音卡本身（那是作者填写的意图来源），也不是 Scene-temperature modulation（后者是同一腔调随场景变化的温度）。
- **网文感 / Web-novel feel**：让网文读者愿意一章章追下去的阅读体验——强代入、画面感、节奏起伏、钩子、情绪带入、期待及时兑现。它是**跨题材**的可读性，按每本书的题材与设定校准；认知流、言情、悬疑、种田同样要有网文感。它**不是「爽文」这一类型**，也不要求每本书靠升级碾压打脸；爽点 / 爽感只是制造网文感的**手段之一**，形态由设定决定（升级碾压 / 认知看透 / 情感甜 / 悬念解谜…）。具体光谱以作者整理的番茄排名作品为校准基准。
- **Mechanism annotation / 机制注解**：真人范例条目随附的「用了什么技法 + 为什么有效」解释，是范例可迁移性的载体——裸范例几乎无迁移效果。三处范例资产（corpus 语料条目、novel-craft 分册范例、narrator_voice 腔调范例）共用同一数据规范：无机制注解不入库。学习方学的是机制决策，不是范例的原文或句式表面。它不是原文摘录本身，也不是出处标注。
- **Chapter manuscript generated**：章节正文已生成。它只表示正文产物已经落盘，不等于该章节完成。
- **Chapter metadata / 章节元数据**：章节正文产物附带的结构化摘要、统计、锚点和回放信息；它服务于系统展示、记忆和后续流程，不属于作者对外复制的章节正文主体。它是 HTML 注释独有的内容，正文本体里没有等价人读版本，因此 Workbench 把它抽离后以「本章总结」结构化列表展示。
- **ReviewReport 数据契约 / 审校报告数据契约**：审校报告的结构化真相——`{ 章号, verdict（pass|fail）, issues[{ severity（blocker|note）, where, what, fix_hint }] }`，与 `novel_get_review` 读接口同形。它是 App 浏览审校报告的唯一数据源：App 消费结构化契约、不解析人读文本，人读呈现由 App 从契约渲染（机器字段经 ID→人话映射成徽标）。审校报告不再保留独立 markdown 本体——旧的文件末尾 `<!-- review_report_json -->` 注释孪生、`审修结果: PASS|FAIL` 锚点行及「阅读欲望评分 / 修订指令」人读维度，均随 4.0 双层最小审校与本契约化废除。契约的传输是实现细节（本地结构化文件 / 未来服务端 API），见 ADR 0018。
- **Premise / 立项卡**：Novel project 的九张创作地基卡（题材读者契约、核心钩子、金手指与爽点引擎、主角欲望与代价、对抗力量、中心戏剧问题、世界规则可冲突性、叙述声音、留白声明），由 setup 立项对话产出，是大纲、世界观与每章写作共同依赖的地基。它的结构化真相归 NarraCat Agent Core 引擎所有（ADR-0019），`bible/premise.md` 是引擎从契约机械渲染的只读视图、不再是作者直接编辑的源头。它不是 Novel settings（bible 设定条目），也不是大纲（plan 产出）。
- **Premise certainty / 立项卡确定度**：立项卡每一条内容自带的把握程度标记——schema enum 为 `canon`（已定，不可违背）/ `tentative`（暂定，可被后续创作修正）/ `open`（未确定，有意不定），未标注视为 canon。它是 ajv 枚举（schema SSOT），App 渲染为人读徽标（取代 #243 把三态在 App 硬编码的临时做法，见 ADR-0019），并据此高亮未确定项；「留白声明」卡由系统从各条 `open` 自动汇总、不单独手写。它不是审校 verdict，也不是任意自由标签；`open` 也不表示 App 可以直接补写内容。
- **Premise data contract / 立项卡数据契约**：立项卡的结构化真相 DTO（九卡 + 每条 prose 值 + 每条 Premise certainty），与 `novel_submit_premise` 入库形态同形，是 App 浏览立项卡的唯一数据源——App 消费契约、不解析 `premise.md` 反推结构（ADR-0018 同模式，继 ReviewReport 数据契约、大纲结构化之后）。地基卡（中心问题、金手指、主角欲望、对抗力量、叙述声音等写作每章依赖的卡）的实质修改是级联事件，经 Agent 同步记忆并出 CascadeImpactReport；App 轻量写回仅限 `canon` ⇄ `tentative` 的信心标记互标，进入/离开 `open`、补白和内容修改都经 `/narracat:revise-premise`。
- **Light review / 轻审**：写作主流程中每章默认执行的审校档位，职责是守住「别断、别错」——硬护栏与读者知情层面的拦截。它不评估「更好看」层（风格、反模式全套、钩子机制细查归 Deep review）；它也不是历史上 /review 触发的「轻审复查」——该名称已废除，其语义由 Deep review 吸收。
- **Deep review / 深审**：按需触发的专项审校档位，承载「更好看」层的评估（反模式全套、风格分析、章末钩子机制细查等）。它不在写作主流程内默认执行，不阻塞章节完成，定位是面向定向改进的专项检查而非 Light review 的简单加量。
- **Chapter completed**：章节已完成。它表示 NarraCat 写作流程已经完成正文、审修、记忆更新和项目状态收尾；Workbench 的当前阶段判断只能以这个状态为准。
- **Interrupted write**：写作中断。章节写作流程已经产生部分产物，但尚未达到 Chapter completed 的状态，需要恢复或处理后才能继续下一章。
- **Recovery action**：恢复操作。用户明确触发的操作，用来继续或收尾 Interrupted write；它不是打开项目时自动执行的后台修复，也不是自由对话，而是继续 NarraCat 写作流程。
- **Recoverable chapter**：待恢复章节。处于 Interrupted write 的章节；它不是普通当前阶段，而是会阻塞后续章节写作的恢复状态。
- **Write checkpoint**：写作断点。NarraCat 记录写作流程中断位置的项目状态；Recoverable chapter 必须由写作断点指向，不能只凭正文文件存在来推断。
- **Recovery diagnosis**：恢复诊断。Recovery action 启动前由 App 归纳的当前写作流程证据，用于告诉 NarraCat write 指令从标准流程的哪一步继续，而不是让 Agent 自行猜测。
- **Recover write action**：恢复写作动作。桌面端的产品化 Agent action，UI 文案为“继续完成本章”；它用于恢复 Write checkpoint 指向的章节，底层仍执行 NarraCat write 指令。
- **Recoverable failure**：恢复失败状态。Recover write action 失败或取消后，章节仍保持 Recoverable chapter，不自动清除 Write checkpoint，不标记为 Chapter completed，也不推进后续章节。
- **Title bar**：中间内容区域顶部标题栏，只放当前页面标题和必要的右侧操作。
- **Immediate titlebar action**：点击后立即在 App 内完成的 Title bar 操作，通常是 Client action，例如刷新。
- **Tab bar**：标题栏下方的子文件切换。tab 数量由当前菜单对应的子文件决定。
- **Chapter subview**：章节对象内部的正文、章节大纲、审修等子视图；它不是 Workbench Tab bar 的一级 tab，但共享同一个 Title bar 操作区。
- **Primary titlebar action**：Title bar 右侧固定主操作槽里的动作，代表当前页面此刻最自然的一步。
- **More titlebar actions**：Title bar 右侧更多菜单里的次级、低频或高风险动作。
- **Titlebar action target**：Title bar 操作实际作用的内容对象，默认是中间内容区域当前可见的文档或设定条目。
- **Copy visible document / 复制当前可见文档**：Title bar 中复制当前可见 Markdown 内容的 Client action；它作用于当前 Titlebar action target，不只限定章节正文。目标是章节正文时，只复制章节正文主体，不复制 Chapter metadata 或文件信息。
- **Empty guide**：空文档或缺失文档时的引导状态，包含插图、标题、正文和一个主要 Agent action。
- **Workbench generation state / 工作台生成中状态**：中间内容区域正在等待目标 Agent run 生成当前可见产物的状态；它不是普通项目读取或文档读取 loading。
- **Markdown viewer**：中间内容区域的 Markdown 浏览器。现阶段不提供 Markdown 编辑器。
- **用户通道 / User channel**：作者在客户端实际看到信息的两个界面——中间内容区的产物文档浏览与右侧 Agent 对话流。它是 ADR-0016「机器字段不入用户通道」约束的作用范围；它不是数据层或 Agent 之间的内部传递通道。

## Engineering Terms

- **App orchestration layer**：Electron 主进程和渲染进程中负责组织 SDK、资源、文件读取和 UI 状态的代码。
- **Engine contract**：App 编排层与创作引擎之间的边界，包括命令名称、项目文件结构、输出文件语义和运行资源入口。
- **Accepted engine contract / 已接受引擎契约**：Final upstream import 后 NarraCat-app 支持的唯一小说项目契约。Legacy NarraCat project 不通过兼容层或迁移门纳入该契约。
- **Structure state / 全书结构状态**：Novel project 状态中记录总卷数、总章数与章到卷归属的部分，是 Workbench 卷章树和章节定位的数据源。它由 NovelMemory 经校验机械写入，创作 Agent 不直写；它不是可从文件系统对账重建的索引缓存（区别于已细化章节集合）。
- **向量语义召回 / Semantic recall**：基于内置向量模型（embedding）按"语义相近"从记忆库捞回相关过往片段的检索方式，擅长主题性、模糊的相关性（例如把跟"背叛"有关的旧情节找回来）。它不理解角色之间的结构关系，无法沿关系链推出间接关系；它不是图多跳关系推理。
- **图多跳关系推理 / Multi-hop relationship reasoning**：沿记忆库中角色关系边走若干步、推出没有被直接记录的间接关系（例如 B、C 同师从 A → 师兄弟）的检索方式。它处理结构关系、不处理语义相似；它不是向量语义召回。它的产物是派生关系。
- **派生关系 / Derived relationship**：由图多跳关系推理从已记录的直接关系**推算出来**、而非被正文直接写出的间接关系。按当前决策它在写作组装时**读时现算**、默认不回存进记忆库（见相关 ADR）；它不是直接关系边（被正文明确写出、直接入库的那种关系）。
- **Agent Core distribution boundary / Agent Core 分发边界**：NarraCat Agent Core 随客户端本地分发时应被视为可被用户读取的产品资源，而不是保密边界；若未来需要保护核心编排、prompt 或商业策略，应通过服务端 Agent runtime 或云端编排边界处理。
- **Plugin resource**：Agent Core cutover 前同步到 `resources/NarraCat` 的 NarraCat plugin 运行资源；cutover 后它只是历史 Stage 1 概念，不再是当前源码或打包入口。
- **Agent Core 契约清单 / Agent Core manifest**：`agent-core/narracat/narracat.manifest.json`，App 发现并装配引擎 commands / agents / skills / schemas / templates 的唯一契约入口。它取代了早期为兼容旧 SDK 运行时而生成的 plugin 形态适配层（该适配工件已随 runtime 迁移退役）；它不是上游 plugin 身份，也不是长期同步机制。
- **分发资产分级 / Distribution asset tiers**：审视"打包会暴露什么"时，把随包资产拆成三类，各有不同边界与处置，**不可混为一谈"机密资产"**：①**创作引擎 prompt**（agents / skills / commands / schemas）——按 **Agent Core 分发边界**视为本地可读产品资源，客户端不做加密/混淆（security-by-obscurity，ADR-0017 已否决）；②**第三方版权语料**（见下条）——独立的版权边界，**ADR-0017 不覆盖**；③**研发痕迹**（eval / CHANGELOG / docs / 测试 / node_modules 等）——既非产品资源也非机密，是纯构建期内部物，**不应进入任何分发包**。
- **第三方版权语料边界 / Third-party copyrighted corpus boundary**：范例语料里若含第三方作品的原文片段，把它随客户端发出去触发的是**复制权 + 信息网络传播权**，判据是"有没有搬运原文这个动作"，**与"是否抄袭""AI 是否只作参考"无关**（参考/学习是引擎对范例的用法，不改变"产品分发了原文"这一事实）。它**不被 Agent Core 分发边界覆盖**——后者只管 prompt/编排。**本产品的处置**：范例语料本体已于 2026-08-05 移出客户端，改由只读语料服务端按需提供，本仓与安装包都不再持有第三方原文（见 ADR-0026 第 2 步）；更彻底的路径是换成原创或授权范例。
- **Bundled headless Agent runtime / 内置无界面 Agent 运行时**：NarraCat-app 随安装包提供、由 App orchestration layer 管控的后台运行能力，用于执行 Agent runtime、Agent Core 和 NovelMemory 等运行依赖；它不依赖用户电脑的 Node、shell、PATH 或终端，也不应产生额外可见 App / Terminal / Dock 入口。
- **Internal Release Candidate / 内测 RC**：面向人工验收和小范围内测的 macOS 安装包候选，必须包含锁定版本的 Agent Core 并通过打包验收，但不承诺公开分发、自动更新或 App Store 上架。
- **Unsigned Local RC / 未公证本机 RC**：只用于本机或受控测试机验证的 Internal Release Candidate，可使用未签名或开发签名，不作为面向普通用户的分发包。
- **Update-ready release / 可自动更新版本**：首个承诺面向已安装用户提供更新提示和应用内更新能力的公开发布版本。它之前的 Unsigned Local RC 或手动安装版本不属于自动更新链路，用户需要手动安装一次可自动更新版本后才进入后续更新链路。
- **macOS arm64 release target**：第一轮 Unsigned Local RC 的唯一目标平台，面向 Apple Silicon Mac 本机打包和验收。
- **RC artifact / RC 产物**：第一轮 Unsigned Local RC 的 DMG 交付物，以及用于辅助检查和启动 smoke 的 unpacked `.app`。
- **Packaged App smoke / 打包后 App smoke**：从 RC artifact 启动 packaged app，创建并打开一个 Novel project，以证明内置 Agent Core、项目模板、IPC、Workbench 读取和 packaged runtime 连通；它不包含真实 provider Agent run。
- **Packaged Agent runtime smoke / 打包后 Agent 运行时 smoke**：从 packaged `.app` 验证 Bundled headless Agent runtime 能启动 Agent SDK 与 NovelMemory 等后台运行依赖，且不依赖用户电脑环境、不产生 Terminal 或额外 Dock 可见入口；它不是从开发终端启动的 dev smoke。
- **Client build version / 客户端构建版本**：用户可见的客户端版本标识，用于 About 页面、RC artifact 命名和验收记录；它不是 `package.json` 的源码清单版本。
- **Checkpoint**：一个可验证的阶段状态，通常记录在计划、进度文档或提交信息中。
- **ADR**：Architecture Decision Record，记录已经做出的重要技术或产品架构决策。

## Avoid Ambiguity

- 不把 **Workbench** 叫成“编辑器”。当前核心是浏览、编排和 Agent 协作，不是自由 Markdown 编辑。
- 不把 **NarraCat-app** 说成简单的“插件壳”。Agent Core cutover 后，它是 NarraCat Agent Core 的产品所有者。
- 不把 **Reference works** 叫成“风格参考”。参考作品会影响前提、世界观、角色、结构和文风，不只是 style。
- 不把 **Agent action** 和 **Client action** 混为一谈。前者会调用 Agent，后者在客户端内完成。
- 不把空状态做成任务面板。空状态只负责引导用户触发一个明确操作。

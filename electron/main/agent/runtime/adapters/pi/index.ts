/**
 * Pi adapter 组装（阶段 2 切片①）：AgentRuntimeAdapter 的第二个实现，pi 包 import 的唯一收口区
 * （与 claude-sdk adapter 同规，check-architecture runtime-leak 强制）。
 *
 * 骨架边界（后续切片逐个兑现，未支持面一律 fail-loud）：
 * - mapMessage 已实装（切片②）：Pi 事件流 → 18 种 AgentEvent 的映射已完成；run 路径可接入。
 * - 会话/resume 已实装（切片⑦）：主会话 JSONL 持久化到 userData/pi-agent/sessions，会话桥首发
 *   narracat_pi_session 合成消息供 readSessionId 消费；args.resume 翻成 sessionStore.resumeSessionId
 *   续接既有会话（定位失败 fail-loud）；子会话保持 in-memory。
 * - 权限门禁四件套已实装（切片③）：工具面对齐 claude-sdk 的 DEFAULT_ALLOWED_TOOLS、目录圈禁 +
 *   canUseTool 委托经 pi-tool-guard 合成扩展注入、AskUserQuestion 经自定义工具重建、
 *   createSandboxedRunOptions 复用同一装配路径收窄工具面/圈禁根/cwd。
 * - 子 agent 与任务卡已实装（切片⑤）：引擎 agent 注册表（消费 args.agents overrides）+ 进程内嵌套
 *   子会话的 Task 工具 + TaskCreate/TaskUpdate 任务卡，见 pi-subagent.ts。
 * - NovelMemory 43 工具已接通（切片⑥）：createRunOptions/createSandboxedRunOptions 因此改成 async——
 *   面里含记忆工具名时才异步装载引擎 tools.js 定义 + 起 memory-host 通道，父/子会话共用同一份定义与
 *   通道（子会话按自己声明的面再过滤一次）。
 */
import { join } from 'node:path'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { createPortableFindTool, createPortableGrepTool } from './pi-fs-tools.ts'
import { resolveNarraCatEngine } from '../../../../engine/engine.ts'
import { resolveEngineAgentDefinitions } from '../../../../engine/engine-agent-registry.ts'
import type { EngineAgentDefinition } from '../../../../engine/engine-agent-registry.ts'
import { runSubagentGate } from '../../../../engine/engine-subagent-gates.ts'
import type { MemoryToolDefinition } from '../../../../memory/memory-tool-definitions.ts'
import { DEFAULT_ALLOWED_TOOLS as DEFAULT_SDK_ALLOWED_TOOLS } from '../../allowed-tools.ts'
import type {
  AgentRuntimeAdapter,
  RuntimeCanUseTool,
  RuntimeRunConfig,
  RuntimeSandboxRunConfig,
  RuntimeMapContext,
} from '../../types.ts'
import { resolveNovelAgentsGuide } from '../../novel-agents-guide.ts'
import { createPiModel, resolvePiModelAlias } from './pi-model.ts'
import type { PiThinkingMode } from './pi-model.ts'
import { createPiMaxOutputTokensPatch, resolvePiMaxOutputTokens } from './pi-max-output-tokens.ts'
import { createMemoryTools, productionPiMemoryBridge } from './pi-memory-tools.ts'
import type { MemoryToolChannel, PiMemoryBridge } from './pi-memory-tools.ts'
import { runPiSession } from './pi-session.ts'
import type { PiRunOptions, RunPiSessionArgs } from './pi-session.ts'
import { mapPiMessageToAgentEvents, PI_SESSION_MESSAGE_TYPE } from './pi-event-mapper.ts'
import { createPiEagerToolArgsRestorer } from './pi-eager-toolcall-args.ts'
import { createPiEngineHooksExtension } from './pi-engine-hooks.ts'
import { createSubagentEventChannel, createTaskCardTools, createTaskTool } from './pi-subagent.ts'
import { createAskUserQuestionTool, createPiToolGuard, mapSdkToolFaceToPi } from './pi-tool-guard.ts'

/** 与 claude-sdk adapter 的 DEFAULT_MAX_TURNS 对齐；命令路径经 RuntimeRunConfig.maxTurns 覆盖（48-72 档）。 */
const DEFAULT_PI_MAX_TURNS = 12
/** 子会话独立回合预算（切片⑤）：与父会话预算互不占用，判定语义相同（stopReason==='toolUse' 才算触顶）。 */
const SUBAGENT_MAX_TURNS = 24

interface BuildPiRunOptionsExtras {
  /** 覆盖圈禁白名单根（沙盒路径传 [workspaceDir]；缺省 = 基线三根 + cwd） */
  allowedRootsOverride?: string[]
  cwdOverride?: string
  sdkToolsOverride?: string[]
}

export interface ComputeBaselineAllowedRootsArgs {
  agentCorePath: string
  novelRootDir?: string
  projectPath?: string
  cwd: string
}

/**
 * 基线圈禁白名单根：agentCorePath + novelRootDir + projectPath + cwd 去重去空——与 SDK
 * additionalDirectories（sdk-runner.ts:184）逐项对齐，外加 cwd（SDK 里 cwd 隐式允许，pi guard
 * 无隐式概念显式列入）。抽成纯函数单独导出是为了给单测一个可观测缝：guard 是合成 Extension，
 * 圈禁根被闭包吞掉读不出来，PiRunOptions 对上层仍不透明，唯独这个组成规则本身值得单独钉住
 * （去重：projectPath===cwd 只留一条；去空：novelRootDir 缺省不进列表）。
 */
export function computeBaselineAllowedRoots({
  agentCorePath,
  novelRootDir,
  projectPath,
  cwd,
}: ComputeBaselineAllowedRootsArgs): string[] {
  return [...new Set([agentCorePath, novelRootDir, projectPath, cwd].filter((p): p is string => Boolean(p)))]
}

async function buildPiRunOptions(
  args: RuntimeRunConfig,
  memoryBridge: PiMemoryBridge,
  extras: BuildPiRunOptionsExtras = {},
): Promise<PiRunOptions> {
  const cwd = extras.cwdOverride ?? args.projectPath ?? args.appRoot
  const canUseTool = args.canUseTool as RuntimeCanUseTool | undefined
  const face = mapSdkToolFaceToPi(extras.sdkToolsOverride ?? args.allowedTools ?? DEFAULT_SDK_ALLOWED_TOOLS, args.disallowedTools)

  const agentCorePath = resolveNarraCatEngine({ appRoot: args.appRoot, resourcesPath: args.resourcesPath }).agentCorePath
  const allowedRoots =
    extras.allowedRootsOverride ??
    computeBaselineAllowedRoots({ agentCorePath, novelRootDir: args.config.novelRootDir, projectPath: args.projectPath, cwd })

  const guard = createPiToolGuard({ allowedRoots, cwd, signal: args.abortController.signal, canUseTool })
  // 无 canUseTool 就不注册 AskUserQuestion：问答桥缺失时注册了也必失败，宁可不给模型这个面。
  const includeAskUserQuestion = face.includeAskUserQuestion && canUseTool !== undefined
  const customTools: ToolDefinition[] = includeAskUserQuestion
    ? [createAskUserQuestionTool({ canUseTool: canUseTool!, signal: args.abortController.signal })]
    : []
  // pi 内置 find/grep 走 fd/ripgrep 二进制（查 PATH → 查不到就去 GitHub 下载），两条路在打包版上
  // 都不通：Finder 启动的 App 继承 launchd 窄 PATH，作者机器也不会装这类开发者工具。同名
  // customTool 覆盖内置那个。只在工具面本来就有它时注入——不给没这个面的会话凭空多一个工具。
  if (face.tools.includes('find')) customTools.push(createPortableFindTool(cwd))
  if (face.tools.includes('grep')) customTools.push(createPortableGrepTool(cwd))
  // 引擎钩子（字数提示/任务书系统词硬门）只在 loadNarraCatRuntime 时挂：学习/向导等沙盒会话
  // 本就不跑引擎契约，与 SDK 侧同条件不装载 plugin 对齐（brief 见 Task 5 任务书）。
  const agentDir = join(args.userDataPath ?? args.appRoot, 'pi-agent')
  // eager 工具参数救回（issue #16）修的是 pi 传输层的参数丢失，与引擎契约无关：任何会话都可能
  // 中招（学习/向导沙盒、direct-chat 一样打 Anthropic wire），故不受 loadNarraCatRuntime 门控。
  // 排在最前：它把被抹空的参数补回后，后续扩展看到的才是模型真正发出的那份。
  const model = createPiModel(args.config)
  // 输出上限兑现：pi 把实发 max_tokens 封在 32000，只有 before_provider_request 改得到请求体。
  // 只对查得到第一手文档依据的模型抬，其余不装配这个扩展（详见 pi-max-output-tokens.ts）。
  const maxOutputTokens = resolvePiMaxOutputTokens(model.provider, model.id)
  const extensions = [
    createPiEagerToolArgsRestorer(),
    guard,
    ...(args.loadNarraCatRuntime ? [createPiEngineHooksExtension({ cwd })] : []),
    ...(maxOutputTokens === undefined ? [] : [createPiMaxOutputTokensPatch(maxOutputTokens)]),
  ]

  // NovelMemory 工具（切片⑥）：与 SDK createNovelMemoryMcpServers 同门条件（跑引擎契约 + 有项目），
  // face 无记忆名（如 direct-chat 默认面）时零装载。
  const includeMemoryTools = Boolean(args.loadNarraCatRuntime) && Boolean(args.projectPath) && face.memoryTools.length > 0
  let memoryContext: { definitions: MemoryToolDefinition[]; channel: MemoryToolChannel } | undefined
  if (includeMemoryTools) {
    memoryContext = {
      definitions: await memoryBridge.loadDefinitions(agentCorePath),
      channel: memoryBridge.createChannel({
        projectPath: args.projectPath!,
        appRoot: args.appRoot,
        resourcesPath: args.resourcesPath,
        userDataPath: args.userDataPath,
        agentCorePath,
      }),
    }
    customTools.push(...createMemoryTools({ definitions: memoryContext.definitions, allowedNames: face.memoryTools, channel: memoryContext.channel }))
  }

  // 子 agent 派发（切片⑤）：只在跑引擎契约且工具面开了 Agent/Task 时注册，与引擎钩子同门条件。
  const channel = createSubagentEventChannel()
  const includeTaskDispatch = Boolean(args.loadNarraCatRuntime) && face.includeTaskDispatch

  /**
   * 子会话装配：工具面 = agent 自己声明的面；guard 与引擎钩子各起新实例但配置全继承（记忆库直写
   * 拦截、字数提示对子会话同样生效）；model/provider/apiKey/agentDir 继承父配置；maxTurns 独立。
   * 子会话记忆工具（切片⑥）：按子 agent 自己声明的面过滤注入；三禁纪律不变（无 Task/任务卡/
   * AskUserQuestion——childFace 的三个旗标一律不读，子 agent 不能再派子 agent、不驱动主会话任务卡、
   * 不直接打断用户）。父会话未开记忆面（memoryContext 缺席）时子会话也拿不到——与父门条件一致。
   */
  const buildChildRunOptions = (
    definition: EngineAgentDefinition,
    childAbort: AbortController,
    thinking: PiThinkingMode = 'provider-default',
  ): PiRunOptions => {
    const childFace = mapSdkToolFaceToPi(definition.tools ?? ['Read'], args.disallowedTools)
    const childGuard = createPiToolGuard({ allowedRoots, cwd, signal: childAbort.signal, canUseTool })
    const childMemoryTools = memoryContext
      ? createMemoryTools({ definitions: memoryContext.definitions, allowedNames: childFace.memoryTools, channel: memoryContext.channel })
      : []
    // 与父会话同一条纪律：写手/审校都跑在子会话里，漏了这条它们的 find/grep 照样是坏的。
    const childCustomTools = [
      ...childMemoryTools,
      ...(childFace.tools.includes('find') ? [createPortableFindTool(cwd)] : []),
      ...(childFace.tools.includes('grep') ? [createPortableGrepTool(cwd)] : []),
    ]
    // model 别名映射（生产接线门前项②）：frontmatter 三别名走模型池槽位，其余继承 run 模型。
    // thinking 档位（issue #42）由派发方逐次给：默认听 provider 的，冷改这类低自由度任务显式关掉。
    const childModel = createPiModel(args.config, resolvePiModelAlias(args.config, definition.model), thinking)
    const childMaxOutputTokens = resolvePiMaxOutputTokens(childModel.provider, childModel.id)
    return {
      model: childModel,
      provider: childModel.provider,
      apiKey: args.apiKey,
      cwd,
      agentDir,
      tools: [...new Set([...childFace.tools, ...childCustomTools.map((tool) => tool.name)])],
      maxTurns: SUBAGENT_MAX_TURNS,
      systemPrompt: definition.prompt,
      abortController: childAbort,
      // 各子会话新起一个实例：救回逻辑的 eager 快照是扩展闭包内的 run 级状态，共用实例会让
      // 并发子会话互相串参数。
      extensions: [
        createPiEagerToolArgsRestorer(),
        childGuard,
        createPiEngineHooksExtension({ cwd }),
        // 子会话可能走轻量槽的另一个模型 id，故按 childModel 重新解析，不继承父会话的值。
        ...(childMaxOutputTokens === undefined ? [] : [createPiMaxOutputTokensPatch(childMaxOutputTokens)]),
      ],
      customTools: childCustomTools,
    }
  }

  if (includeTaskDispatch) {
    customTools.push(
      createTaskTool({
        // 注册表解析（磁盘 IO）整体懒在闭包里：createTaskTool 内部缓存 promise，首次派发才解析，
        // 不派子 agent 的 run 零解析。解析失败原样冒泡 → execute 的 try/catch → 工具 isError 结果，
        // 模型看得见真实原因（fail-loud）。刻意不兜底成空注册表：空名单会被模型读成「无子 agent
        // 可用」转而在主会话里硬写，质量层静默塌掉，比报错更坏。
        loadDefinitions: () => resolveEngineAgentDefinitions({ agentCorePath, overrides: args.agents }),
        buildChildRunOptions,
        channel,
        parentSignal: args.abortController.signal,
        // 出稿/回执质量门（Task 6）：chapter-writer/memory-keeper 子会话结束后追加诊断反馈，
        // 恒 fail-open（createTaskTool 内部已把 gate 异常吞成警告，runSubagentGate 自身也不抛）。
        gate: runSubagentGate,
        cwd,
      }),
    )
  }
  if (face.includeTaskCards) customTools.push(...createTaskCardTools())

  // 小说 AGENTS.md/CLAUDE.md 精准注入（ADR-0028 隔离纪律的单文件版）：只主会话读，且只在跑引擎
  // 契约时读——沙盒会话（学习/向导/连通性测试，loadNarraCatRuntime:false）零注入，与引擎钩子/记忆
  // 工具同门条件。子会话（buildChildRunOptions）不读，appendix 不透传。
  const agentsGuide = args.loadNarraCatRuntime ? await resolveNovelAgentsGuide(args.projectPath) : null

  return {
    model,
    provider: model.provider,
    apiKey: args.apiKey,
    cwd,
    agentDir,
    // pi 的 isAllowedTool 会把不在 tools 白名单里的 custom tool 过滤掉（切片③已踩），故自定义工具
    // 名必须同步登记进白名单。
    // 去重：portable find 与内置同名，两边都列会让工具面出现重复项（pi 侧无害，但工具面是
    // 对外可观测的契约，保持它等于「这个会话真正能用的工具集合」）。
    tools: [...new Set([...face.tools, ...customTools.map((tool) => tool.name)])],
    maxTurns: args.maxTurns ?? DEFAULT_PI_MAX_TURNS,
    systemPrompt: typeof args.systemPrompt === 'string' ? args.systemPrompt : undefined,
    systemPromptAppendix: agentsGuide ?? undefined,
    abortController: args.abortController,
    extensions,
    customTools,
    ...(includeTaskDispatch ? { subagentChannel: channel } : {}),
    // 会话持久化（切片⑦）：主会话恒持久化（沙盒会话同规，对齐 SDK persistSession 默认 true，为
    // 向导轮次 resume 预留同构行为）；子会话（buildChildRunOptions）不传 → in-memory。
    sessionStore: {
      dir: join(agentDir, 'sessions'),
      ...(args.resume ? { resumeSessionId: args.resume } : {}),
    },
  }
}

export function createPiAdapter(
  deps: { runSession?: (args: RunPiSessionArgs) => AsyncGenerator<unknown>; memoryBridge?: PiMemoryBridge } = {},
): AgentRuntimeAdapter {
  const runSession = deps.runSession ?? runPiSession
  const memoryBridge = deps.memoryBridge ?? productionPiMemoryBridge
  return {
    id: 'pi',
    createRunOptions(args: RuntimeRunConfig): Promise<unknown> {
      return buildPiRunOptions(args, memoryBridge)
    },
    createSandboxedRunOptions(args: RuntimeSandboxRunConfig): Promise<unknown> {
      // 与 createSandboxedSdkOptions 同纪律：只收窄工具面与目录圈禁两项（学习/向导会话同款），
      // 其余与 createRunOptions 完全一致；圈禁根只剩 workspaceDir，cwd 也切到 workspaceDir。
      const { sandbox, ...rest } = args
      return buildPiRunOptions(rest, memoryBridge, {
        sdkToolsOverride: sandbox.tools,
        allowedRootsOverride: [sandbox.workspaceDir],
        cwdOverride: sandbox.workspaceDir,
      })
    },
    startRun({ prompt, options }): AsyncIterable<unknown> {
      return runSession({ prompt, options: options as PiRunOptions })
    },
    mapMessage(message: unknown, ctx: RuntimeMapContext) {
      return mapPiMessageToAgentEvents(ctx, message)
    },
    readSessionId(message: unknown): string | undefined {
      if (typeof message !== 'object' || message === null) return undefined
      const record = message as Record<string, unknown>
      if (record.type !== PI_SESSION_MESSAGE_TYPE) return undefined
      return typeof record.sessionId === 'string' && record.sessionId ? record.sessionId : undefined
    },
  }
}

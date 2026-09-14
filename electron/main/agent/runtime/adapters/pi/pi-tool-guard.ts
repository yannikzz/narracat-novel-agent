/**
 * Pi 权限门禁（阶段2切片③）：SDK 侧 additionalDirectories 目录圈禁 + canUseTool 权限桥在 Pi 的重建件。
 * - 工具面映射：run 路径的 SDK 工具白名单 → pi 内置工具名；Agent/Task 与 TaskCreate/TaskUpdate 不进
 *   pi 内置工具数组，改置 includeTaskDispatch/includeTaskCards 两个旗标，由装配方注册成自定义工具
 *   （切片⑤，见 pi-subagent.ts）；Skill 与未知 mcp__* 仍丢弃；NovelMemory 前缀经 memoryTools 放行
 *   （切片⑥）。
 * - 目录圈禁：pi 工具无目录概念，read/write/edit/grep/find/ls 每次调用先经 expandLikePi 复刻 pi
 *   自身 path-utils.js 的 expandPath（`~`/`~/x` 展开成 homedir、剥前导 `@`、Unicode 空格归一），
 *   再 realpath 圈到白名单根（软链按真实路径判、不存在的新文件按最深存在祖先判）——不复刻这步
 *   展开，guard 判定的路径与 pi 实际打开的文件就对不上（`~/.ssh/id_rsa` 会被当相对路径回落 cwd
 *   误放行，pi 却真读了 homedir）；bash 刻意不圈（与 SDK additionalDirectories 不约束 Bash 的
 *   语义对齐，危险面由 canUseTool 的记忆库正则兜）。
 * - canUseTool 委托：pi 工具名映射回 SDK 名后调运行时中立权限桥（记忆库 6 正则单一来源），
 *   deny → block。AskUserQuestion 例外：其 tool_call 不委托（问答流程由自定义工具 execute 自理，
 *   见同文件 Task 3 的 createAskUserQuestionTool），否则一次提问会触发两轮问答。
 * 载体是手工构造的合成 Extension（纯数据对象）：包根 exports 不含 loadExtensionFromFactory，
 * Extension 接口的九个字段照 loader.js createExtension 的空集合形状填。
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { createSyntheticSourceInfo, defineTool } from '@mariozechner/pi-coding-agent'
import type { Extension, ToolCallEvent, ToolCallEventResult, ToolDefinition } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import type { RuntimeCanUseTool } from '../../types.ts'
import { MEMORY_TOOL_PREFIX } from './pi-memory-tools.ts'
import { TASK_CREATE_TOOL_NAME, TASK_TOOL_NAME, TASK_UPDATE_TOOL_NAME } from './pi-subagent.ts'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

/**
 * SDK（Claude Code 风格）工具名 → pi 内置工具真名。导出供 pi-toolcall-name-normalizer 复用：
 * 归一判定必须与这张表同源，否则新增映射时「白名单翻译」跟上了而「模型调用归一」没跟上，
 * 会重演 issue #100（Glob→find 这类改名，靠大小写规则结构上够不着）。
 */
export const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'find',
  LS: 'ls',
}

const PI_TO_SDK_TOOL_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(SDK_TO_PI_TOOL_NAME).map(([sdkName, piName]) => [piName, sdkName]),
)

/** 路径字段受圈禁的 pi 内置工具（字段全叫 path；grep/find/ls 可选，缺省 = cwd）。 */
const PATH_GUARDED_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls'])

export interface MappedPiToolFace {
  /** createAgentSession 的 tools 白名单（pi 内置工具名） */
  tools: string[]
  /** SDK 白名单含 AskUserQuestion 时置位：pi 无内置等价物，经 customTools 注册 */
  includeAskUserQuestion: boolean
  /** SDK 白名单含 Agent/Task 时置位（切片⑤）：子 agent 派发工具经 customTools 注册 */
  includeTaskDispatch: boolean
  /** SDK 白名单含 TaskCreate/TaskUpdate 时置位（切片⑤）：任务卡两件套经 customTools 注册 */
  includeTaskCards: boolean
  /** NovelMemory 全限定工具名（切片⑥）：经 customTools 注册，非 pi 内置 */
  memoryTools: string[]
}

/** SDK 侧 Agent/Task 两个名字都指向"派发子 agent"（引擎命令文本用 Task，白名单登记为 Agent）。 */
const TASK_DISPATCH_SDK_NAMES = new Set(['Agent', TASK_TOOL_NAME])
const TASK_CARD_SDK_NAMES = new Set([TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME])

export function mapSdkToolFaceToPi(sdkTools: string[], disallowedTools?: string[]): MappedPiToolFace {
  const disallowed = new Set(disallowedTools ?? [])
  const tools: string[] = []
  const memoryTools: string[] = []
  let includeAskUserQuestion = false
  let includeTaskDispatch = false
  let includeTaskCards = false
  for (const sdkName of sdkTools) {
    if (disallowed.has(sdkName)) continue
    if (sdkName === ASK_USER_QUESTION_TOOL_NAME) {
      includeAskUserQuestion = true
      continue
    }
    if (TASK_DISPATCH_SDK_NAMES.has(sdkName)) {
      includeTaskDispatch = true
      continue
    }
    if (TASK_CARD_SDK_NAMES.has(sdkName)) {
      includeTaskCards = true
      continue
    }
    if (sdkName.startsWith(MEMORY_TOOL_PREFIX)) {
      if (!memoryTools.includes(sdkName)) memoryTools.push(sdkName)
      continue
    }
    const piName = SDK_TO_PI_TOOL_NAME[sdkName]
    if (piName && !tools.includes(piName)) tools.push(piName)
  }
  return { tools, includeAskUserQuestion, includeTaskDispatch, includeTaskCards, memoryTools }
}

/**
 * realpath 到最深「存在的祖先」再拼回剩余段：write/edit 新文件时目标还不存在，直接 realpath 会
 * ENOENT——逐级向上找到第一个存在的祖先解析软链，再把未创建的尾段拼回来，逃逸判定不留死角。
 */
function resolveRealPath(absolutePath: string): string {
  let current = absolutePath
  const pendingSegments: string[] = []
  while (true) {
    try {
      const real = realpathSync(current)
      return pendingSegments.length === 0 ? real : resolve(real, ...pendingSegments.slice().reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolutePath
      pendingSegments.push(basename(current))
      current = parent
    }
  }
}

function isWithinRoot(resolved: string, root: string): boolean {
  const boundary = root.endsWith(sep) ? root : root + sep
  return resolved === root || resolved.startsWith(boundary)
}

/** 与 pi dist/core/tools/path-utils.js 的 UNICODE_SPACES 逐字符对齐（0.73.1）：NBSP/多种宽度空格。 */
const UNICODE_SPACES = /[  -   　]/g

/**
 * 与 pi 的 dist/core/tools/path-utils.js expandPath 逐项对齐（0.73.1，包 exports 不含该内部函数，
 * 故在此复刻）：guard 判定前必须先做同款展开，否则 guard 判的路径 ≠ pi 六个路径工具（经
 * resolveToCwd/resolveReadPath，两者都先调 expandPath）实际打开的路径——`~`/`~/x` 不展开会被
 * node:path 当普通相对路径 resolve 到 cwd 下（通常不存在，回落祖先判定=cwd，误放行），前导 `@`
 * 不剥离、Unicode 空格不归一同理。pi 升级须重新核对该源文件是否变化。
 */
function expandLikePi(raw: string): string {
  const withoutAtPrefix = raw.startsWith('@') ? raw.slice(1) : raw
  const normalized = withoutAtPrefix.replace(UNICODE_SPACES, ' ')
  if (normalized === '~') return homedir()
  if (normalized.startsWith('~/')) return homedir() + normalized.slice(1)
  return normalized
}

export interface CreatePiToolGuardArgs {
  /** 圈禁白名单根（构造时统一 realpath；不存在的根静默剔除，与 SDK uniqueNonEmptyPaths 容忍度一致） */
  allowedRoots: string[]
  cwd: string
  /** 本次 run 的 abort signal：透传给 canUseTool（deny 路径不等待，仅取消语义占位） */
  signal: AbortSignal
  canUseTool?: RuntimeCanUseTool
}

export function createPiToolGuard({ allowedRoots, cwd, signal, canUseTool }: CreatePiToolGuardArgs): Extension {
  const roots = allowedRoots.flatMap((root) => {
    try {
      return [realpathSync(root)]
    } catch {
      return []
    }
  })

  async function onToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    if (PATH_GUARDED_TOOLS.has(event.toolName)) {
      // ToolCallEvent 是按 toolName 判别的联合类型（Read/Write/Edit/Grep/Find/Ls ToolInput 各不相同），
      // 但六者共同点是都可能带 path 字段；这里只需统一读 path，不关心其余字段的具体形状，窄化为
      // Record<string, unknown> 后用 typeof 守卫取值，比为六种 ToolInput 分别写类型收窄更省。
      const input = event.input as Record<string, unknown>
      const rawPath = typeof input.path === 'string' && input.path.trim() ? input.path : undefined
      // pi 六个路径工具落地前都经 expandLikePi 同款展开（resolveToCwd/resolveReadPath 皆先调
      // expandPath）：不展开就判定，`~`/`@` 前缀路径会被判成别的路径，guard 判定的路径与 pi
      // 实际打开的文件对不上。
      const expandedPath = rawPath === undefined ? undefined : expandLikePi(rawPath)
      const target = expandedPath === undefined ? cwd : isAbsolute(expandedPath) ? expandedPath : resolve(cwd, expandedPath)
      const resolved = resolveRealPath(target)
      if (!roots.some((root) => isWithinRoot(resolved, root))) {
        return { block: true, reason: `路径越界：${target} 不在本次运行允许的目录内。` }
      }
    }

    if (!canUseTool) return undefined
    if (event.toolName === ASK_USER_QUESTION_TOOL_NAME) return undefined
    const sdkName = PI_TO_SDK_TOOL_NAME[event.toolName] ?? event.toolName
    // RuntimeCanUseTool 的 input 参数是运行时中立契约的 Record<string, unknown>（见 ../../types.ts）；
    // ToolCallEvent 各分支的具体 ToolInput 结构在对象层面本就满足该形状，这里只是抹平联合类型标注。
    const decision = await canUseTool(sdkName, event.input as Record<string, unknown>, {
      toolUseID: event.toolCallId,
      signal,
    })
    if (decision.behavior === 'deny') return { block: true, reason: decision.message }
    // allow 分支只能放行，decision.updatedInput 被丢弃：pi 的 ToolCallEventResult 只有 block/pass
    // 两种语义，没有 SDK canUseTool allow 分支「用 updatedInput 改写模型实际执行的输入」那种改写
    // 通道。若未来有权限桥依赖 updatedInput 生效（如脱敏改写路径），在 pi 侧会静默不生效——切片④
    // 接引擎契约时若引入这类改写型权限逻辑须在此补桥或提前拦截。
    return undefined
  }

  const guardPath = '<narracat:pi-tool-guard>'
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>()
  handlers.set('tool_call', [async (event) => onToolCall(event as ToolCallEvent)])
  return {
    path: guardPath,
    resolvedPath: guardPath,
    sourceInfo: createSyntheticSourceInfo(guardPath, { source: 'narracat' }),
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  }
}

const askUserQuestionSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: 'The complete question to ask the user' }),
      header: Type.String({ description: 'Very short label (max 12 chars)' }),
      options: Type.Array(
        Type.Object({
          label: Type.String(),
          description: Type.Optional(Type.String()),
          preview: Type.Optional(Type.String()),
        }),
        { minItems: 2, maxItems: 4 },
      ),
      multiSelect: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1, maxItems: 4 },
  ),
})

export interface CreateAskUserQuestionToolArgs {
  canUseTool: RuntimeCanUseTool
  /** run 级 abort signal 兜底；execute 收到工具级 signal 时优先用工具级。 */
  signal: AbortSignal
}

/**
 * AskUserQuestion 在 pi 的重建件：SDK 是内置工具+canUseTool 拦截改写，pi 无内置等价物——
 * 用自定义工具承载，execute 直接委托运行时中立 canUseTool（问答桥在那边：发 question.requested
 * 事件、挂起等渲染进程作答、超时/取消走 deny）。allow → 把 answers 以 JSON 文本回给模型；
 * deny → throw（agent-loop 转 isError 工具结果，模型看到取消原因）。
 */
export function createAskUserQuestionTool({ canUseTool, signal }: CreateAskUserQuestionToolArgs): ToolDefinition {
  return defineTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: '向用户提问',
    description:
      'Ask the user one or more multiple-choice questions when you are blocked on a decision only they can make. Each question needs 2-4 options.',
    parameters: askUserQuestionSchema,
    async execute(toolCallId, params, toolSignal) {
      const decision = await canUseTool(ASK_USER_QUESTION_TOOL_NAME, params as Record<string, unknown>, {
        toolUseID: toolCallId,
        signal: toolSignal ?? signal,
      })
      if (decision.behavior === 'deny') {
        throw new Error(decision.message)
      }
      const answers =
        decision.updatedInput && typeof decision.updatedInput === 'object'
          ? (decision.updatedInput as Record<string, unknown>).answers ?? {}
          : {}
      return {
        content: [{ type: 'text', text: JSON.stringify({ answers }) }],
        details: undefined,
      }
    },
  }) as ToolDefinition
}

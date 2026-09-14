/**
 * 工具名大小写归一扩展（issue #100）：模型按引擎 prompt 的 Claude Code 风格大写名（`Read`/`Write`/
 * `Edit`/`Grep`…）发起调用时，把它归一成本次会话真实注册的那个名字。
 *
 * ## 根因：说明书与工具清单用的是两套名字
 *
 * - 引擎 prompt 是按 Claude Code Plugin 规范写的，正文与 `allowed-tools` frontmatter 一律用大写名
 *   （`agent-core/narracat/CLAUDE.md` 把「工具名」列为有下游机械消费者的硬契约）。
 * - pi 的内置工具真名是小写（`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`）；`pi-tool-guard.ts`
 *   的 `SDK_TO_PI_TOOL_NAME` 只翻译了「App 白名单 → pi 工具面」这一个方向。
 *
 * 于是模型读到的说明书说 `Read`，拿到的工具清单里却只有 `read`。强模型会按工具清单纠偏，所以
 * 官方直连渠道一直没暴露；弱模型与第三方中转网关的模型照着说明书抄大写名，`pi-agent-core` 的
 * `prepareToolCall`（dist/agent-loop.js）是大小写敏感精确匹配，直接返回 `Tool Read not found`，
 * 且模型往往反复重试同一个名字——读写工具在整条创作链上全线不可用（issue #100 的原始报告里，
 * 设定写不进项目文件；issue #102 是同一根因的下游：`Read` 失败被模型读成「config.yaml 不存在」，
 * 于是指引用户去跑 `/narracat:init`，而桌面端用户根本没有执行斜杠命令的入口）。
 *
 * ## 为什么修在这里，而不是改引擎 prompt 或加别名工具
 *
 * - **不改引擎 prompt**：工具名是引擎的对外硬契约，引擎按 Claude Code Plugin 规范维护（ADR-0007）。
 *   把 24 个 prompt 文件改成 pi 的小写私名，等于把引擎绑死在当前 runtime 的命名上，方向是反的——
 *   runtime 差异本就该由 App 的适配层吸收，这个文件所在的目录就是那一层。
 * - **不注册大写别名工具**：`customTools` 里塞一套同义工具会让工具清单翻倍（模型侧更易混淆、
 *   system prompt 变长），还要同步维护 `PATH_GUARDED_TOOLS` 的圈禁名单——漏一个就是路径越界护栏
 *   被绕过的安全回归。归一发生在工具查找之前，下游（guard 圈禁、canUseTool、工具卡渲染、telemetry
 *   计数）看到的仍是唯一那个 pi 真名，零改动、零分叉。
 *
 * ## 落点与时序（与 pi-eager-toolcall-args.ts 同一套官方扩展点）
 *
 * `agent-session.js` 的 `message_end` 分支走 `emitMessageEnd`，返回 `{ message }` 由上游
 * `_replaceMessageInPlace` 原地写回（会同步到 agent 状态、后续事件与会话持久化）。时序上
 * `agent-loop.js` L96 emit message_end → L111 才提取 toolCalls → L115 才执行工具，改名落在
 * 查找之前。`emitMessageEnd` 对多个扩展是**链式**的（`currentEvent = { ...event, message:
 * currentMessage }`），所以与 eager 参数救回共存安全：那个扩展排在前，本扩展看到的是参数已补全的
 * 那份 message。
 *
 * 试过且不可行的落点，与 eager 那份同因：`tool_call` 扩展事件在 `prepareToolCall` 之后才触发
 * （名字对不上时上游已经返回 not found，钩子不会被调用），且 `ToolCallEventResult` 只有
 * block/pass 两种语义，没有改写通道。
 *
 * ## 判定纪律：精确优先，大小写不敏感唯一回退
 *
 * 与上游 `pi-ai` 自己的做法同构——`dist/providers/anthropic.js` 的 `fromClaudeCodeName` 就是
 * 「大小写不敏感匹配回落真实工具名」，只是上游仅在 OAuth 路径启用（那条路径上 pi 把工具名伪装成
 * Claude Code 名发出去，回来自然要转回来）。本 App 恒走 API key 路径，享受不到，这里补齐。
 *
 * 比上游多一条唯一性检查：只有在大小写不敏感候选**唯一**时才改名。真正未注册的工具（模型幻觉出
 * 的 `WebSearch` 之类）与大小写歧义（同时存在 `read`/`Read`）一律原样放行，让它照常报 not found
 * ——误伤面不扩大，模型也能从错误里得到真实反馈。
 */
import { createSyntheticSourceInfo } from '@mariozechner/pi-coding-agent'
import type { Extension } from '@mariozechner/pi-coding-agent'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 归一单个工具名：命中真名返回 undefined（不改），否则大小写不敏感唯一命中才返回真名。
 * 导出供测试直接覆盖判定表，不必每次构造整条消息。
 */
export function resolveToolCallName(rawName: string, knownToolNames: readonly string[]): string | undefined {
  if (knownToolNames.includes(rawName)) return undefined
  const lowerName = rawName.toLowerCase()
  const candidates = knownToolNames.filter((name) => name.toLowerCase() === lowerName)
  // 零命中 = 模型调了个本会话真没有的工具；多命中 = 名字本身有大小写歧义。两种都原样交给上游报错。
  if (candidates.length !== 1) return undefined
  return candidates[0]
}

/**
 * pi 包根 barrel 没导出 `MessageEndEvent` / `MessageEndEventResult`（只在内部
 * `core/extensions/types.d.ts`），照 `agent-session.js` `_emitExtensionEvent` 实际推送的形状在此
 * 本地声明等价结构（同 pi-engine-hooks.ts / pi-eager-toolcall-args.ts 的先例）。
 */
type PiMessageEndEvent = {
  message: unknown
}
type PiMessageEndEventResult = {
  message: unknown
}

export interface CreatePiToolCallNameNormalizerArgs {
  /**
   * 本次会话真实注册的全部工具名，惰性求值。
   *
   * 装配处（index.ts）的 `customTools` 是边构造边 push 的，而 extensions 数组在那之前就定义了；
   * 惰性回调让本扩展不依赖装配顺序——message_end 触发时工具面早已定型。传入的集合须与
   * `PiRunOptions.tools` 同源（pi 内置面 + 自定义工具名），否则会把合法调用误判成未知工具。
   */
  knownToolNames: () => readonly string[]
}

export function createPiToolCallNameNormalizer({ knownToolNames }: CreatePiToolCallNameNormalizerArgs): Extension {
  function onMessageEnd(event: PiMessageEndEvent): PiMessageEndEventResult | undefined {
    const message = event.message
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) return undefined
    // 整条消息没有工具调用时不求值工具名（绝大多数纯文本回合走这条捷径）。
    if (!message.content.some((block) => isRecord(block) && block.type === 'toolCall')) return undefined

    const known = knownToolNames()
    let normalized = false
    const content = message.content.map((block) => {
      if (!isRecord(block) || block.type !== 'toolCall') return block
      if (typeof block.name !== 'string' || !block.name) return block
      const resolved = resolveToolCallName(block.name, known)
      if (resolved === undefined) return block
      normalized = true
      return { ...block, name: resolved }
    })

    if (!normalized) return undefined
    return { message: { ...message, content } }
  }

  const extensionPath = '<narracat:pi-toolcall-name-normalizer>'
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>()
  handlers.set('message_end', [async (event) => onMessageEnd(event as PiMessageEndEvent)])
  return {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: createSyntheticSourceInfo(extensionPath, { source: 'narracat' }),
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  }
}

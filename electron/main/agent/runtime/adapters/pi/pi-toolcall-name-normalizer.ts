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
 * ## 落点（与 pi-eager-toolcall-args.ts 同一套官方扩展点）
 *
 * `agent-session.js` 的 `message_end` 分支走 `emitMessageEnd`，返回 `{ message }` 由上游
 * `_replaceMessageInPlace` **原地** mutate 写回（delete 掉原对象全部 key 再 Object.assign），而
 * `agent-loop.js` 执行工具时读的正是同一个 message 对象——所以这是唯一可用的替换通道：
 * message_start 那几处上游传的是 `{...copy}`，在那里改根本不生效。
 *
 * 返回的 message **必须字段完整**（尤其 `role`）：`runner.js` 的 emitMessageEnd 会校验 role 与原
 * 消息一致，不一致就丢弃整个替换、归一静默失效。故一律 spread 原 message，只换 `content`。
 *
 * `emitMessageEnd` 对多个扩展是**链式**的（`currentEvent = { ...event, message: currentMessage }`），
 * 与 eager 参数救回共存安全：那个扩展排在前，本扩展看到的是参数已补全的那份 message。
 *
 * 试过且不可行的落点，与 eager 那份同因：`tool_call` 扩展事件在 `prepareToolCall` 之后才触发
 * （名字对不上时上游已经返回 not found，钩子不会被调用），且 `ToolCallEventResult` 只有
 * block/pass 两种语义，没有改写通道。
 *
 * ## ⚠️ 时序靠的是余量，不是上游契约
 *
 * **不要把「message_end 一定早于工具查找」当成结构性保证——上游并没有保证。**
 * `agent-session.js` 的 `_handleAgentEvent` 只把处理**排进 `_agentEventQueue`** 就返回，没有把那个
 * promise 交出去；`pi-agent-core/dist/agent.js` 里 `await listener(event, signal)` 于是 await 到
 * `undefined`——**agent loop 不等扩展跑完就继续**。扩展链是异步追赶工具查找的。
 *
 * 今天能生效，靠的是 message_end 之前排队的处理**恰好全程没有宏任务**（eager 的 message_update
 * handler 纯同步、引擎钩子用 readFileSync、上游会话持久化用 appendFileSync），队列得以在工具查找
 * 之前排空。实测两种翻车方式：任一前置事件的 handler 里放一个 setTimeout / 异步 fs / 网络调用，
 * 或换一种流式事件序列——`tool_execution_start` 拿到的就是未归一的 `Read`，整条修复空转。
 *
 * 失败方向是 fail-closed（`Tool Read not found`，与修复前同症状，无安全后果），但它**静默**。因此：
 *
 * - **禁止**在 message_start / message_update / message_end 的 handler 里做异步 I/O（同一条纪律对
 *   `pi-eager-toolcall-args.ts` 同样成立：它的参数救回也靠这份余量）。
 * - 护栏是 `pi-toolcall-name-normalizer.integration.test.ts`（走真实会话 + 假 streamFn，断言工具
 *   真的执行了）。**pi 升级后必须重跑它**；它红了说明余量没了，要改的是落点，不是把断言改松。
 *
 * ## 判定纪律：精确优先，大小写不敏感唯一回退
 *
 * 与上游 `pi-ai` 自己的做法同构——`dist/providers/anthropic.js` 的 `fromClaudeCodeName` 就是
 * 「大小写不敏感匹配回落真实工具名」，只是上游仅在 OAuth 路径启用（那条路径上 pi 把工具名伪装成
 * Claude Code 名发出去，回来自然要转回来）。本 App 恒走 API key 路径，享受不到，这里补齐。
 *
 * 比上游多一条唯一性检查：**第 3 档**只有在大小写不敏感候选唯一时才改名。真正未注册的工具
 * （模型幻觉出的 `WebSearch` 之类）与第 3 档的大小写歧义一律原样放行，让它照常报 not found
 * ——误伤面不扩大，模型也能从错误里得到真实反馈。
 *
 * 歧义只对第 3 档成立：别名表里的名字有权威映射可依，按表走不算猜（`READ` 在 `read`/`Read` 并存时
 * 仍归一到 `read`）。现实中也构造不出这种并存——本仓注册名要么是 pi 的小写内置名，要么是
 * `AskUserQuestion` / `Task` / `TaskCreate` / `TaskUpdate` / `mcp__narracat_memory__*`，无大小写碰撞对。
 */
import { createSyntheticSourceInfo } from '@mariozechner/pi-coding-agent'
import type { Extension } from '@mariozechner/pi-coding-agent'
import { SDK_TO_PI_TOOL_NAME } from './pi-tool-guard.ts'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** SDK 名 → pi 真名的大小写不敏感查找表（`glob` / `Glob` / `GLOB` 都要能查到 `find`）。 */
const LOWER_SDK_TO_PI_TOOL_NAME = new Map(
  Object.entries(SDK_TO_PI_TOOL_NAME).map(([sdkName, piName]) => [sdkName.toLowerCase(), piName]),
)

/**
 * 归一单个工具名，三档依次判定；返回 undefined 表示不改。
 *
 * 1. **精确命中本会话工具面** → 不改。
 * 2. **别名表**（`pi-tool-guard.ts` 的 `SDK_TO_PI_TOOL_NAME`，与白名单翻译共用同一份，不留第二张
 *    表漂移）→ 命中即用 pi 真名。这一档专治 `Glob → find` 这类**改名而非变大小写**的映射：
 *    第 3 档的大小写规则结构上永远够不着它，而 `Glob` 在引擎 prompt 里的出现频度仅次于 `Read`
 *    （13 份 allowed-tools 声明，另有多处正文直接写「用 Glob 扫描…」），漏掉它等于只修一半。
 * 3. **大小写不敏感唯一回退** → 唯一候选才改。
 *
 * 每一档的目标都必须已在本会话工具面内，否则不改——归一只做「换个名字指向同一个已注册工具」，
 * 绝不把调用引到本会话没有的工具上（那是工具白名单的事，不归归一管）。
 *
 * 导出供测试直接覆盖判定表，不必每次构造整条消息。
 */
export function resolveToolCallName(rawName: string, knownToolNames: readonly string[]): string | undefined {
  if (knownToolNames.includes(rawName)) return undefined

  const lowerName = rawName.toLowerCase()

  const aliased = LOWER_SDK_TO_PI_TOOL_NAME.get(lowerName)
  if (aliased !== undefined && aliased !== rawName && knownToolNames.includes(aliased)) return aliased

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

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages'

import type { AppConfig, ProviderId } from '../config.ts'
import { findUnsafeApiKeyCharacter, isModelServiceVerified, UNSAFE_API_KEY_MESSAGE } from '../config.ts'
import { resolvePrimaryModel } from '@shared/lib/model-slots'
import { redactErrorMessage } from '../redact.ts'
import { readAppearedCharacterContacts } from '../novel/appeared-characters.ts'
import type { OpenMemoryDb } from '../novel/memory-db.ts'
import { buildCharacterChatSystemPrompt, buildCharacterChatUserPrompt } from './character-chat-prompt.ts'
import { buildCharacterSituationPack } from './character-chat-situation.ts'
import { CHAT_GAP_LABEL_THRESHOLD_MS, formatChatGap } from './relative-time.ts'
import { consumeCharacterChatStream, createBubbleSplitter, stripStageDirections } from './character-chat-stream.ts'
import {
  createNovelMemoryReadonlyMcpClient,
  NOVEL_MEMORY_READONLY_TOOL_NAMES,
  type NovelMemoryMcpClientFactory,
} from '../engine/novel-memory-mcp-client.ts'
import type {
  CharacterChatMessage,
  CharacterChatProfiles,
  CharacterChatSendRequest,
  CharacterChatStreamEvent,
  CharacterChatTranscript,
  CharacterChatUserMode,
} from '@shared/types/character-chat'

/**
 * Character chat runner（ADR-0010 App-native runtime）。
 *
 * 重构（feat/character-chat-mvp）：从 claude-agent-sdk 的 query()（agent 任务运行时）
 * 改为 raw `@anthropic-ai/sdk` Messages API（canonical Messages API）+ 多轮 messages[] +
 * 手写 tool-use loop 调 NovelMemory 只读 MCP 工具。
 *
 * 为什么：
 * - 角色聊天本质是 chat，应落 canonical Messages API（messages[] 交替轮 + 独立 system），
 *   不是 agent 任务运行时。
 * - 角色按需查已写章节的记忆，且记忆系统未来会重构（issue #242）——记忆访问必须走引擎的
 *   MCP 工具契约（引擎是 SSOT），绝不在 App 里直读 memory.db 复刻折叠/检索逻辑。
 *
 * 不是 Agent run：不复用 Agent run reducer、不创建 Result/Push notification、不入 NovelMemory、
 * 不刷新 Workbench 产物。只读 NovelMemory（角色状态/关系/章节记忆 UID 查询），以角色系统 prompt
 * 流式回复。renderer 只发 project / character_uid / message + runId；历史由 App（transcript）单源。
 */

/** NovelMemory 只读工具白名单（与 MCP 客户端常量同源；导出供测试/接线断言只读隔离）。 */
export const CHARACTER_CHAT_READONLY_NOVEL_MEMORY_TOOLS = [...NOVEL_MEMORY_READONLY_TOOL_NAMES]

/** 工具往返上限（手写 agentic loop 的工具调用往返次数）。沿用历史常量名与值。 */
const CHARACTER_CHAT_MAX_TURNS = 4

/** 多轮历史窗口：组装 messages[] 时取最近 N 轮（含 user+assistant）。提成常量便于调。 */
const CHARACTER_CHAT_HISTORY_TURNS = 12

/** 单段流式回复 max_tokens（角色闲聊回复短，足够且省钱）。 */
const CHARACTER_CHAT_MAX_OUTPUT_TOKENS = 4096

/**
 * **必须显式关掉扩展思考。**
 *
 * 根因见 ADR-0041：deepseek 等渠道经 anthropic 端点默认开着 thinking，而 **thinking token 与
 * 回复共用同一个 `max_tokens` 预算**。润色那边实测过一次 `thinking_delta × 15994` /
 * `text_delta × 0`——预算被思考烧光、一个字都没产出，而且是随机的（同一请求有时只想几下就
 * 动笔），表现为「时灵时不灵」。
 *
 * 角色聊天的预算只有 4096，比润色小得多，被烧光的概率只会更高，症状是偶尔回一句空的。
 * 扮演角色说话不是推理任务，思考对它零收益。
 */
const CHARACTER_CHAT_THINKING = { type: 'disabled' } as const

export interface CharacterChatRunManagerDeps {
  readConfig: () => Promise<AppConfig>
  getApiKey: (provider: ProviderId) => Promise<string | null>
  sendEvent: (event: CharacterChatStreamEvent) => void
  appRoot: string
  resourcesPath?: string
  /** userData 根目录（B2 刀1）：推导用户能力包目录注入 NovelMemory MCP spawn env，由 ipc.ts 注入。 */
  userDataPath?: string
  /** 只读打开 memory.db 的工厂（由 ipc.ts 注入真实实现；测试注入假后端）。 */
  openMemoryDb: OpenMemoryDb
  /**
   * 读取某会话已存 transcript（多轮历史单源）。由 ipc.ts 注入真实现
   * （character-chat-transcripts.ts 的 readCharacterChatTranscript）；
   * 不注入时默认返回空历史（单轮兜底）。
   */
  readTranscript?: (identity: {
    projectPath: string
    characterUid: string
    userMode: CharacterChatUserMode
  }) => Promise<CharacterChatTranscript>
  /** NovelMemory 只读 MCP 客户端工厂（懒启动；测试注入假 client）。 */
  createMcpClient?: NovelMemoryMcpClientFactory
  /** Anthropic 客户端工厂（测试注入假 SDK）。 */
  createAnthropicClient?: (args: { apiKey: string; baseURL?: string }) => AnthropicLike
  createRunId?: () => string
  /** 读用户画像（"懂你"层）；由 ipc.ts 注入；不注入时默认空画像。 */
  readProfiles?: (identity: { projectPath: string; characterUid: string }) => Promise<CharacterChatProfiles>
  /** 一轮对话成功结算后回调（触发后台画像提炼）；不阻塞、由 ipc.ts 注入。 */
  onConversationSettled?: (input: { projectPath: string; characterUid: string; characterName: string }) => void
  /**
   * 组装片4「当前处境包」（确定性预注入的结构化记忆）；不注入时默认绑真实实现
   * （buildCharacterSituationPack + runner 已持有的 openMemoryDb）。测试注入假实现。
   */
  buildSituationPack?: (input: {
    projectPath: string
    characterUid: string
    characterName: string
    knowledgeBoundaryChapter: number | null
  }) => Promise<string>
}

export interface CharacterChatRunManager {
  send: (request: CharacterChatSendRequest) => Promise<{ runId: string }>
  cancel: (runId: string) => { cancelled: boolean }
}

/** 测试注入面：只依赖 messages.stream 的子集（避免绑死 SDK 全量类型）。 */
export interface AnthropicMessageStreamLike extends AsyncIterable<unknown> {
  finalMessage: () => Promise<{
    stop_reason?: string | null
    content: unknown[]
  }>
}

export interface AnthropicLike {
  messages: {
    stream: (
      body: {
        model: string
        system: string
        messages: MessageParam[]
        tools?: Tool[]
        max_tokens: number
        thinking: { type: 'disabled' }
      },
      options?: { signal?: AbortSignal },
    ) => AnthropicMessageStreamLike
  }
}

const CHARACTER_CHAT_USER_MODES = new Set(['author', 'reader'])

/** 校验 renderer 传入的发送请求；非法即抛错（IPC handler 边界用）。 */
export function normalizeCharacterChatSendRequest(input: unknown): CharacterChatSendRequest {
  if (!input || typeof input !== 'object') throw new Error('角色聊天参数非法。')
  const { runId, projectPath, characterUid, userMode, message } = input as Record<string, unknown>

  if (typeof runId !== 'string' || !runId.trim()) throw new Error('角色聊天缺少 runId。')
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('角色聊天缺少项目路径。')
  if (typeof characterUid !== 'string' || !characterUid.trim()) throw new Error('角色聊天缺少 character_uid。')
  if (typeof message !== 'string' || !message.trim()) throw new Error('角色聊天消息为空。')
  const mode = typeof userMode === 'string' && CHARACTER_CHAT_USER_MODES.has(userMode) ? userMode : 'author'

  return {
    runId: runId.trim(),
    projectPath,
    characterUid: characterUid.trim(),
    userMode: mode as CharacterChatSendRequest['userMode'],
    message,
  }
}

interface ActiveCharacterChatRun {
  abortController: AbortController
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 定位角色档案、解析知识边界。复用 Appeared character reader 的契约结果，
 * 保证 runner 与联系人列表用同一份 UID/settingPath/边界（不另起一套判定）。
 */
async function resolveCharacterContext(input: {
  projectPath: string
  characterUid: string
  openMemoryDb: OpenMemoryDb
}): Promise<{ name: string; settingContent: string; knowledgeBoundaryChapter: number | null }> {
  const { projectPath, characterUid, openMemoryDb } = input
  const list = await readAppearedCharacterContacts({ projectPath, openMemoryDb })
  const contact = list.contacts.find((item) => item.characterUid === characterUid)
  if (!contact) {
    throw new Error('该角色尚未出场或不存在，无法发起聊天。')
  }

  let settingContent = ''
  try {
    settingContent = await readFile(join(projectPath, contact.settingPath), 'utf-8')
  } catch {
    // 档案读失败不阻断：按空设定本色发挥（prompt 内已处理空设定）。
    settingContent = ''
  }

  return {
    name: contact.name,
    settingContent,
    knowledgeBoundaryChapter: list.knowledgeBoundaryChapter,
  }
}

/**
 * 把 transcript 的最近 N 轮 + 本条新 user 消息组装成 canonical messages[]（user/assistant 交替）。
 *
 * - 只取终态成功消息（complete）；流式/失败气泡不入多轮上下文。
 * - role 映射：user → 'user'，character → 'assistant'。
 * - 取最近 CHARACTER_CHAT_HISTORY_TURNS 条历史，再 append 本条新 user 消息。
 * - 折叠相邻同角色（极端历史）避免 Messages API 拒绝；保证以 user 起、与新 user 不连缀。
 */
export function buildCharacterChatMessages(
  history: CharacterChatMessage[],
  newUserMessage: string,
): MessageParam[] {
  const usable = history.filter((message) => message.status === 'complete' && message.text.trim().length > 0)
  const recent = usable.slice(-CHARACTER_CHAT_HISTORY_TURNS)

  const messages: MessageParam[] = []
  let previousCreatedAtMs: number | null = null
  for (const message of recent) {
    const createdAtMs = Date.parse(message.createdAt)
    // 与上一条历史的间隔超过阈值 → 在本条前缀一行轻标注（连续对话不标）。
    let text = message.text
    if (
      previousCreatedAtMs !== null &&
      Number.isFinite(createdAtMs) &&
      createdAtMs - previousCreatedAtMs > CHAT_GAP_LABEL_THRESHOLD_MS
    ) {
      text = `（隔了 ${formatChatGap(createdAtMs - previousCreatedAtMs)}，没联系了）\n${message.text}`
    }
    if (Number.isFinite(createdAtMs)) previousCreatedAtMs = createdAtMs

    const role = message.role === 'user' ? 'user' : 'assistant'
    const previous = messages[messages.length - 1]
    if (previous && previous.role === role) {
      // 相邻同角色：合并为一轮（防御历史里连续同角色导致 API 报错）。
      previous.content = `${previous.content as string}\n\n${text}`
      continue
    }
    messages.push({ role, content: text })
  }

  // 第一条必须是 user；若历史首条是 assistant（理论上不该发生），裁掉前导 assistant。
  while (messages.length > 0 && messages[0].role === 'assistant') {
    messages.shift()
  }

  const newUser = buildCharacterChatUserPrompt(newUserMessage)
  const last = messages[messages.length - 1]
  if (last && last.role === 'user') {
    last.content = `${last.content as string}\n\n${newUser}`
  } else {
    messages.push({ role: 'user', content: newUser })
  }

  return messages
}

/** 从 finalMessage 的 content 抽出 tool_use 块（手写工具循环用）。 */
function extractToolUseBlocks(content: unknown[]): ToolUseBlock[] {
  const blocks: ToolUseBlock[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      blocks.push(block as unknown as ToolUseBlock)
    }
  }
  return blocks
}

function defaultCreateAnthropicClient(args: { apiKey: string; baseURL?: string }): AnthropicLike {
  return new Anthropic({ apiKey: args.apiKey, baseURL: args.baseURL || undefined }) as unknown as AnthropicLike
}

export function createCharacterChatRunManager(deps: CharacterChatRunManagerDeps): CharacterChatRunManager {
  const createRunId = deps.createRunId ?? randomUUID
  const openMemoryDb = deps.openMemoryDb
  const readTranscript =
    deps.readTranscript ??
    (async (identity): Promise<CharacterChatTranscript> => ({
      projectPath: identity.projectPath,
      characterUid: identity.characterUid,
      userMode: identity.userMode,
      messages: [],
      updatedAt: new Date().toISOString(),
    }))
  const createMcpClient = deps.createMcpClient ?? createNovelMemoryReadonlyMcpClient
  const createAnthropicClient = deps.createAnthropicClient ?? defaultCreateAnthropicClient
  const readProfiles =
    deps.readProfiles ?? (async (): Promise<CharacterChatProfiles> => ({ authorProfile: '', impression: '' }))
  const activeRuns = new Map<string, ActiveCharacterChatRun>()

  /**
   * 工具 schema 缓存（按 projectPath）。NovelMemory 只读工具集对一个项目是稳定的，
   * 所以只在某项目首次发送时 spawn 一次 MCP server 拉 schema 并缓存；此后的闲聊轮
   * 直接复用缓存的 schema，**不再 spawn**——只有模型真的请求工具（callTool）时才 spawn。
   * 这样兑现「大多数闲聊轮零 spawn」（首发预热后）。
   */
  const toolSchemaCache = new Map<string, Tool[]>()

  function sendEventSafe(event: CharacterChatStreamEvent): void {
    try {
      deps.sendEvent(event)
    } catch {
      // 渲染端已销毁等场景：吞掉，不影响 runner 生命周期。
    }
  }

  function isActive(runId: string, abortController: AbortController): boolean {
    return activeRuns.get(runId)?.abortController === abortController
  }

  async function run(request: CharacterChatSendRequest, runId: string, abortController: AbortController): Promise<void> {
    // 记忆客户端懒启动：worker 由 memory host 惰性 fork（拆旧刀3 起走 utilityProcess 通道）；
    // run 收尾统一 close()（host 通道下为幂等 no-op）。schema 已缓存的轮次根本不构造 client。
    let mcpClient: ReturnType<NovelMemoryMcpClientFactory> | null = null

    function ensureMcpClient(): ReturnType<NovelMemoryMcpClientFactory> {
      if (!mcpClient) {
        mcpClient = createMcpClient({
          projectPath: request.projectPath,
          appRoot: deps.appRoot,
          resourcesPath: deps.resourcesPath,
          userDataPath: deps.userDataPath,
        })
      }
      return mcpClient
    }

    async function closeMcpClient(): Promise<void> {
      if (!mcpClient) return
      const client = mcpClient
      mcpClient = null
      try {
        await client.close()
      } catch {
        // 关闭失败忽略：不影响已完成的回复。
      }
    }

    /**
     * 拿到该项目的只读工具 schema：命中缓存直接返回（不 spawn）；未命中则 spawn 一次 MCP server
     * 拉 schema 并缓存。空数组也缓存，避免每轮重试拉取。
     */
    async function resolveToolSchemas(): Promise<Tool[]> {
      const cached = toolSchemaCache.get(request.projectPath)
      if (cached) return cached
      const tools = await ensureMcpClient().listReadonlyTools()
      toolSchemaCache.set(request.projectPath, tools)
      return tools
    }

    try {
      const config = await deps.readConfig()
      if (!isActive(runId, abortController)) return

      if (!isModelServiceVerified(config)) {
        activeRuns.delete(runId)
        sendEventSafe({ type: 'failed', runId, message: '模型服务尚未验证。请先在设置中完成「测试连接」。' })
        return
      }

      // 验证门已过：isModelServiceVerified 语义即「主力槽已解析且已验证」，此处主力必非空。
      const primary = resolvePrimaryModel(config)!
      const apiKey = await deps.getApiKey(primary.provider)
      if (!isActive(runId, abortController)) return
      if (!apiKey) {
        activeRuns.delete(runId)
        sendEventSafe({ type: 'failed', runId, message: `未配置 ${primary.provider} API Key。请先在设置中保存密钥。` })
        return
      }
      // 含非 ASCII 字符的 Key 进请求头必崩，提前拦下给出可操作提示。
      if (findUnsafeApiKeyCharacter(apiKey)) {
        activeRuns.delete(runId)
        sendEventSafe({ type: 'failed', runId, message: UNSAFE_API_KEY_MESSAGE })
        return
      }

      const context = await resolveCharacterContext({
        projectPath: request.projectPath,
        characterUid: request.characterUid,
        openMemoryDb,
      })
      if (!isActive(runId, abortController)) return

      const transcript = await readTranscript({
        projectPath: request.projectPath,
        characterUid: request.characterUid,
        userMode: request.userMode,
      })
      if (!isActive(runId, abortController)) return

      const model = primary.modelId
      const lastHistoryMessage = transcript.messages.filter((m) => m.status === 'complete').at(-1)

      const profiles = await readProfiles({ projectPath: request.projectPath, characterUid: request.characterUid }).catch(
        () => ({ authorProfile: '', impression: '' }),
      )
      if (!isActive(runId, abortController)) return

      // 可选依赖须先解出局部常量再调用（外审 P1-4：直接内联三元表达式过不了 typecheck）；
      // 默认绑定真实实现 + runner 已持有的 openMemoryDb（与 resolveCharacterContext 同一来源）。
      const buildSituationPack =
        deps.buildSituationPack ??
        ((packInput: {
          projectPath: string
          characterUid: string
          characterName: string
          knowledgeBoundaryChapter: number | null
        }) => buildCharacterSituationPack({ ...packInput, openMemoryDb }))

      const situationPack = await buildSituationPack({
        projectPath: request.projectPath,
        characterUid: request.characterUid,
        characterName: context.name,
        knowledgeBoundaryChapter: context.knowledgeBoundaryChapter,
      }).catch((error) => {
        console.warn('[character-chat] 处境包组装失败，降级为无处境包继续：', error)
        return ''
      })
      if (!isActive(runId, abortController)) return

      const systemPrompt = buildCharacterChatSystemPrompt({
        name: context.name,
        characterUid: request.characterUid,
        settingContent: context.settingContent,
        knowledgeBoundaryChapter: context.knowledgeBoundaryChapter,
        lastChatAt: lastHistoryMessage?.createdAt ?? null,
        authorProfile: profiles.authorProfile,
        impression: profiles.impression,
        situationPack,
      })

      const client = createAnthropicClient({ apiKey, baseURL: primary.baseUrl || undefined })
      const messages = buildCharacterChatMessages(transcript.messages, request.message)

      sendEventSafe({ type: 'started', runId })

      // 工具 schema：命中项目缓存零 spawn；首发预热时 spawn 一次拉取。模型据此自然决定是否调用。
      // 降级铁律：NovelMemory MCP 起不来 / 拉 schema 失败时，退化为「无工具纯聊天」——角色仍可凭
      // 设定档 + 知识边界扮演，绝不因记忆服务不可用而让整条回复失败。
      let tools: Tool[] = []
      try {
        tools = await resolveToolSchemas()
      } catch {
        tools = []
        toolSchemaCache.set(request.projectPath, []) // 缓存空集，避免每轮重试 spawn
      }
      if (!isActive(runId, abortController)) {
        await closeMcpClient()
        return
      }
      let fullText = ''
      const splitter = createBubbleSplitter()
      let bubbleIndex = 0

      function emitBubbles(segments: string[]): void {
        for (const segment of segments) {
          const cleaned = stripStageDirections(segment)
          if (!cleaned) continue
          if (isActive(runId, abortController)) {
            sendEventSafe({ type: 'bubble', runId, bubbleIndex, text: cleaned })
            bubbleIndex += 1
          }
        }
      }

      // 手写 agentic loop：每轮 stream 文本 delta → finalMessage → 若 tool_use 则补查并续轮。
      for (let turn = 0; turn < CHARACTER_CHAT_MAX_TURNS + 1; turn += 1) {
        if (!isActive(runId, abortController)) {
          await closeMcpClient()
          return
        }

        const stream = client.messages.stream(
          {
            model,
            system: systemPrompt,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            max_tokens: CHARACTER_CHAT_MAX_OUTPUT_TOKENS,
            thinking: CHARACTER_CHAT_THINKING,
          },
          { signal: abortController.signal },
        )

        const segment = await consumeCharacterChatStream(stream, (text) => {
          emitBubbles(splitter.push(text))
        })
        fullText += segment.text

        const finalMessage = await stream.finalMessage()
        if (!isActive(runId, abortController)) {
          await closeMcpClient()
          return
        }

        if (finalMessage.stop_reason !== 'tool_use') {
          break
        }

        const toolUses = extractToolUseBlocks(finalMessage.content)
        if (toolUses.length === 0) {
          // 防御：stop_reason 标 tool_use 却无 tool_use 块——按结束处理，避免死循环。
          break
        }

        // 工具循环到上限仍要工具：停止再请求工具，append 当前 assistant 轮后结束。
        if (turn >= CHARACTER_CHAT_MAX_TURNS) {
          messages.push({ role: 'assistant', content: finalMessage.content as MessageParam['content'] })
          break
        }

        // append assistant 轮（含 tool_use 块），再 append 各 tool_result 轮，续循环。
        messages.push({ role: 'assistant', content: finalMessage.content as MessageParam['content'] })

        const toolResults = []
        for (const toolUse of toolUses) {
          let resultText: string
          let isError = false
          try {
            const input = isRecord(toolUse.input) ? (toolUse.input as Record<string, unknown>) : {}
            resultText = await ensureMcpClient().callTool(toolUse.name, input)
          } catch (error) {
            resultText = errorMessage(error)
            isError = true
          }
          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            content: resultText,
            ...(isError ? { is_error: true } : {}),
          })
        }
        messages.push({ role: 'user', content: toolResults as MessageParam['content'] })
      }

      await closeMcpClient()

      if (!isActive(runId, abortController)) return
      emitBubbles(splitter.flush())
      activeRuns.delete(runId)
      sendEventSafe({ type: 'completed', runId, text: fullText })
      // 后台增量提炼用户画像（不 await、失败不影响聊天）。
      try {
        deps.onConversationSettled?.({
          projectPath: request.projectPath,
          characterUid: request.characterUid,
          characterName: context.name,
        })
      } catch {
        // 忽略
      }
    } catch (error) {
      await closeMcpClient()
      if (isActive(runId, abortController)) {
        activeRuns.delete(runId)
        // 失败气泡会显示在 UI：脱敏掉 provider/SDK 错误里可能带出的 sk-*/Bearer 认证材料（#288 Codex P2）。
        sendEventSafe({ type: 'failed', runId, message: redactErrorMessage(error) })
      }
    }
  }

  return {
    async send(request) {
      const runId = request.runId.trim() || createRunId()
      const abortController = new AbortController()
      activeRuns.set(runId, { abortController })
      void run(request, runId, abortController)
      return { runId }
    },

    cancel(runId) {
      const active = activeRuns.get(runId)
      if (!active) return { cancelled: false }
      activeRuns.delete(runId)
      active.abortController.abort()
      return { cancelled: true }
    },
  }
}

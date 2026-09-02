/**
 * 润色运行编排（ADR-0041 §3）：**不经 Agent**，直连 Messages API。
 *
 * 与角色聊天同一条直连链路（keytar 取密钥 → Anthropic Messages API），但没有工具、没有多轮、
 * 没有 MCP——一次请求把整章正文换一版文字，仅此而已。它不进 pi runtime、不占 Agent 会话、
 * 不写记忆库。
 *
 * 试验模式与常驻模式共用同一个 `runPolishAttempt`：前者并行跑多槽并把增量喂给界面，后者跑
 * 单槽、无观众、不流式（`polishChapterOnce`）。
 */
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { extractTextDelta } from '../chat/character-chat-stream.ts'
import { detectPolishDrift } from '@shared/lib/prose-polish-drift'
import { resolveModelByKey, resolvePrimaryModel, type ResolvedModel } from '@shared/lib/model-slots'
import type { AppConfig, ProviderId } from '@shared/types/config'
import {
  isPolishSlotId,
  type PolishDrift,
  type PolishRecipe,
  type PolishRecipeFile,
  type PolishRunEvent,
  type PolishRunRequest,
  type PolishSlotId,
  type PolishUsage,
  type PolishVersionState,
} from '@shared/types/prose-polish'
import { buildPolishSystemPrompt, sanitizePolishOutput, selectAnchorNames, selectAnchorNumbers } from './polish-prompt.ts'

/**
 * 整章重述的输出上限：5000 中文字的章节约 8k token，留一倍余量。
 * ⚠️ 实测 4096 会让整章润色在 `stop_reason=max_tokens` 处截断，不要往下调。
 */
const POLISH_MAX_OUTPUT_TOKENS = 16000

/**
 * **必须显式关掉扩展思考。**
 *
 * 真机根因（2026-09-02，deepseek-v4-flash 经 anthropic 端点）：该渠道默认开着 thinking，而
 * **thinking token 与正文共用同一个 max_tokens 预算**。实测一次整章润色收到
 * `thinking_delta × 15994`、`text_delta × 0`——16000 的预算被思考烧光，`content_block` 只开了
 * 思考那一个，一个正文字都没产出，跑了 128 秒后报「模型没有产出正文」。而且**这是随机的**：
 * 另一次同样的请求只想了 10 下就动笔，所以偶尔能成，看起来像「时灵时不灵」。
 *
 * 关掉之后连跑三次：0 个 thinking delta、约 2350 个文本 delta、首字 1.4 秒、总耗时约 14 秒。
 *
 * 润色是改写不是推理，思考对它零收益却要吃掉整章的预算——没有保留它的理由。
 */
const POLISH_THINKING_DISABLED = { type: 'disabled' } as const

/**
 * 作者开了推理模式时的思考预算，以及随之抬高的总上限。
 *
 * 关键：`budget_tokens` 是**从 `max_tokens` 里切出去的**，不额外给。所以开推理时必须把
 * `max_tokens` 抬到 `正文预算 + 思考预算`，否则正文能用的额度会被思考吃掉一大块——那正是
 * 默认开着思考时整章零产出的机理。
 */
const POLISH_THINKING_BUDGET_TOKENS = 8000

/**
 * 单版硬超时。正常一版约 15 秒（关掉 thinking 后实测），6 分钟是纯粹的安全网：
 * 没有它，「模型在那边空转」与「真的挂了」在观感上完全一致，永远分不开。
 */
const POLISH_TIMEOUT_MS = 6 * 60 * 1000

export interface PolishMessageStreamLike extends AsyncIterable<unknown> {
  finalMessage: () => Promise<{
    stop_reason?: string | null
    usage?: { input_tokens?: number; output_tokens?: number } | null
  }>
}

/** 测试注入面：只依赖 messages.stream 的子集，不绑死 SDK 全量类型。 */
export interface PolishAnthropicLike {
  messages: {
    stream: (
      body: {
        model: string
        system: string
        messages: { role: 'user'; content: string }[]
        max_tokens: number
        thinking: { type: 'disabled' } | { type: 'enabled'; budget_tokens: number }
      },
      options?: { signal?: AbortSignal },
    ) => PolishMessageStreamLike
  }
}

export type PolishRunEventSink = (event: PolishRunEvent) => void

export interface PolishRunManagerDeps {
  readConfig: () => Promise<AppConfig>
  getApiKey: (provider: ProviderId) => Promise<string | null>
  sendEvent: (event: PolishRunEvent) => void
  readRecipes: () => Promise<PolishRecipeFile>
  recordRunSlots: (slotIds: PolishSlotId[]) => Promise<unknown>
  /** 读该章可见正文（不含章末元数据注释）；null = 章节文件不存在。 */
  readOriginalText: (projectPath: string, chapter: number) => Promise<string | null>
  /** 全项目已知专名（角色名 + 别名 + 短伏笔关键词） */
  collectAnchorNames: (projectPath: string) => Promise<string[]>
  createAnthropicClient?: (args: { apiKey: string; baseURL?: string }) => PolishAnthropicLike
  createRunId?: () => string
  /** 单版硬超时，默认 POLISH_TIMEOUT_MS；测试注入小值以真断言超时分支。 */
  timeoutMs?: number
}

export interface PolishRunManager {
  start: (request: PolishRunRequest) => Promise<{ runId: string; versions: PolishVersionState[] }>
  cancelVersion: (runId: string, slotId: PolishSlotId) => { cancelled: boolean }
  cancelRun: (runId: string) => { cancelled: boolean }
  /** 常驻模式：跑单槽、不流式、不发事件，结果直接返回给调用方判定。 */
  polishChapterOnce: (input: {
    projectPath: string
    chapter: number
    slotId: PolishSlotId
  }) => Promise<{ text: string; drift: PolishDrift; usage: PolishUsage; originalText: string }>
}

function defaultCreateAnthropicClient(args: { apiKey: string; baseURL?: string }): PolishAnthropicLike {
  return new Anthropic({ apiKey: args.apiKey, baseURL: args.baseURL || undefined }) as unknown as PolishAnthropicLike
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError')) return true
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
}

/** 校验渲染端传来的发起请求；非法即抛（IPC 边界用）。 */
export function normalizePolishRunRequest(input: unknown): PolishRunRequest {
  if (!input || typeof input !== 'object') throw new Error('润色参数非法。')
  const { projectPath, chapter, slotIds } = input as Record<string, unknown>
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('缺少项目路径。')
  if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 1) throw new Error('章号参数非法。')
  if (!Array.isArray(slotIds)) throw new Error('缺少要跑的润色方案。')
  const normalized = [...new Set(slotIds.filter(isPolishSlotId))]
  if (normalized.length === 0) throw new Error('至少要选一套润色方案。')
  return { projectPath, chapter, slotIds: normalized }
}

/**
 * 解析这一槽用哪个模型：槽位指定的池条目 → 找不到就回落主力槽。
 *
 * v1 只支持 anthropic wire（与角色聊天现状一致）。openai wire 在界面上已灰显并注明原因，
 * 这里是服务端兜底——静默换渠道跑出来的结果作者无从判断，必须明说。
 */
export function resolvePolishModel(config: AppConfig, recipe: PolishRecipe): ResolvedModel {
  // 槽位没指定、或指定的条目已被移出模型池 → 回落主力槽（不为一次配置漂移让润色跑不起来）。
  const resolved = resolveModelByKey(config, recipe.modelKey) ?? resolvePrimaryModel(config)

  if (!resolved) throw new Error('还没有可用的模型，请先在设置里配置模型服务。')
  if (resolved.wire !== 'anthropic') {
    throw new Error('这一槽选的渠道用的是 OpenAI 兼容协议，润色目前只支持 Anthropic 协议的渠道。')
  }
  // 「已填写但未验证的配置不能等同于可用连接」（CONTEXT.md 模型服务验证）。快捷切换器靠
  // canSetPrimaryModel 守着这条线，而槽位是从整个池子里挑的，绕过了那道门——这里补上服务端兜底，
  // 界面上同款条目也会置灰。不兜的话作者会拿一个从没连通过的渠道跑三版然后收到一串看不懂的报错。
  if (!resolved.verified) {
    throw new Error('这个模型还没通过连接测试，先去设置里测一下再用它润色。')
  }
  return resolved
}

interface PolishAttemptInput {
  config: AppConfig
  recipe: PolishRecipe
  originalText: string
  anchorNames: string[]
  signal: AbortSignal
  onDelta?: (text: string) => void
}

interface PolishAttemptResult {
  text: string
  usage: PolishUsage
}

async function runPolishAttempt(
  deps: PolishRunManagerDeps,
  input: PolishAttemptInput,
): Promise<PolishAttemptResult> {
  const model = resolvePolishModel(input.config, input.recipe)
  const apiKey = await deps.getApiKey(model.provider)
  if (!apiKey) throw new Error(`未配置 ${model.provider} API Key。请先在设置中保存密钥。`)

  const systemPrompt = buildPolishSystemPrompt({
    authorPrompt: input.recipe.prompt,
    anchorNames: selectAnchorNames(input.originalText, input.anchorNames),
    anchorNumbers: selectAnchorNumbers(input.originalText),
  })

  const createClient = deps.createAnthropicClient ?? defaultCreateAnthropicClient
  const client = createClient({ apiKey, baseURL: model.baseUrl || undefined })

  const thinking = input.recipe.thinking
    ? ({ type: 'enabled', budget_tokens: POLISH_THINKING_BUDGET_TOKENS } as const)
    : POLISH_THINKING_DISABLED
  const stream = client.messages.stream(
    {
      model: model.modelId,
      system: systemPrompt,
      messages: [{ role: 'user', content: input.originalText }],
      // 思考预算从 max_tokens 里切，故开推理时把总额抬高，保证正文额度不变。
      max_tokens:
        POLISH_MAX_OUTPUT_TOKENS + (input.recipe.thinking ? POLISH_THINKING_BUDGET_TOKENS : 0),
      thinking,
    },
    { signal: input.signal },
  )

  let accumulated = ''
  for await (const event of stream) {
    const delta = extractTextDelta(event)
    if (delta === null) continue
    accumulated += delta
    input.onDelta?.(delta)
  }

  const final = await stream.finalMessage()
  const text = sanitizePolishOutput(accumulated)

  // 截断的正文绝不能拿去采用：作者读到的是完整的一章，采用后结尾会被悄悄吃掉。
  if (final.stop_reason === 'max_tokens') {
    // 开着推理模式撞上限，几乎总是「额度全烧在思考上」而不是「章太长」——实测过给足 8000
    // 思考预算仍能把 24000 全部烧光、正文零产出。两种情况的处置完全不同，不能混成一句话。
    throw new Error(
      input.recipe.thinking
        ? '推理模式把额度用在思考上了，没写出正文。关掉这一槽的推理模式再试。'
        : '这一章太长，模型没写完就到了上限。可以换个模型再试。',
    )
  }
  if (!text) throw new Error('模型没有产出正文，请稍后重试。')

  return {
    text,
    usage: {
      inputTokens: final.usage?.input_tokens ?? 0,
      outputTokens: final.usage?.output_tokens ?? 0,
    },
  }
}

interface PreparedRun {
  originalText: string
  anchorNames: string[]
  config: AppConfig
  recipes: Map<PolishSlotId, PolishRecipe>
}

async function prepareRun(
  deps: PolishRunManagerDeps,
  projectPath: string,
  chapter: number,
  slotIds: PolishSlotId[],
): Promise<PreparedRun> {
  const originalText = await deps.readOriginalText(projectPath, chapter)
  if (!originalText || !originalText.trim()) throw new Error('这一章还没有正文，无法润色。')

  const file = await deps.readRecipes()
  const recipes = new Map<PolishSlotId, PolishRecipe>()
  for (const recipe of file.recipes) {
    if (slotIds.includes(recipe.slotId) && recipe.prompt.trim()) recipes.set(recipe.slotId, recipe)
  }
  if (recipes.size === 0) throw new Error('选中的润色方案还没有写内容，先写一条要求再跑。')

  const config = await deps.readConfig()
  // 专名清单失败不阻断：拿不到锚顶多是护栏更容易误报，不该让整次润色跑不起来。
  const anchorNames = await deps.collectAnchorNames(projectPath).catch(() => [])

  return { originalText, anchorNames, config, recipes }
}

export function createPolishRunManager(deps: PolishRunManagerDeps): PolishRunManager {
  const createRunId = deps.createRunId ?? (() => randomUUID())
  const activeRuns = new Map<string, Map<PolishSlotId, AbortController>>()

  async function start(request: PolishRunRequest): Promise<{ runId: string; versions: PolishVersionState[] }> {
    const prepared = await prepareRun(deps, request.projectPath, request.chapter, request.slotIds)
    const slotIds = request.slotIds.filter((slotId) => prepared.recipes.has(slotId))
    const runId = createRunId()

    const controllers = new Map<PolishSlotId, AbortController>()
    for (const slotId of slotIds) controllers.set(slotId, new AbortController())
    activeRuns.set(runId, controllers)

    // 记下这轮组合供下次默认勾选；失败不影响本次跑版。
    void deps.recordRunSlots(slotIds).catch(() => undefined)

    // 主进程留一行：这条链路正常也要等一分多钟，终端没有任何输出时人只能猜是不是卡死了。
    console.log(`[polish] 第 ${request.chapter} 章开跑 ${slotIds.length} 版：${slotIds.join(', ')}`)
    deps.sendEvent({ type: 'started', runId, chapter: request.chapter, slotIds })

    const tasks = slotIds.map(async (slotId) => {
      const controller = controllers.get(slotId)!
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, deps.timeoutMs ?? POLISH_TIMEOUT_MS)
      try {
        const result = await runPolishAttempt(deps, {
          config: prepared.config,
          recipe: prepared.recipes.get(slotId)!,
          originalText: prepared.originalText,
          anchorNames: prepared.anchorNames,
          signal: controller.signal,
          onDelta: (text) => deps.sendEvent({ type: 'delta', runId, slotId, text }),
        })
        const drift = detectPolishDrift({
          original: prepared.originalText,
          polished: result.text,
          anchorNames: prepared.anchorNames,
        })
        console.log(
          `[polish] ${slotId} 完成：${result.text.length} 字，用量 ${result.usage.inputTokens}/${result.usage.outputTokens}`,
        )
        deps.sendEvent({ type: 'version-done', runId, slotId, drift, usage: result.usage })
      } catch (error) {
        // 一版挂掉不牵连其余版本：另外两版已经花过钱了，凭什么一起丢（ADR-0041 §14 决策）。
        if (timedOut) {
          console.warn(`[polish] ${slotId} 超时未响应`)
          deps.sendEvent({
            type: 'version-failed',
            runId,
            slotId,
            message: '模型超过 6 分钟没有回应，已经停下。可以换个模型再试。',
          })
          return
        }
        if (controller.signal.aborted || isAbortError(error)) {
          deps.sendEvent({ type: 'version-aborted', runId, slotId })
          return
        }
        console.error(`[polish] ${slotId} 失败：`, error)
        deps.sendEvent({ type: 'version-failed', runId, slotId, message: errorMessage(error) })
      } finally {
        clearTimeout(timer)
      }
    })

    void Promise.all(tasks).finally(() => {
      activeRuns.delete(runId)
      deps.sendEvent({ type: 'finished', runId })
    })

    return {
      runId,
      versions: slotIds.map((slotId) => ({ slotId, status: 'pending', text: '' })),
    }
  }

  function cancelVersion(runId: string, slotId: PolishSlotId): { cancelled: boolean } {
    const controller = activeRuns.get(runId)?.get(slotId)
    if (!controller || controller.signal.aborted) return { cancelled: false }
    controller.abort()
    return { cancelled: true }
  }

  function cancelRun(runId: string): { cancelled: boolean } {
    const controllers = activeRuns.get(runId)
    if (!controllers) return { cancelled: false }
    let cancelled = false
    for (const controller of controllers.values()) {
      if (controller.signal.aborted) continue
      controller.abort()
      cancelled = true
    }
    return { cancelled }
  }

  async function polishChapterOnce(input: {
    projectPath: string
    chapter: number
    slotId: PolishSlotId
  }): Promise<{ text: string; drift: PolishDrift; usage: PolishUsage; originalText: string }> {
    const prepared = await prepareRun(deps, input.projectPath, input.chapter, [input.slotId])
    const recipe = prepared.recipes.get(input.slotId)
    if (!recipe) throw new Error('常驻的润色方案还没有写内容。')

    // 常驻模式同样要超时：它跑在后台没人盯着，挂住就是永远挂住，连一条「已跳过」都留不下。
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, deps.timeoutMs ?? POLISH_TIMEOUT_MS)

    let result: PolishAttemptResult
    try {
      result = await runPolishAttempt(deps, {
        config: prepared.config,
        recipe,
        originalText: prepared.originalText,
        anchorNames: prepared.anchorNames,
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) throw new Error('模型超过 6 分钟没有回应，已经停下。')
      throw error
    } finally {
      clearTimeout(timer)
    }

    return {
      text: result.text,
      drift: detectPolishDrift({
        original: prepared.originalText,
        polished: result.text,
        anchorNames: prepared.anchorNames,
      }),
      usage: result.usage,
      // 把「送去润色的那一份原稿」原样带出去：常驻的乐观锁必须拿它当基线，
      // 生成期间作者若手改了正文，才拦得住这一版把作者的改动覆盖掉。
      originalText: prepared.originalText,
    }
  }

  return { start, cancelVersion, cancelRun, polishChapterOnce }
}

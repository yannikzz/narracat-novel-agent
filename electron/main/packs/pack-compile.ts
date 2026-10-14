// electron/main/packs/pack-compile.ts
//
// 造包中心「意图理解编排」（B2 刀3）：把作者写的大白话意图翻译成结构化卡字段。
// 依赖注入模式照抄 electron/main/chat/character-chat-profiler.ts
// （工厂函数 + Deps 接口 + 直接 @anthropic-ai/sdk 非流式 messages.create，测试注假 client）。
//
// 三类卡编译路径：
// - persona/craft：走 LLM，输出 JSON 经「parse → 字段类型 → enum⊆词表」三级校验，非法重试 1 次后失败。
// - structure：零 LLM——stage 由渲染端本地选定并存进 DraftCard.intent，compile 直接本地映射。
// echo 一律由 App 从 compiled.fields 确定性渲染，不信任 LLM 自己回显的文字。

import Anthropic from '@anthropic-ai/sdk'
import { providerRequestHeaders } from '@shared/lib/provider-request-headers'
import { resolveLightModel } from '@shared/lib/model-slots'
import type { AppConfig, ProviderId } from '../config'
import type { CompiledCardMeta, DraftCard, PackDraftMeta } from '@shared/types/capability-pack'
import { STRUCTURE_STAGE_LABELS, STRUCTURE_STAGES, type StructureStage } from '@shared/types/capability-pack'
import { extractNonEvidenceText } from '@shared/lib/pack-card-sections'

/** 造包中心可用词表（Task 1 引擎词表镜像，经 Task 8 callAuthoringTool 获取，本模块经 DI 注入避免直接依赖 MCP）。 */
export interface AuthoringVocab {
  emotion_tags: string[]
  technique_tags: string[]
  structure_stages: string[]
}

export type CompileCardResult = { status: 'ok'; compiled: CompiledCardMeta } | { status: 'error'; message: string }

/** 编译用的非流式 create 接口（测试可注入假实现，形状与 character-chat-profiler.ts 的 AnthropicCreateLike 一致）。 */
export interface AnthropicCreateLike {
  messages: {
    create: (body: {
      model: string
      system: string
      messages: { role: 'user'; content: string }[]
      max_tokens: number
    }) => Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

/** 读单份草稿：签名对齐 pack-drafts.ts 的 getPackDraft（Task 5），生产接线直接传函数引用（Task 10）。 */
type ReadDraft = (input: { userDataPath: string; draftId: string }) => Promise<{ meta: PackDraftMeta; cards: DraftCard[]; readme: string } | null>
/** 写回草稿：签名对齐 pack-drafts.ts 的 updatePackDraft（Task 5）。 */
type WriteDraft = (input: { userDataPath: string; draftId: string; patch: { cards?: DraftCard[] } }) => Promise<void>

export interface PackCompilerDeps {
  readConfig: () => Promise<AppConfig>
  getApiKey: (provider: ProviderId) => Promise<string | null>
  createClient?: (args: { apiKey: string; baseURL?: string }) => AnthropicCreateLike
  getVocab: () => Promise<AuthoringVocab>
  readDraft: ReadDraft
  writeDraft: WriteDraft
  /** agent-core/narracat-agent-core.lock.json 的 version（生产接线在 Task 10）。 */
  readEngineVersion: () => string
}

const MAX_OUTPUT_TOKENS = 512
const MAX_ATTEMPTS = 2 // 首次 + 重试 1 次
/** 正文摘要截断长度：给 LLM 够用的语境即可，不把整篇正文塞进编译 prompt。 */
const BODY_DIGEST_MAX_CHARS = 400

/**
 * 编译输入（三路共享：手写 / 从书学 / 作家向导）：intent 为主，one_line 与正文摘要补语境。
 * 只读 intent 时 triggers 容易落成抽象概念词，而运行时选卡是对章纲文本的字面 includes 匹配
 * （craft-pack-loader.ts selectCraftPacks），抽象词在章纲里永不出现 = 卡永不出场（PR#478 外审 P1）。
 */
export interface CompileCardSource {
  intent: string
  oneLine: string
  /** 剥 [evidence] 摘录段后截前 400 字的正文摘要（摘录原文不进编译 prompt）。 */
  bodyDigest: string
}

/** 从草稿卡构造编译输入；导出供测试直断形状。 */
export function buildCompileCardSource(card: Pick<DraftCard, 'intent' | 'oneLine' | 'body'>): CompileCardSource {
  return {
    intent: card.intent,
    oneLine: card.oneLine,
    bodyDigest: extractNonEvidenceText(card.body).trim().slice(0, BODY_DIGEST_MAX_CHARS),
  }
}

function defaultCreateClient(args: { apiKey: string; baseURL?: string }): AnthropicCreateLike {
  return new Anthropic({ apiKey: args.apiKey, baseURL: args.baseURL || undefined, defaultHeaders: providerRequestHeaders(args.baseURL) }) as unknown as AnthropicCreateLike
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

/** 剥可能包裹输出的 ```json / ``` 代码围栏；无围栏原样返回（trim 后）。 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenceMatch ? fenceMatch[1].trim() : trimmed
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** values 中不属于 vocab 的元素（用于 enum⊆词表 校验的失败原因文案）。 */
function outOfVocab(values: string[], vocab: string[]): string[] {
  return values.filter((v) => !vocab.includes(v))
}

export interface PersonaFields {
  keywords: string[]
}
export interface CraftLlmFields {
  triggers: string[]
  emotion_tags: string[]
  exclusions: string[]
  technique_tags: string[]
}

type ValidatedOutput =
  | { ok: true; value: PersonaFields | CraftLlmFields }
  | { ok: false; reason: string }

/** JSON parse + 字段类型 + enum⊆词表 三级校验；任一步失败返回人话失败原因（供重试 prompt 与最终错误消息复用）。 */
function validateLlmOutput(type: 'persona' | 'craft', rawText: string, vocab: AuthoringVocab): ValidatedOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(rawText))
  } catch (error) {
    return { ok: false, reason: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: '输出不是 JSON 对象' }
  const obj = parsed as Record<string, unknown>

  if (type === 'persona') {
    if (!isStringArray(obj.keywords)) return { ok: false, reason: 'keywords 字段缺失或不是字符串数组' }
    if (obj.keywords.length === 0) return { ok: false, reason: '关键词不能为空' }
    return { ok: true, value: { keywords: obj.keywords } }
  }

  if (!isStringArray(obj.triggers)) return { ok: false, reason: 'triggers 字段缺失或不是字符串数组' }
  if (obj.triggers.length === 0) return { ok: false, reason: '触发词不能为空' }
  if (!isStringArray(obj.emotion_tags)) return { ok: false, reason: 'emotion_tags 字段缺失或不是字符串数组' }
  if (!isStringArray(obj.exclusions)) return { ok: false, reason: 'exclusions 字段缺失或不是字符串数组' }
  if (!isStringArray(obj.technique_tags)) return { ok: false, reason: 'technique_tags 字段缺失或不是字符串数组' }

  const badEmotion = outOfVocab(obj.emotion_tags, vocab.emotion_tags)
  if (badEmotion.length > 0) return { ok: false, reason: `emotion_tags 含词表外的词：${badEmotion.join('、')}` }
  const badTechnique = outOfVocab(obj.technique_tags, vocab.technique_tags)
  if (badTechnique.length > 0) return { ok: false, reason: `technique_tags 含词表外的词：${badTechnique.join('、')}` }

  return {
    ok: true,
    value: { triggers: obj.triggers, emotion_tags: obj.emotion_tags, exclusions: obj.exclusions, technique_tags: obj.technique_tags },
  }
}

/** 编译 prompt：把输出 JSON 形状与词表写死，要求「只输出 JSON」；重试时附上上次输出与失败原因。 */
function buildCompilePrompt(
  type: 'persona' | 'craft',
  source: CompileCardSource,
  vocab: AuthoringVocab | undefined,
  retry?: { lastOutput: string; reason: string },
): { system: string; user: string } {
  // triggers/keywords 的字面性要求是硬约束：运行时匹配是对章纲/声音描述文本的字面 includes，
  // 抽象概念词（「张力」「节奏感」）在那些文本里不会出现，编出来 = 卡永不出场。
  const shapeLine =
    type === 'persona'
      ? [
          '{"keywords": string[]}',
          'keywords：几个描述"这本书是什么气质"的关键词，从意图里提炼，不要照抄整句话。',
          '关键词要贴叙述声音描述里会字面出现的用语（如「冷峻」「市井烟火」「第一人称」），不要抽象概念词。',
        ].join('\n')
      : [
          '{"triggers": string[], "emotion_tags": string[], "exclusions": string[], "technique_tags": string[]}',
          'triggers：会触发这张卡出场的具体词，4-8 个，含同义变体（如「打脸」配「反杀」「翻盘」）。',
          '触发词必须是章纲文本里可能字面出现的词——场景名/动作/情绪词（如「追杀」「重逢」「谈判」），',
          '不要抽象概念词（如「张力」「氛围」「节奏感」——这类词在章纲里不会字面出现，卡就永远不出场）。',
          'emotion_tags / technique_tags：必须只从下面词表中选，一个都不能编造新词，没有合适的就填空数组。',
          'exclusions：明确不适用/要排除的场景，没有就填空数组。',
        ].join('\n')

  const vocabLines =
    type === 'craft' && vocab
      ? [`emotion_tags 词表：${vocab.emotion_tags.join('、')}`, `technique_tags 词表：${vocab.technique_tags.join('、')}`]
      : []

  const system = [
    '你是造包中心的意图编译器：把作者用大白话写的创作意图，翻译成结构化 JSON 字段。',
    `卡片类型：${type}。`,
    ...vocabLines,
    '只输出下面形状的 JSON，不要任何解释、不要 markdown 代码围栏、不要多余文字：',
    shapeLine,
  ].join('\n')

  const retryBlock = retry
    ? ['', '【上次输出】', retry.lastOutput || '（空）', '【失败原因】', retry.reason, '请修正后重新只输出合法 JSON。'].join('\n')
    : ''

  // intent 为主，one_line / 正文摘要补语境（都可能为空——手写卡刚建时只有意图）。
  const user =
    [
      `作者写的意图：\n${source.intent}`,
      source.oneLine ? `卡片一句话说明：${source.oneLine}` : '',
      source.bodyDigest ? `卡片正文摘要（帮助理解这张卡在讲什么，不要照抄整句）：\n${source.bodyDigest}` : '',
    ]
      .filter(Boolean)
      .join('\n\n') + retryBlock

  return { system, user }
}

/**
 * craft echo：确定性渲染，不信 LLM 回显。导出供 pack-local-content.ts 的 copyPackToDraft
 * 复用（已发布包复制回草稿时给 compiled.fields 反填同款 echo，不重复实现）。
 */
export function renderCraftEcho(fields: CraftLlmFields): string {
  return `系统的理解：会在出现「${fields.triggers.join('、')}」的章节出场；情绪贴合：${fields.emotion_tags.join('、') || '无'}；不用于：${fields.exclusions.join('、') || '无'}`
}

/** persona echo：确定性渲染，不信 LLM 回显。导出理由同 renderCraftEcho。 */
export function renderPersonaEcho(fields: PersonaFields): string {
  return `系统的理解：适合「${fields.keywords.join('、')}」气质的书`
}

/** structure echo：确定性渲染，label 从 shared/types/capability-pack.ts 的 STRUCTURE_STAGE_LABELS 取。导出理由同 renderCraftEcho。 */
export function renderStructureEcho(stage: StructureStage): string {
  return `系统的理解：${STRUCTURE_STAGE_LABELS[stage]}阶段的编排方法`
}

export function createPackCompiler(deps: PackCompilerDeps) {
  const createClient = deps.createClient ?? defaultCreateClient

  /**
   * 落盘编译结果：写之前重读盘上最新草稿并把 compiled 字段合并进当下的 cards（按 cardId 定位），
   * 不沿用调用方在 LLM 往返之前读到的旧数组——LLM 调用可能耗时数秒，期间用户可能已经在编辑其它卡
   * /删了卡/改了 README，若直接拿旧数组整体覆盖会把这些并发编辑静默回滚（IPC 层无串行化，
   * updatePackDraft 是整数组替换语义）。目标卡在重读时已不存在（被删）→ 不写，返回人话错误。
   * patch 只带 `cards`，不碰 meta/readme，天然不会触碰其它并发编辑的字段。
   */
  async function writeCompiledCard(
    userDataPath: string,
    draftId: string,
    cardId: string,
    compiled: CompiledCardMeta,
  ): Promise<{ status: 'ok' } | { status: 'error'; message: string }> {
    const fresh = await deps.readDraft({ userDataPath, draftId })
    if (!fresh) return { status: 'error', message: '草稿不存在。' }
    if (!fresh.cards.some((c) => c.cardId === cardId)) return { status: 'error', message: '卡已被删除。' }
    const updatedCards = fresh.cards.map((c) => (c.cardId === cardId ? { ...c, compiled } : c))
    await deps.writeDraft({ userDataPath, draftId, patch: { cards: updatedCards } })
    return { status: 'ok' }
  }

  async function compileCard(input: { userDataPath: string; draftId: string; cardId: string }): Promise<CompileCardResult> {
    const draft = await deps.readDraft({ userDataPath: input.userDataPath, draftId: input.draftId })
    if (!draft) return { status: 'error', message: '草稿不存在。' }
    const card = draft.cards.find((c) => c.cardId === input.cardId)
    if (!card) return { status: 'error', message: '卡片不存在。' }

    if (card.type === 'structure') {
      const stage = card.intent as StructureStage
      if (!(STRUCTURE_STAGES as readonly string[]).includes(stage)) {
        return { status: 'error', message: `结构阶段不合法：${card.intent}` }
      }
      const compiled: CompiledCardMeta = {
        fields: { stage, dimension: 'user-defined' },
        echo: renderStructureEcho(stage),
        engineVersion: deps.readEngineVersion(),
        compiledAt: new Date().toISOString(),
      }
      const writeResult = await writeCompiledCard(input.userDataPath, input.draftId, input.cardId, compiled)
      if (writeResult.status === 'error') return writeResult
      return { status: 'ok', compiled }
    }

    const config = await deps.readConfig()
    const light = resolveLightModel(config)
    const apiKey = light ? await deps.getApiKey(light.provider) : null
    if (!apiKey) return { status: 'error', message: '未配置 API Key，系统还理解不了你的意图。请先在设置里填写。' }
    const model = light?.modelId
    if (!model) return { status: 'error', message: '未配置可用模型，系统还理解不了你的意图。' }

    const vocab = card.type === 'craft' ? await deps.getVocab() : undefined
    const client = createClient({ apiKey, baseURL: light?.baseUrl || undefined })
    const source = buildCompileCardSource(card)

    let lastOutput = ''
    let lastReason = ''
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const { system, user } = buildCompilePrompt(
        card.type,
        source,
        vocab,
        attempt > 0 ? { lastOutput, reason: lastReason } : undefined,
      )
      let response: { content: Array<{ type: string; text?: string }> }
      try {
        response = await client.messages.create({
          model,
          system,
          messages: [{ role: 'user', content: user }],
          max_tokens: MAX_OUTPUT_TOKENS,
        })
      } catch (error) {
        // 网络/限流类错误不占重试名额（重试是为纠正 LLM 的非法输出，不是为了盲目重试网络故障）：
        // 直接 fail-fast 返回，不抛穿 compileCard，草稿保持不动。原始 error 留痕到 console.error，
        // 不把英文异常信息/服务商内部措辞透进 UI（黑话清理，终审 Minor·文案）。
        console.error('造包中心意图理解调用失败：', error)
        return { status: 'error', message: '系统暂时没能理解这段意图，请稍后重试。' }
      }
      const text = extractText(response.content)
      lastOutput = text
      const validated = validateLlmOutput(card.type, text, vocab ?? { emotion_tags: [], technique_tags: [], structure_stages: [] })
      if (validated.ok) {
        const fields: Record<string, unknown> =
          card.type === 'craft'
            ? { ...(validated.value as CraftLlmFields), priority: 50, beat_types: [] }
            : { ...(validated.value as PersonaFields) }
        const echo = card.type === 'craft' ? renderCraftEcho(validated.value as CraftLlmFields) : renderPersonaEcho(validated.value as PersonaFields)
        const compiled: CompiledCardMeta = {
          fields,
          echo,
          engineVersion: deps.readEngineVersion(),
          compiledAt: new Date().toISOString(),
        }
        const writeResult = await writeCompiledCard(input.userDataPath, input.draftId, input.cardId, compiled)
        if (writeResult.status === 'error') return writeResult
        return { status: 'ok', compiled }
      }
      lastReason = validated.reason
    }

    return { status: 'error', message: `AI 没能理解这段意图：${lastReason}` }
  }

  return { compileCard }
}

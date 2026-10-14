// electron/main/chat/character-chat-profiler.ts
import Anthropic from '@anthropic-ai/sdk'
import { providerRequestHeaders } from '@shared/lib/provider-request-headers'
import { resolveLightModel } from '@shared/lib/model-slots'
import { AUTHOR_PROFILE_MAX_CHARS, IMPRESSION_MAX_CHARS, readAuthorProfile, readImpressionMeta, writeAuthorProfile, writeImpression } from '../novel/character-chat-profiles.ts'
import type { AppConfig, ProviderId } from '../config.ts'
import type { CharacterChatMessage, CharacterChatTranscript, CharacterChatUserMode } from '@shared/types/character-chat'

/** 自上次提炼以来新增 complete 消息条数达到该值才触发后台提炼（user+character 一来一回算 2 条，6 条≈3 轮对话）。 */
export const PROFILE_REFINE_MIN_NEW_MESSAGES = 6

const AUTHOR_MARK = '===AUTHOR==='
const IMPRESSION_MARK = '===IMPRESSION==='

/** 取 lastProcessedMessageId 之后的 complete 消息（增量；游标不在列表则视为全部新）。 */
export function selectNewMessages(
  messages: CharacterChatMessage[],
  lastProcessedMessageId: string | null,
): CharacterChatMessage[] {
  const complete = messages.filter((message) => message.status === 'complete')
  if (!lastProcessedMessageId) return complete
  const idx = complete.findIndex((message) => message.id === lastProcessedMessageId)
  return idx === -1 ? complete : complete.slice(idx + 1)
}

export function buildProfilerPrompt(input: {
  authorProfile: string
  impression: string
  newMessages: CharacterChatMessage[]
  characterName: string
}): { system: string; user: string } {
  const system = [
    '你是一个沉默的后台助手，负责维护"用户画像"。给你看一段用户与某小说角色的新对话，',
    '请在【现有画像】基础上做增量更新（增/改，没有新信息就原样保留，宁缺毋滥，别把随口一句当铁律）。',
    '产出两份：',
    `1. 作者画像：关于"用户这个人"的稳定喜好/性格/聊天习惯（跨角色通用，≤ ${AUTHOR_PROFILE_MAX_CHARS} 字）。`,
    `2. 角色印象：这个角色对用户的主观印象与你俩的互动关键事（≤ ${IMPRESSION_MAX_CHARS} 字）。`,
    '严格只输出下面两段，用 markdown 短列表，不要任何解释：',
    `${AUTHOR_MARK}`,
    '（作者画像正文）',
    `${IMPRESSION_MARK}`,
    '（角色印象正文）',
  ].join('\n')

  const conversation = input.newMessages
    .map((message) => `${message.role === 'user' ? '用户' : input.characterName}：${message.text}`)
    .join('\n')

  const user = [
    `【角色】${input.characterName}`,
    '【现有作者画像】',
    input.authorProfile.trim() || '（空）',
    '【现有角色印象】',
    input.impression.trim() || '（空）',
    '【新对话】',
    conversation || '（无）',
  ].join('\n\n')

  return { system, user }
}

/** 按标记切分模型输出；缺任一标记返回 null（放弃本次提炼，不污染已有画像）。 */
export function parseProfilerOutput(text: string): { authorProfile: string; impression: string } | null {
  const authorIdx = text.indexOf(AUTHOR_MARK)
  const impressionIdx = text.indexOf(IMPRESSION_MARK)
  if (authorIdx === -1 || impressionIdx === -1 || impressionIdx < authorIdx) return null
  const authorProfile = text.slice(authorIdx + AUTHOR_MARK.length, impressionIdx).trim()
  const impression = text.slice(impressionIdx + IMPRESSION_MARK.length).trim()
  return { authorProfile, impression }
}

// ──────────────────────────────────────────────────────────────────────────────
// D2: 提炼工厂（调模型 + 落盘 + 游标 + 并发去重）
// ──────────────────────────────────────────────────────────────────────────────

/** 提炼用的非流式 create 接口（测试可注入假实现）。 */
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

export interface CharacterChatProfilerDeps {
  readConfig: () => Promise<AppConfig>
  getApiKey: (provider: ProviderId) => Promise<string | null>
  readTranscript: (identity: { projectPath: string; characterUid: string; userMode: CharacterChatUserMode }) => Promise<CharacterChatTranscript>
  readImpressionMeta: typeof readImpressionMeta
  readAuthorProfile: typeof readAuthorProfile
  writeAuthorProfile: typeof writeAuthorProfile
  writeImpression: typeof writeImpression
  createClient?: (args: { apiKey: string; baseURL?: string }) => AnthropicCreateLike
  profilesDir: string
}

const PROFILE_REFINE_MAX_OUTPUT_TOKENS = 1024

function defaultCreateClient(args: { apiKey: string; baseURL?: string }): AnthropicCreateLike {
  return new Anthropic({ apiKey: args.apiKey, baseURL: args.baseURL || undefined, defaultHeaders: providerRequestHeaders(args.baseURL) }) as unknown as AnthropicCreateLike
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

export function createCharacterChatProfiler(deps: CharacterChatProfilerDeps) {
  const createClient = deps.createClient ?? defaultCreateClient
  const inFlight = new Set<string>()

  async function maybeRefine(input: {
    projectPath: string
    characterUid: string
    characterName: string
    minNewMessages: number
  }): Promise<void> {
    const key = `${input.projectPath}${String.fromCharCode(0)}${input.characterUid}`
    if (inFlight.has(key)) return
    inFlight.add(key)
    try {
      const transcript = await deps.readTranscript({
        projectPath: input.projectPath,
        characterUid: input.characterUid,
        userMode: 'author',
      })
      const meta = await deps.readImpressionMeta(deps.profilesDir, {
        projectPath: input.projectPath,
        characterUid: input.characterUid,
      })
      const newMessages = selectNewMessages(transcript.messages, meta.lastProcessedMessageId)
      if (newMessages.length < input.minNewMessages) return

      const config = await deps.readConfig()
      const light = resolveLightModel(config)
      const apiKey = light ? await deps.getApiKey(light.provider) : null
      if (!apiKey) return
      // 提炼用轻量槽（跨 provider 独立，验证语义见 resolveLightModel）：简单抽取任务足够、最省。
      const model = light?.modelId
      if (!model) return

      const author = await deps.readAuthorProfile(deps.profilesDir)
      const { system, user } = buildProfilerPrompt({
        authorProfile: author.body,
        impression: meta.body,
        newMessages,
        characterName: input.characterName,
      })

      const client = createClient({ apiKey, baseURL: light?.baseUrl || undefined })
      const response = await client.messages.create({
        model,
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: PROFILE_REFINE_MAX_OUTPUT_TOKENS,
      })
      const parsed = parseProfilerOutput(extractText(response.content))
      if (!parsed) return

      const lastId = newMessages[newMessages.length - 1]?.id ?? meta.lastProcessedMessageId
      // 全局作者画像 compare-and-skip：基于读时 updatedAt，被其他写者抢先则跳过本次（不覆盖）。
      await deps.writeAuthorProfile(deps.profilesDir, parsed.authorProfile, { expectedUpdatedAt: author.updatedAt })
      await deps.writeImpression(deps.profilesDir, {
        projectPath: input.projectPath,
        characterUid: input.characterUid,
        body: parsed.impression,
        lastProcessedMessageId: lastId,
      })
    } catch {
      // 提炼失败一律静默，绝不影响聊天。
    } finally {
      inFlight.delete(key)
    }
  }

  return { maybeRefine }
}

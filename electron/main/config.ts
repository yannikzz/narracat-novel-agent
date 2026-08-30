import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findPoolEntry, modelEntryKey, resolvePrimaryModel } from '@shared/lib/model-slots'
import {
  DEFAULT_MODEL_POOL,
  DEFAULT_PROVIDER_SETTINGS,
  PROVIDER_IDS,
  WIRE_IDS,
  type AppConfig,
  type ModelEntryVerification,
  type ModelPoolEntry,
  type ProviderApiKeyMetadata,
  type ProviderId,
  type ProviderSettings,
  type WireId,
} from '@shared/types/config'

export { DEFAULT_MODEL_POOL, DEFAULT_PROVIDER_SETTINGS, PROVIDER_IDS, WIRE_IDS }
export type {
  AppConfig,
  ModelEntryVerification,
  ModelPoolEntry,
  ProviderApiKeyMetadata,
  ProviderId,
  ProviderSettings,
  WireId,
} from '@shared/types/config'

const MAX_RECENT_NOVELS = 20

/**
 * 旧三档契约（provider/baseUrl/models）已随 Task 7 退役，`shared/types/config.ts` 不再导出。
 * 这两个类型/常量只服务本文件内部的一次性旧盘面迁移分支（legacyMode），不是公开契约——
 * 新代码一律走 `modelPool`/`primaryModelKey`/`lightModelKey`。
 */
type LegacyModelTier = 'opus' | 'sonnet' | 'haiku'
type LegacyModelMapping = Record<LegacyModelTier, string>

const LEGACY_DEFAULT_MODELS: Record<ProviderId, LegacyModelMapping> = {
  deepseek: {
    opus: 'deepseek-v4-pro',
    sonnet: 'deepseek-v4-pro',
    haiku: 'deepseek-v4-pro',
  },
  anthropic: {
    opus: 'claude-opus-4-7',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5',
  },
  minimax: {
    opus: 'MiniMax-M2.5',
    sonnet: 'MiniMax-M2.5',
    haiku: 'MiniMax-M2',
  },
  glm: {
    opus: 'glm-5.2[1m]',
    sonnet: 'glm-5.2[1m]',
    haiku: 'glm-4.5-air',
  },
  custom: {
    opus: '',
    sonnet: '',
    haiku: '',
  },
}

function defaultNovelRoot(homeDir: string): string {
  return join(homeDir, 'Documents', 'NarraCat')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeProvider(value: unknown): ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as ProviderId)
    : 'deepseek'
}

function normalizeBaseUrl(provider: ProviderId, value: unknown): string {
  if (provider === 'anthropic') return ''
  const candidate = asTrimmedString(value)
  if (!candidate) return DEFAULT_PROVIDER_SETTINGS[provider].baseUrl

  try {
    const url = new URL(candidate)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString().replace(/\/$/, '')
  } catch {
    // Fall through to provider default.
  }

  return DEFAULT_PROVIDER_SETTINGS[provider].baseUrl
}

/**
 * wire 归一化：openai 仅对 custom 渠道开放，其余渠道（含手改配置文件）一律回落
 * anthropic——内置四家只有 Anthropic 兼容端点，错配会直接打崩分。非法缺失值同样回落
 * （型配置零破坏升级）。
 */
function normalizeWire(provider: ProviderId, value: unknown): WireId {
  return value === 'openai' && provider === 'custom' ? 'openai' : 'anthropic'
}

function normalizeModels(provider: ProviderId, value: unknown): LegacyModelMapping {
  const defaults = LEGACY_DEFAULT_MODELS[provider]
  const input = isRecord(value) ? value : {}

  return {
    opus: asTrimmedString(input.opus) ?? defaults.opus,
    sonnet: asTrimmedString(input.sonnet) ?? defaults.sonnet,
    haiku: asTrimmedString(input.haiku) ?? defaults.haiku,
  }
}

function normalizeRecentNovelPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const paths: string[] = []

  for (const item of value) {
    const path = asTrimmedString(item)
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
    if (paths.length >= MAX_RECENT_NOVELS) break
  }

  return paths
}

/** 「已看过的版本号」类字段的归一化：非负整数，其余一律回落 0（= 没看过）。 */
function normalizeSeenVersion(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * 匿名 ID 只接受 UUID 形态；手改成别的（比如填了邮箱、机器名）一律清空重生成——
 * 配置文件是用户可编辑的，不能假设里面永远是我们写进去的东西（ADR-0039）。
 */
function normalizeTelemetryAnonymousId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ? trimmed : ''
}

function normalizeApiKeyMetadata(value: unknown): Partial<Record<ProviderId, ProviderApiKeyMetadata>> {
  if (!isRecord(value)) return {}

  const metadata: Partial<Record<ProviderId, ProviderApiKeyMetadata>> = {}
  for (const provider of PROVIDER_IDS) {
    const item = value[provider]
    if (!isRecord(item)) continue
    const updatedAt = asTrimmedString(item.updatedAt)
    if (updatedAt) metadata[provider] = { updatedAt }
  }

  return metadata
}

function modelsEqual(left: LegacyModelMapping, right: LegacyModelMapping): boolean {
  return left.opus === right.opus && left.sonnet === right.sonnet && left.haiku === right.haiku
}

interface LegacyVerification {
  provider: ProviderId
  baseUrl: string
  models: LegacyModelMapping
  apiKeyUpdatedAt: string
  verifiedAt: string
  model?: string
}

function normalizeLegacyVerification(
  value: unknown,
  config: {
    provider: ProviderId
    baseUrl: string
    models: LegacyModelMapping
    apiKeyMetadata: Partial<Record<ProviderId, ProviderApiKeyMetadata>>
  },
): LegacyVerification | null {
  if (!isRecord(value)) return null

  const provider = normalizeProvider(value.provider)
  const baseUrl = normalizeBaseUrl(provider, value.baseUrl)
  const models = normalizeModels(provider, value.models)
  const apiKeyUpdatedAt = asTrimmedString(value.apiKeyUpdatedAt)
  const verifiedAt = asTrimmedString(value.verifiedAt)
  const model = asTrimmedString(value.model)
  const currentApiKeyUpdatedAt = config.apiKeyMetadata[config.provider]?.updatedAt

  if (!apiKeyUpdatedAt || !verifiedAt || !currentApiKeyUpdatedAt) return null
  if (provider !== config.provider) return null
  if (baseUrl !== config.baseUrl) return null
  if (!modelsEqual(models, config.models)) return null
  if (apiKeyUpdatedAt !== currentApiKeyUpdatedAt) return null

  return {
    provider,
    baseUrl,
    models,
    apiKeyUpdatedAt,
    verifiedAt,
    ...(model ? { model } : {}),
  }
}

function normalizeProviderSettings(value: unknown): Record<ProviderId, ProviderSettings> {
  const input = isRecord(value) ? value : {}
  const providers = {} as Record<ProviderId, ProviderSettings>
  for (const provider of PROVIDER_IDS) {
    const item = isRecord(input[provider]) ? (input[provider] as Record<string, unknown>) : {}
    providers[provider] = {
      baseUrl: normalizeBaseUrl(provider, item.baseUrl),
      wire: normalizeWire(provider, item.wire),
    }
  }
  return providers
}

function normalizeModelPool(
  value: unknown,
  context: {
    providers: Record<ProviderId, ProviderSettings>
    apiKeyMetadata: Partial<Record<ProviderId, ProviderApiKeyMetadata>>
  },
): ModelPoolEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const pool: ModelPoolEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const provider = item.provider
    if (typeof provider !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(provider)) continue
    const providerId = provider as ProviderId
    const modelId = asTrimmedString(item.modelId)
    if (!modelId) continue
    const key = modelEntryKey({ provider: providerId, modelId })
    if (seen.has(key)) continue
    seen.add(key)
    pool.push({
      provider: providerId,
      modelId,
      verification: normalizeEntryVerification(item.verification, providerId, context),
    })
  }
  return pool
}

/**
 * 验证快照自愈：Key 代际或端点（baseUrl/wire）与当前不符 → 直接清空（与旧 normalizeModelServiceVerification 同哲学）。
 * 旧快照无 wire 字段按 'anthropic' 读取（legacy 兼容）：渠道仍是 anthropic 则保持有效，已切 openai 则失效重验。
 */
function normalizeEntryVerification(
  value: unknown,
  provider: ProviderId,
  context: {
    providers: Record<ProviderId, ProviderSettings>
    apiKeyMetadata: Partial<Record<ProviderId, ProviderApiKeyMetadata>>
  },
): ModelEntryVerification | null {
  if (!isRecord(value)) return null
  const verifiedAt = asTrimmedString(value.verifiedAt)
  const apiKeyUpdatedAt = asTrimmedString(value.apiKeyUpdatedAt)
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : null
  const wire = normalizeWire(provider, value.wire)
  if (!verifiedAt || !apiKeyUpdatedAt || baseUrl === null) return null
  if (context.apiKeyMetadata[provider]?.updatedAt !== apiKeyUpdatedAt) return null
  if (context.providers[provider].baseUrl !== baseUrl) return null
  if (context.providers[provider].wire !== wire) return null
  return { verifiedAt, apiKeyUpdatedAt, baseUrl, wire }
}

function normalizeSlotKey(value: unknown, pool: ModelPoolEntry[]): string | null {
  const key = asTrimmedString(value)
  if (!key) return null
  return pool.some((entry) => modelEntryKey(entry) === key) ? key : null
}

export function normalizeAppConfig(value: unknown, homeDir = homedir()): AppConfig {
  const input = isRecord(value) ? value : {}
  const apiKeyMetadata = normalizeApiKeyMetadata(input.apiKeyMetadata)
  const legacyMode = !Array.isArray(input.modelPool) && isRecord(input.models)

  let providers: Record<ProviderId, ProviderSettings>
  let modelPool: ModelPoolEntry[]
  let primaryModelKey: string | null
  let lightModelKey: string | null

  if (legacyMode) {
    // 旧形态单向迁移（一次性，产物走新形态分支 → 幂等）
    const legacyProvider = normalizeProvider(input.provider)
    const legacyBaseUrl = normalizeBaseUrl(legacyProvider, input.baseUrl)
    const legacyModels = normalizeModels(legacyProvider, input.models)
    providers = normalizeProviderSettings({ [legacyProvider]: { baseUrl: legacyBaseUrl } })
    // 旧验证是否仍有效：完整复刻旧 normalizeModelServiceVerification 的比对语义
    const legacyVerification = normalizeLegacyVerification(input.modelServiceVerification, {
      provider: legacyProvider,
      baseUrl: legacyBaseUrl,
      models: legacyModels,
      apiKeyMetadata,
    })
    const verification: ModelEntryVerification | null = legacyVerification
      ? {
          verifiedAt: legacyVerification.verifiedAt,
          apiKeyUpdatedAt: legacyVerification.apiKeyUpdatedAt,
          baseUrl: legacyBaseUrl,
          // legacy 配置只可能是 anthropic wire（normalizeWire 对非 custom 渠道强制回落）
          wire: providers[legacyProvider].wire,
        }
      : null
    const ids: string[] = []
    for (const id of [legacyModels.opus, legacyModels.sonnet, legacyModels.haiku]) {
      if (id && !ids.includes(id)) ids.push(id)
    }
    modelPool = ids.map((modelId) => ({ provider: legacyProvider, modelId, verification }))
    const primaryId = legacyModels.sonnet || legacyModels.opus || legacyModels.haiku
    primaryModelKey = primaryId ? modelEntryKey({ provider: legacyProvider, modelId: primaryId }) : null
    const lightId = legacyModels.haiku
    const lightKey = lightId ? modelEntryKey({ provider: legacyProvider, modelId: lightId }) : null
    lightModelKey = lightKey === primaryModelKey ? null : lightKey
  } else {
    providers = normalizeProviderSettings(input.providers)
    modelPool = Array.isArray(input.modelPool)
      ? normalizeModelPool(input.modelPool, { providers, apiKeyMetadata })
      : DEFAULT_MODEL_POOL.map((entry) => ({ ...entry }))
    primaryModelKey =
      normalizeSlotKey(input.primaryModelKey, modelPool) ??
      (modelPool[0] ? modelEntryKey(modelPool[0]) : null)
    const rawLightKey = normalizeSlotKey(input.lightModelKey, modelPool)
    lightModelKey = rawLightKey === primaryModelKey ? null : rawLightKey
  }

  return {
    providers,
    modelPool,
    primaryModelKey,
    lightModelKey,
    apiKeyMetadata,
    novelRootDir: asTrimmedString(input.novelRootDir) ?? defaultNovelRoot(homeDir),
    recentNovelPaths: normalizeRecentNovelPaths(input.recentNovelPaths),
    systemNotificationsEnabled: input.systemNotificationsEnabled !== false,
    introVersion: normalizeSeenVersion(input.introVersion),
    // 默认开（ADR-0039 决定二 informed opt-out）；真正的防线是下面的告知版本号，
    // 它默认 0，意味着"没告知过"，发送闸门据此拦住存量用户升级后的静默上报。
    telemetryEnabled: input.telemetryEnabled !== false,
    telemetryNoticeAckedVersion: normalizeSeenVersion(input.telemetryNoticeAckedVersion),
    telemetryAnonymousId: normalizeTelemetryAnonymousId(input.telemetryAnonymousId),
  }
}


export function sanitizeConfigForDisk(value: unknown): AppConfig {
  return normalizeAppConfig(value)
}

export function isModelServiceVerified(config: AppConfig): boolean {
  return resolvePrimaryModel(normalizeAppConfig(config))?.verified === true
}

export function markProviderApiKeyUpdated(
  config: AppConfig,
  provider: ProviderId,
  updatedAt: string,
): AppConfig {
  return normalizeAppConfig({
    ...config,
    apiKeyMetadata: {
      ...config.apiKeyMetadata,
      [provider]: { updatedAt },
    },
  })
}

/**
 * 是否已为该 Provider 配置过 API Key——只读 config 元数据，不触碰系统钥匙串。
 * 用于启动 / 进设置页等「被动场景」展示「已保存 Key」状态：存 Key 时写 updatedAt、
 * 删 Key 时清除，故元数据存在即视为已配置。避免无谓读钥匙串触发 macOS 授权弹窗。
 */
export function hasConfiguredApiKey(config: AppConfig, provider: ProviderId): boolean {
  return Boolean(config.apiKeyMetadata[provider]?.updatedAt)
}

/**
 * 给用户的统一文案：API Key 含非法字符时怎么自救。保存校验与运行/测试守卫共用，口径一致。
 */
export const UNSAFE_API_KEY_MESSAGE =
  'API Key 含有非法字符（可能混入了中文、全角符号，或换行、制表符等不可见字符）。请到服务商后台重新复制完整密钥后粘贴。'

/**
 * 找出 API Key 里第一个会破坏 HTTP 请求头的字符，安全则返回 null。
 *
 * 根因：Key 经 `ANTHROPIC_API_KEY` 注入后会被底层 SDK 放进 `x-api-key` 请求头。两类字符会让请求崩、
 * 用户只看到看不懂的 "API Error"：
 * - 非 ASCII（码点 > 0x7E，如中文/全角）→ fetch 抛 "Cannot convert argument to a ByteString"。
 * - 控制字符（码点 < 0x20，如换行 \n、回车 \r、制表 \t、NUL）→ undici 抛 "invalid header value"。
 *
 * 故只放行可打印 ASCII（0x20–0x7E）。这一区间含空格与 `+ / = :` 等符号，不强收窄到字母数字，
 * 避免误伤自定义 Provider 用 base64 等格式的合法密钥（这类即便不对，也只换来一次干净的 401，不会崩）。
 *
 * 返回 `{ index, codePoint }`（第一个越界字符）。
 */
export function findUnsafeApiKeyCharacter(key: string): { index: number; codePoint: number } | null {
  for (let i = 0; i < key.length; i++) {
    const codePoint = key.charCodeAt(i)
    if (codePoint < 0x20 || codePoint > 0x7e) return { index: i, codePoint }
  }
  return null
}

export function clearProviderApiKeyMetadata(config: AppConfig, provider: ProviderId): AppConfig {
  const { [provider]: _cleared, ...apiKeyMetadata } = config.apiKeyMetadata
  return normalizeAppConfig({
    ...config,
    apiKeyMetadata,
  })
}

/** 按条目写验证快照：绑定当前 Key 代际与端点（baseUrl + wire）。Key 未配置或条目不存在则原样返回（保持未验证）。 */
export function markModelEntryVerified(config: AppConfig, modelKey: string, verifiedAt: string): AppConfig {
  const normalized = normalizeAppConfig(config)
  const entry = findPoolEntry(normalized, modelKey)
  const apiKeyUpdatedAt = entry ? normalized.apiKeyMetadata[entry.provider]?.updatedAt : undefined
  if (!entry || !apiKeyUpdatedAt) return normalized
  return normalizeAppConfig({
    ...normalized,
    modelPool: normalized.modelPool.map((item) =>
      modelEntryKey(item) === modelKey
        ? {
            ...item,
            verification: {
              verifiedAt,
              apiKeyUpdatedAt,
              baseUrl: normalized.providers[item.provider].baseUrl,
              wire: normalized.providers[item.provider].wire,
            },
          }
        : item,
    ),
  })
}

/** 渠道级验证（spec §2.2 v2）：测试连接成功后，该渠道全部启用条目批量盖章。 */
export function markProviderVerified(config: AppConfig, provider: ProviderId, verifiedAt: string): AppConfig {
  const normalized = normalizeAppConfig(config)
  const apiKeyUpdatedAt = normalized.apiKeyMetadata[provider]?.updatedAt
  if (!apiKeyUpdatedAt) return normalized
  const { baseUrl, wire } = normalized.providers[provider]
  return normalizeAppConfig({
    ...normalized,
    modelPool: normalized.modelPool.map((entry) =>
      entry.provider === provider ? { ...entry, verification: { verifiedAt, apiKeyUpdatedAt, baseUrl, wire } } : entry,
    ),
  })
}

export function getConfigPath(userDataPath: string): string {
  return join(userDataPath, 'config.json')
}

export async function readAppConfig(configPath: string): Promise<AppConfig> {
  try {
    const raw = await readFile(configPath, 'utf-8')
    return normalizeAppConfig(JSON.parse(raw))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return normalizeAppConfig(undefined)
    throw error
  }
}

export async function writeAppConfig(configPath: string, config: unknown): Promise<AppConfig> {
  const sanitized = sanitizeConfigForDisk(config)
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf-8')
  return sanitized
}

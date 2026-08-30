/** 受支持的 Provider 单一事实源；新增 Provider 只改这里，归一化/遍历自动覆盖。 */
export const PROVIDER_IDS = ['deepseek', 'anthropic', 'minimax', 'glm', 'custom'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/**
 * 接口协议（wire）：渠道端点走哪种 HTTP 协议。
 * - anthropic：Anthropic Messages wire（/v1/messages，x-api-key 头）——内置四家与默认。
 * - openai：OpenAI Chat Completions wire（/chat/completions，Bearer 头）——仅 custom 渠道可选，
 *   baseUrl 约定以 /v1 结尾原样使用。归一化层强制：非 custom 渠道一律回落 anthropic（防手改配置错配）。
 */
export const WIRE_IDS = ['anthropic', 'openai'] as const
export type WireId = (typeof WIRE_IDS)[number]

export interface ProviderApiKeyMetadata {
  updatedAt: string
}

export interface ProviderSettings {
  baseUrl: string
  wire: WireId
}

/** 池条目验证快照：绑定验证时刻的 Key 代际与端点（baseUrl + wire）；任一变化即失效（normalize 自愈清空）。 */
export interface ModelEntryVerification {
  verifiedAt: string
  apiKeyUpdatedAt: string
  baseUrl: string
  wire: WireId
}

export interface ModelPoolEntry {
  provider: ProviderId
  modelId: string
  verification: ModelEntryVerification | null
}

export interface AppConfig {
  providers: Record<ProviderId, ProviderSettings>
  modelPool: ModelPoolEntry[]
  /** "provider/modelId"；null = 池空未选 */
  primaryModelKey: string | null
  /** null = 跟随主力 */
  lightModelKey: string | null
  apiKeyMetadata: Partial<Record<ProviderId, ProviderApiKeyMetadata>>
  novelRootDir: string
  recentNovelPaths: string[]
  systemNotificationsEnabled: boolean
  /** 用户已看过的首次介绍版本；0=从未看过，介绍大改时递增以触发老用户重看一次 */
  introVersion: number
  /** 匿名使用统计开关（ADR-0039）。默认开，但告知屏确认前不发任何事件。 */
  telemetryEnabled: boolean
  /**
   * 已确认过的埋点告知屏版本；0=从未告知过。
   * 小于 CURRENT_TELEMETRY_NOTICE_VERSION 时弹告知屏，且在确认前零发送——
   * 这条是"没说就埋"的唯一防线（ADR-0039 决定八）。
   */
  telemetryNoticeAckedVersion: number
  /** 本机匿名 ID（随机 UUID，与机器指纹无关）；空串=尚未生成，首次发送时补上。 */
  telemetryAnonymousId: string
}

// F4（终审修复）：这三个默认值被大量测试 fixture 直接展开（`...POOL_DEFAULT_FIELDS` 等）；
// 冻结防止某处 fixture 原地 push/mutate 污染到其他用例共用的同一个对象引用（数组本身与
// 条目对象都冻结）。normalizeAppConfig 的拷贝路径全走 map/spread 产出新对象，不受影响。
export const DEFAULT_PROVIDER_SETTINGS: Record<ProviderId, ProviderSettings> = Object.freeze({
  deepseek: Object.freeze({ baseUrl: 'https://api.deepseek.com/anthropic', wire: 'anthropic' }),
  anthropic: Object.freeze({ baseUrl: '', wire: 'anthropic' }),
  minimax: Object.freeze({ baseUrl: 'https://api.minimaxi.com/anthropic', wire: 'anthropic' }),
  glm: Object.freeze({ baseUrl: 'https://open.bigmodel.cn/api/anthropic', wire: 'anthropic' }),
  custom: Object.freeze({ baseUrl: '', wire: 'anthropic' }),
})

export const DEFAULT_MODEL_POOL: ModelPoolEntry[] = Object.freeze([
  Object.freeze({ provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null }),
]) as ModelPoolEntry[]

export const DEFAULT_PRIMARY_MODEL_KEY = 'deepseek/deepseek-v4-pro'

/** AppConfig 字面量构造点位的过渡期补齐包（测试 fixture / 渲染端占位配置用）。 */
export const POOL_DEFAULT_FIELDS = Object.freeze({
  providers: DEFAULT_PROVIDER_SETTINGS,
  modelPool: DEFAULT_MODEL_POOL,
  primaryModelKey: DEFAULT_PRIMARY_MODEL_KEY,
  lightModelKey: null,
}) satisfies Pick<AppConfig, 'providers' | 'modelPool' | 'primaryModelKey' | 'lightModelKey'>

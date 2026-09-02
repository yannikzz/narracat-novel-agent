/**
 * 模型池槽位解析（纯函数，双进程共用）：池条目主键、主力/轻量槽解析、按条目验证判定。
 * 验证语义：条目快照（Key 代际 + 端点）与当前配置一致才算已验证——Key 或端点一换即自动失效。
 * 轻量槽 fail-soft：未设或未验证一律回落主力，绝不因轻活配置问题阻断创作链。
 */
import {
  DEFAULT_PROVIDER_SETTINGS,
  PROVIDER_IDS,
  type AppConfig,
  type ModelPoolEntry,
  type ProviderId,
  type WireId,
} from '@shared/types/config'

export type ModelSlotView = Pick<
  AppConfig,
  'providers' | 'modelPool' | 'primaryModelKey' | 'lightModelKey' | 'apiKeyMetadata'
>

export interface ResolvedModel {
  key: string
  provider: ProviderId
  baseUrl: string
  wire: WireId
  modelId: string
  verified: boolean
}

export function modelEntryKey(entry: Pick<ModelPoolEntry, 'provider' | 'modelId'>): string {
  return `${entry.provider}/${entry.modelId}`
}

export function parseModelKey(key: string): { provider: ProviderId; modelId: string } | null {
  const slash = key.indexOf('/')
  if (slash <= 0) return null
  const provider = key.slice(0, slash)
  const modelId = key.slice(slash + 1)
  if (!(PROVIDER_IDS as readonly string[]).includes(provider) || !modelId) return null
  return { provider: provider as ProviderId, modelId }
}

export function findPoolEntry(view: ModelSlotView, key: string | null): ModelPoolEntry | null {
  if (!key) return null
  return view.modelPool.find((entry) => modelEntryKey(entry) === key) ?? null
}

function providerBaseUrl(view: ModelSlotView, provider: ProviderId): string {
  return view.providers[provider]?.baseUrl ?? DEFAULT_PROVIDER_SETTINGS[provider].baseUrl
}

function providerWire(view: ModelSlotView, provider: ProviderId): WireId {
  const stored = view.providers[provider]?.wire
  return stored === 'anthropic' || stored === 'openai' ? stored : DEFAULT_PROVIDER_SETTINGS[provider].wire
}

export function isEntryVerified(view: ModelSlotView, entry: ModelPoolEntry): boolean {
  if (!entry.verification) return false
  const apiKeyUpdatedAt = view.apiKeyMetadata[entry.provider]?.updatedAt
  if (!apiKeyUpdatedAt) return false
  return (
    entry.verification.apiKeyUpdatedAt === apiKeyUpdatedAt &&
    entry.verification.baseUrl === providerBaseUrl(view, entry.provider) &&
    entry.verification.wire === providerWire(view, entry.provider)
  )
}

function resolveEntry(view: ModelSlotView, entry: ModelPoolEntry): ResolvedModel {
  return {
    key: modelEntryKey(entry),
    provider: entry.provider,
    baseUrl: providerBaseUrl(view, entry.provider),
    wire: providerWire(view, entry.provider),
    modelId: entry.modelId,
    verified: isEntryVerified(view, entry),
  }
}

/** 按池条目主键解析；键为空或条目已不在池里返回 null（调用方自行决定回落策略）。 */
export function resolveModelByKey(view: ModelSlotView, key: string | null): ResolvedModel | null {
  const entry = findPoolEntry(view, key)
  return entry ? resolveEntry(view, entry) : null
}

export function resolvePrimaryModel(view: ModelSlotView): ResolvedModel | null {
  const entry = findPoolEntry(view, view.primaryModelKey) ?? view.modelPool[0] ?? null
  return entry ? resolveEntry(view, entry) : null
}

/** 新启用条目的构造：继承同渠道第一个仍有效的验证快照（渠道级验证语义，spec §2.2 v2）。 */
export function buildPoolEntry(view: ModelSlotView, provider: ProviderId, modelId: string): ModelPoolEntry {
  const sibling = view.modelPool.find((entry) => entry.provider === provider && isEntryVerified(view, entry))
  return { provider, modelId, verification: sibling?.verification ? { ...sibling.verification } : null }
}

/** 快捷切换器的切换合法性：条目存在且验证有效。UI 置灰是第一道，主进程用它做服务端兜底。 */
export function canSetPrimaryModel(view: ModelSlotView, key: string): boolean {
  const entry = findPoolEntry(view, key)
  return entry !== null && isEntryVerified(view, entry)
}

export function resolveLightModel(view: ModelSlotView): ResolvedModel | null {
  const light = findPoolEntry(view, view.lightModelKey)
  if (light && isEntryVerified(view, light)) return resolveEntry(view, light)
  return resolvePrimaryModel(view)
}

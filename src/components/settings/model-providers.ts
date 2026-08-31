/**
 * 设置页「模型服务」渠道元数据 + 状态派生纯函数（渠道两级 UI v2 T3）。
 * 一级页 ModelProviderListPanel、二级页 ModelProviderDetailPanel 与二级导航（settings.tsx）共用；
 * MODEL_CATALOG 从旧 ModelServicePanel 搬家（旧 Panel 已在 T4 删除，此处是唯一副本）。
 */
import { isEntryVerified, type ModelSlotView } from '@shared/lib/model-slots'
import { PROVIDER_IDS, type ProviderId } from '@shared/types/config'

/** label 是纯厂商名（旧 Panel 的「DeepSeek V4 Pro」把具体型号焊进了渠道名，是遗留语义，这里修正）。 */
export const MODEL_PROVIDERS: Array<{ id: ProviderId; label: string; detail: string }> = [
  { id: 'deepseek', label: 'DeepSeek', detail: '默认生产通道，兼容 Anthropic 协议。' },
  { id: 'glm', label: '智谱 GLM', detail: '智谱 BigModel，兼容 Anthropic 协议。' },
  { id: 'minimax', label: 'MiniMax', detail: 'MiniMax 海螺，兼容 Anthropic 协议。' },
  { id: 'kimi', label: 'Kimi', detail: '月之暗面 Kimi，兼容 Anthropic 协议。' },
  { id: 'anthropic', label: 'Anthropic', detail: '官方 Claude 服务，直连时不需要填接口地址。' },
  { id: 'custom', label: '自定义', detail: '接入兼容 Anthropic/OpenAI 协议的服务或内部网关。' },
]

// 起步精选目录：官方模型迭代快且无可靠的列模型接口，故由 App 内置维护，
// 下拉给推荐项、同时允许手填任意 model id（见旧 ModelIdPicker，T4 迁移时随之搬家）。
export const MODEL_CATALOG: Record<ProviderId, string[]> = {
  deepseek: ['deepseek-v4-pro'],
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  minimax: ['MiniMax-M3', 'MiniMax-M2.5', 'MiniMax-M2'],
  glm: ['glm-5.2[1m]', 'glm-5.2', 'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5-air', 'glm-4.5-flash'],
  // ⚠️ Kimi 的模型清单端点在 OpenAI 侧（api.moonshot.cn/v1/models，Bearer 鉴权），
  // anthropic wire 的 {base}/v1/models 实测 404 —— 所以「刷新模型清单」对 Kimi 拿不到东西，
  // 这份内置目录是唯一来源（手填任意 model id 的路径不受影响）。
  // 已排除 kimi-k2.5 与 moonshot-v1 系列：官方 2026-08-31 全平台下线且早已停止接新用户。
  kimi: ['kimi-k3[1m]', 'kimi-k3', 'kimi-k2.6'],
  custom: [],
}

export type ProviderStatus =
  | { kind: 'unconfigured' } // 无 Key 且无条目
  | { kind: 'no-models' } // 有 Key 无条目
  | { kind: 'enabled'; count: number; verified: boolean } // 有条目；verified=该渠道全部条目 isEntryVerified

/**
 * 渠道级状态判据（三态，spec 见 brief 全局约束）：有条目就是 enabled，跟当前是否还留着 Key 无关
 * （Key 删了条目还在，仍按 enabled 展示，verified 会因 isEntryVerified 判 false 而自然掉色）；
 * 只有「无条目」时才需要用 Key 是否存在来区分 unconfigured / no-models。
 */
export function providerStatus(view: ModelSlotView, provider: ProviderId): ProviderStatus {
  const entries = view.modelPool.filter((entry) => entry.provider === provider)
  if (entries.length === 0) {
    const hasKey = Boolean(view.apiKeyMetadata[provider]?.updatedAt)
    return hasKey ? { kind: 'no-models' } : { kind: 'unconfigured' }
  }
  const verified = entries.every((entry) => isEntryVerified(view, entry))
  return { kind: 'enabled', count: entries.length, verified }
}

export function providerStatusLabel(status: ProviderStatus): string {
  switch (status.kind) {
    case 'unconfigured':
      return '未配置'
    case 'no-models':
      return '未启用模型'
    case 'enabled':
      return `${status.count} 个模型已启用 · ${status.verified ? '已连接' : '未测试'}`
  }
}

/** URL `provider` 参数 → ProviderId；非法值一律 null（回落一级页，不崩）。 */
export function parseModelProviderParam(raw: string | null): ProviderId | null {
  if (!raw) return null
  return (PROVIDER_IDS as readonly string[]).includes(raw) ? (raw as ProviderId) : null
}

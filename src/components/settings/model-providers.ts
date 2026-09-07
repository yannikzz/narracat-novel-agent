/**
 * 设置页「模型服务」渠道元数据 + 状态派生纯函数（渠道两级 UI v2 T3）。
 * 一级页 ModelProviderListPanel、二级页 ModelProviderDetailPanel 与二级导航（settings.tsx）共用；
 * MODEL_CATALOG 从旧 ModelServicePanel 搬家（旧 Panel 已在 T4 删除，此处是唯一副本）。
 */
import { isEntryVerified, type ModelSlotView } from '@shared/lib/model-slots'
import { PROVIDER_IDS, type ProviderId } from '@shared/types/config'

/** label 是纯厂商名（旧 Panel 的「DeepSeek V4 Pro」把具体型号焊进了渠道名，是遗留语义，这里修正）。 */
export const MODEL_PROVIDERS: Array<{
  id: ProviderId
  label: string
  detail: string
  /**
   * 该渠道在 anthropic wire 上没有可用的模型清单端点 → 详情页不渲染「刷新清单」按钮。
   *
   * 明知必然失败还把按钮摆出来，等于让用户去撞一次才知道不行；而内置目录 + 手填 model id
   * 已经让任务闭环，这个按钮对该渠道是纯噪音，故隐藏而非禁用（界面只留完成任务必要的信息）。
   * 通用实现（provider-models.ts）不为单个渠道加分支，判断收在这层元数据里。
   */
  noModelListEndpoint?: boolean
}> = [
  { id: 'deepseek', label: 'DeepSeek', detail: '默认生产通道，兼容 Anthropic 协议。' },
  { id: 'glm', label: '智谱 GLM', detail: '智谱 BigModel，兼容 Anthropic 协议。' },
  { id: 'minimax', label: 'MiniMax', detail: 'MiniMax 海螺，兼容 Anthropic 协议。' },
  {
    id: 'kimi',
    label: 'Kimi',
    detail: '月之暗面 Kimi，兼容 Anthropic 协议。',
    // 清单接口只在 OpenAI 侧（api.moonshot.cn/v1/models + Bearer）；anthropic wire 的
    // {base}/v1/models 实测 404（同路径 DeepSeek 401、GLM 200，只有 Kimi 如此）。
    noModelListEndpoint: true,
  },
  { id: 'anthropic', label: 'Anthropic', detail: '官方 Claude 服务，直连时不需要填接口地址。' },
  { id: 'custom', label: '自定义', detail: '接入兼容 Anthropic/OpenAI 协议的服务或内部网关。' },
]

// 起步精选目录：官方模型迭代快且无可靠的列模型接口，故由 App 内置维护，
// 下拉给推荐项、同时允许手填任意 model id（见旧 ModelIdPicker，T4 迁移时随之搬家）。
//
// 2026-09-07 按各家官方模型列表页核对（deepseek api-docs model_list / platform.claude.com models overview /
// docs.bigmodel.cn model-overview / platform.kimi.com models / platform.minimaxi.com text-generation）。
// 每条目录都是「官方仍在列且本仓链路能跑」的交集，不是官方全集：
// - anthropic 不收 claude-fable-5*：它对显式 `thinking: {type:'disabled'}` 回 400，而冷 pass / 润色 /
//   角色聊天三条路径都发这个字段，收进来等于给用户一个必炸的选项。
// - glm 不收 glm-5.3：官方写明思考恒开不可关、从 5.2 升级须把 thinking.type 改 enabled 否则失败，
//   与冷 pass 关思考的策略冲突；没有真机验证前不进目录，用户可手填。
// - ⚠️ 不要加任何 `xxx[1m]`：`kimi-k3[1m]` 真机 404（`Not found the model kimi-k3[1m]`），`glm-5.2[1m]`
//   同构——那个后缀是 Claude Code 客户端的上下文标记约定，各家 model 字段不认；本仓 pi 链路把 id 原样发出
//   且无剥离逻辑。deepseek-v4 / glm-5.2 / kimi-k3 本身即 1M 上下文，无需后缀。
// - 另有第二份副本 electron/main/config.ts 的 LEGACY_DEFAULT_MODELS（只服务旧三档配置一次性迁移），改目录须同步。
export const MODEL_CATALOG: Record<ProviderId, string[]> = {
  // v4-flash 同上限（1M / 384K）、三分之一价格，润色链 dogfood 在用。
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  // 5 代领头；4.7 / 4.6 仍可用但已是 legacy（退役不早于 2027 年），留给已在用的作者。
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  // M2.7 比 M2.5 新、同价；M2.x 官方标「历史模型仍支持」。
  minimax: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2'],
  // glm-4.7-flash 是免费档（200K / 128K），给试用者一个零成本入口。
  glm: ['glm-5.2', 'glm-5', 'glm-4.7', 'glm-4.7-flash', 'glm-4.6', 'glm-4.5-air', 'glm-4.5-flash'],
  // Kimi 拉不到清单（见上方 noModelListEndpoint），故这份目录 + 手填 model id 是它的全部来源，
  // 过期了要手工来改。已排除 kimi-k2.5 与 moonshot-v1 系列：官方 2026-08-31 全平台下线，
  // 且早已停止接新注册用户；k2.7-code 是编程向，对小说价值低，不收。
  kimi: ['kimi-k3', 'kimi-k2.6'],
  custom: [],
}

/**
 * 已下线 / 必 404 的 model id → 建议替代。用户手填过的旧 id 仍留在池里（归一化不对照目录），
 * 只在真调用时才 404；这张表让设置页当场标出来，而不是等作者写章时撞一次「模型不存在」。
 * 来源同上方核对：deepseek-chat / deepseek-reasoner 2026-07-24 退役；kimi-k2.5 与 moonshot-v1* 2026-08-31
 * 下线，kimi-k2* 05-25、kimi-latest 01-28；`[1m]` 后缀见上。
 */
const RETIRED_MODEL_IDS: Readonly<Record<ProviderId, Readonly<Record<string, string>>>> = Object.freeze({
  deepseek: Object.freeze({ 'deepseek-chat': 'deepseek-v4-flash', 'deepseek-reasoner': 'deepseek-v4-pro' }),
  anthropic: Object.freeze({}),
  minimax: Object.freeze({}),
  glm: Object.freeze({ 'glm-5.2[1m]': 'glm-5.2' }),
  kimi: Object.freeze({ 'kimi-k3[1m]': 'kimi-k3', 'kimi-k2.5': 'kimi-k2.6', 'kimi-latest': 'kimi-k3' }),
  custom: Object.freeze({}),
})

/** 该 id 是否已下线；是则给出建议替代 id，否则 null。前缀族（moonshot-v1*、kimi-k2-*）按前缀判。 */
export function retiredModelReplacement(provider: ProviderId, modelId: string): string | null {
  const exact = RETIRED_MODEL_IDS[provider][modelId]
  if (exact) return exact
  if (provider === 'kimi' && (modelId.startsWith('moonshot-v1') || /^kimi-k2(-|$)/.test(modelId))) return 'kimi-k3'
  return null
}

/** 该渠道能否拉模型清单（详情页据此决定渲不渲染「刷新清单」）。 */
export function canListModels(provider: ProviderId): boolean {
  return !MODEL_PROVIDERS.find((item) => item.id === provider)?.noModelListEndpoint
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

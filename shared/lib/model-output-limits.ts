/**
 * 模型输出上限（每次请求的 max_tokens）的单一事实源，双进程共用：
 * 主进程据此改写 pi 请求体（pi-max-output-tokens.ts），设置页据此给「输出上限」字段填建议值。
 *
 * 三层取值，优先级从高到低：
 * 1. **用户在池条目上填的值**（`ModelPoolEntry.maxOutputTokens`）——权威值，原样发出，可高可低。
 *    自定义渠道接的后端上限我们不可能知道，用户填是唯一诚实的来源；内置渠道用户也可以覆盖建议值。
 * 2. **建议值** = min(TARGET, 官方文档上限)——只对查得到第一手文档依据的模型给。
 * 3. **什么都没有** → 不改写请求体，走 pi 上游的 32000 硬顶（FALLBACK）。
 *
 * 为什么第 2 层要白名单：各家各模型的输出上限差得很远，发一个超过上限的 max_tokens 是硬 400，
 * 整条链当场断。失败方向朝着「维持现状」：白名单漏了某个模型，最坏是它还是 32000，不会把谁打挂。
 * 加新条目的门槛：**必须附第一手文档出处与核对日期**，二手转述（聚合站、搜索摘要）不算。
 */
import type { ProviderId } from '@shared/types/config'

/**
 * 我们**想要**的输出上限（建议值的封顶）。原为 32000（对齐 SDK 路径的 Claude CLI 默认值），
 * 真机撞顶后抬到 64000：DeepSeek V4 默认开着 thinking 且计入 output_tokens，第 22 章（3912 字）
 * 冷改实测 output 21561 tokens 中 87% 是 thinking，32000 只剩三分之一余量。
 * 不抬更高是取舍：max_tokens 只是上限不计费，但一次失控的思考会一路烧到这个数才停。
 */
export const TARGET_MAX_OUTPUT_TOKENS = 64_000

/** pi 上游硬顶（pi-ai@0.73.1 `simple-options.js` 的 `Math.min(model.maxTokens, 32000)`，假端点抓包实测）。 */
export const PI_UPSTREAM_MAX_OUTPUT_CAP = 32_000

/** 用户可填的合法区间：低于 1024 连一段正文都装不下，高于 2M 没有任何模型支持（只防手滑）。 */
export const MAX_OUTPUT_TOKENS_RANGE = Object.freeze({ min: 1_024, max: 2_000_000 })

/**
 * 已核实的模型输出上限（tokens），键为 `provider/模型 id`（`[1m]` 后缀先剥掉再查）。
 *
 * - `deepseek/*`：https://api-docs.deepseek.com/quick_start/pricing（2026-09-07 复核）——
 *   v4-pro 与 v4-flash 均为 context 1M / max output 384K。
 * - `anthropic/*`：https://platform.claude.com/docs/en/about-claude/models/overview（2026-09-07 复核）——
 *   Fable 5 / Opus 5 / Opus 4.8 / 4.7 / 4.6 / Sonnet 5 / 4.6 输出上限 128K；Haiku 4.5 为 64K。
 *   更老的 Claude（Sonnet 4.5、Opus 4.1…）各自不同且普遍更低，一律不收。
 * - `glm/*`：https://docs.bigmodel.cn/cn/guide/start/model-overview（2026-09-07 核对）——
 *   glm-5.3 / 5.2 / 5.1 / 5 / 5-turbo / 4.7 / 4.7-flash / 4.6 最大输出 128K；glm-4.5-air / 4.5-flash 为 96K。
 * - `kimi/kimi-k3`：https://platform.kimi.com/docs/models.md（2026-09-07 核对）——
 *   max_completion_tokens 默认 131,072（上限 1M）。kimi-k2.6 官方未写最大输出，不收。
 * - `minimax/*`：官方页未写最大输出（2026-09-07 查过 text-generation 与 pricing 页），不收。
 */
const DOCUMENTED_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  'deepseek/deepseek-v4-pro': 384_000,
  'deepseek/deepseek-v4-flash': 384_000,
  'anthropic/claude-fable-5': 128_000,
  'anthropic/claude-mythos-5': 128_000,
  'anthropic/claude-opus-5': 128_000,
  'anthropic/claude-opus-4-8': 128_000,
  'anthropic/claude-opus-4-7': 128_000,
  'anthropic/claude-opus-4-6': 128_000,
  'anthropic/claude-sonnet-5': 128_000,
  'anthropic/claude-sonnet-4-6': 128_000,
  'anthropic/claude-haiku-4-5': 64_000,
  'glm/glm-5.3': 128_000,
  'glm/glm-5.2': 128_000,
  'glm/glm-5.1': 128_000,
  'glm/glm-5': 128_000,
  'glm/glm-5-turbo': 128_000,
  'glm/glm-4.7': 128_000,
  'glm/glm-4.7-flash': 128_000,
  'glm/glm-4.6': 128_000,
  'glm/glm-4.5-air': 96_000,
  'glm/glm-4.5-flash': 96_000,
  'kimi/kimi-k3': 131_072,
})

/** 长上下文变体与基础模型是同一个模型，输出上限相同（`claude-opus-5[1m]` → `claude-opus-5`）。 */
function stripContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/, '')
}

/** 官方文档上限；`undefined` = 没查到第一手依据。 */
export function documentedMaxOutputTokens(provider: ProviderId | string, modelId: string): number | undefined {
  return DOCUMENTED_MAX_OUTPUT_TOKENS[`${provider}/${stripContextSuffix(modelId)}`]
}

/**
 * 建议值 = TARGET 与文档上限的较小值（文档上限比 TARGET 还低时，抬到 TARGET 就是硬 400）；
 * `undefined` = 查不到依据，别动请求体。
 */
export function suggestedMaxOutputTokens(provider: ProviderId | string, modelId: string): number | undefined {
  const documented = documentedMaxOutputTokens(provider, modelId)
  if (documented === undefined) return undefined
  return Math.min(TARGET_MAX_OUTPUT_TOKENS, documented)
}

/** 用户输入 → 合法整数或 undefined（空串/非整数/越界一律 undefined，交给调用方决定「留空」还是「报错」）。 */
export function normalizeMaxOutputTokens(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  if (!Number.isInteger(parsed)) return undefined
  if (parsed < MAX_OUTPUT_TOKENS_RANGE.min || parsed > MAX_OUTPUT_TOKENS_RANGE.max) return undefined
  return parsed
}

/** 本次请求该发多少 max_tokens：用户值 > 建议值 > undefined（不改写，走上游 32000）。 */
export function resolveMaxOutputTokens(entry: {
  provider: ProviderId | string
  modelId: string
  maxOutputTokens?: number
}): number | undefined {
  return normalizeMaxOutputTokens(entry.maxOutputTokens) ?? suggestedMaxOutputTokens(entry.provider, entry.modelId)
}

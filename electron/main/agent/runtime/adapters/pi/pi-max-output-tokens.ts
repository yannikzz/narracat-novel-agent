/**
 * 兑现输出上限的扩展：把请求体里的 `max_tokens` 抬到我们真正想要的值。
 *
 * ## 为什么需要它
 *
 * pi 在生产路径上把实发 `max_tokens` 封死在 32000，我们配多少都越不过去——
 * `pi-agent-core/dist/agent.js:114` 的 `streamFn = options.streamFn ?? streamSimple` +
 * `pi-coding-agent/dist/core/sdk.js:190` 不接受外部 streamFn ⇒ 恒走 `streamSimple` ⇒
 * `pi-ai/dist/providers/simple-options.js:1` 的 `Math.min(model.maxTokens, 32000)`。
 * 细节与抓包证据见 `pi-model.ts` 的 PI_UPSTREAM_MAX_OUTPUT_CAP。
 *
 * 唯一能改到真实请求体的官方口子是扩展事件 `before_provider_request`：
 * `sdk.js:215` 的 `onPayload` → `anthropic.js:318`（openai wire 是 `openai-completions.js:78`）
 * 拿返回值**整份替换** params。本扩展就挂在这里。
 *
 * ## 为什么不能盲抬
 *
 * 各家各模型的输出上限差得很远，发一个超过上限的 `max_tokens` 是**硬 400**，整条链当场断。
 * 所以这里只对**查得到第一手文档依据**的模型抬，其余一个字都不改、照旧走上游的 32000。
 * 失败方向朝着「维持现状」：白名单漏了某个模型，最坏结果是它还是 32000，不会把谁打挂。
 *
 * 加新条目的门槛：**必须附第一手文档出处与核对日期**，二手转述（聚合站、搜索摘要）不算。
 */
import { createSyntheticSourceInfo } from '@mariozechner/pi-coding-agent'
import type { Extension } from '@mariozechner/pi-coding-agent'
import { TARGET_MAX_OUTPUT_TOKENS } from './pi-model.ts'

/**
 * 已核实的模型输出上限（tokens），键为 `provider/模型 id`。
 *
 * - `deepseek/*`：DeepSeek 官方文档 https://api-docs.deepseek.com/quick_start/pricing
 *   （2026-08-21 核对）——v4-pro 与 v4-flash 均为 context 1M / max output 384K。
 * - `anthropic/*`：Anthropic 官方文档（2026-08-21 核对）——Fable 5 / Opus 5 / Opus 4.8 /
 *   Opus 4.7 / Opus 4.6 / Sonnet 5 / Sonnet 4.6 输出上限均为 128K。更老的 Claude（Sonnet 4.5、
 *   Haiku 4.5、Opus 4.1…）各自不同且普遍更低，**故一律不收**。
 *
 * 未列入的（minimax / glm / custom，以及任何我们没查过的模型 id）一律不抬——查 GLM 与 MiniMax
 * 时只找到聚合站的二手数字，够不上上面那条门槛。
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
})

/** 长上下文变体与基础模型是同一个模型，输出上限相同（`claude-opus-5[1m]` → `claude-opus-5`）。 */
function stripContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/, '')
}

/**
 * 本次 run 该发多少 `max_tokens`；`undefined` = 查不到依据，别动请求体。
 * 取 TARGET 与文档上限的较小值——文档上限比我们想要的还低时，抬到文档上限就是硬 400。
 */
export function resolvePiMaxOutputTokens(provider: string, modelId: string): number | undefined {
  const documented = DOCUMENTED_MAX_OUTPUT_TOKENS[`${provider}/${stripContextSuffix(modelId)}`]
  if (documented === undefined) return undefined
  return Math.min(TARGET_MAX_OUTPUT_TOKENS, documented)
}

/** 两条 wire 的字段名不同：anthropic 恒为 max_tokens，openai 视 compat 可能是 max_completion_tokens。 */
const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens'] as const

/**
 * 只抬不降：请求体里已经比目标值大就原样放行（那多半是别处有意设的，我们没有理由压它）。
 * 字段缺席也原样放行——凭空加一个字段是在猜 provider 的契约，不是我们该做的事。
 */
export function patchMaxOutputTokens(payload: unknown, maxTokens: number): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  const record = payload as Record<string, unknown>
  const field = MAX_TOKENS_FIELDS.find((name) => typeof record[name] === 'number')
  if (!field) return payload
  if ((record[field] as number) >= maxTokens) return payload
  return { ...record, [field]: maxTokens }
}

/** 挂在 before_provider_request 上的最小扩展；只有 resolvePiMaxOutputTokens 给出值时才装配。 */
export function createPiMaxOutputTokensPatch(maxTokens: number): Extension {
  const extensionPath = '<narracat:pi-max-output-tokens>'
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>()
  handlers.set('before_provider_request', [
    async (event) => {
      const payload = (event as { payload?: unknown }).payload
      const patched = patchMaxOutputTokens(payload, maxTokens)
      // 返回 undefined = 不替换（上游 runner.js:682 按 !== undefined 判定）。
      return patched === payload ? undefined : patched
    },
  ])
  return {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: createSyntheticSourceInfo(extensionPath, { source: 'narracat' }),
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  }
}

/**
 * 兑现输出上限的扩展：把请求体里的 `max_tokens` 改成我们真正想发的值。
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
 * ## 发多少
 *
 * 取值规则住在 shared/lib/model-output-limits（设置页共用同一份）：**用户在池条目上填的值 >
 * 文档建议值 > 不改写**。用户值是权威值——自定义渠道的后端上限只有用户知道，填得比 32000 低也
 * 照发（那多半是这个后端真的只有那么多，发 32000 反而是硬 400）。
 */
import { createSyntheticSourceInfo } from '@mariozechner/pi-coding-agent'
import type { Extension } from '@mariozechner/pi-coding-agent'
import { resolveMaxOutputTokens } from '@shared/lib/model-output-limits'
import { findPoolEntry, type ModelSlotView } from '@shared/lib/model-slots'

/**
 * 本次 run 该发多少 `max_tokens`；`undefined` = 没依据，别动请求体（走上游 32000）。
 * 按 `provider/modelId` 找池条目读用户值；条目不在池里（如轻量槽别名解析出的 id）只剩文档建议值。
 */
export function resolvePiMaxOutputTokens(config: ModelSlotView, provider: string, modelId: string): number | undefined {
  // pi Model 的 provider 是裸 string，池键格式与 modelEntryKey 一致（`provider/modelId`）。
  const entry = findPoolEntry(config, `${provider}/${modelId}`)
  return resolveMaxOutputTokens({ provider, modelId, maxOutputTokens: entry?.maxOutputTokens })
}

/** 两条 wire 的字段名不同：anthropic 恒为 max_tokens，openai 视 compat 可能是 max_completion_tokens。 */
const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens'] as const

/**
 * 字段存在且与目标值不同就改写（两个方向都改：用户填的值是权威值）。
 * 字段缺席原样放行——凭空加一个字段是在猜 provider 的契约，不是我们该做的事。
 */
export function patchMaxOutputTokens(payload: unknown, maxTokens: number): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  const record = payload as Record<string, unknown>
  const field = MAX_TOKENS_FIELDS.find((name) => typeof record[name] === 'number')
  if (!field) return payload
  if (record[field] === maxTokens) return payload
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

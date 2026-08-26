/**
 * Provider 装配（模型池化切片①）：AppConfig → Pi 自定义 Model 描述，主力/轻量槽驱动
 * （shared/lib/model-slots 的 resolvePrimaryModel/resolveLightModel）。
 * wire 推导（spec §5.2 演进）：anthropic wire 恒为 anthropic-messages + 自定 baseUrl，保住
 * P1B 在 anthropic wire 上的全部调优与前缀缓存；custom 渠道可显式选 openai wire
 * （Chat Completions /chat/completions，pi-ai 的 openai-completions 实现直取 model.baseUrl）。
 * 不写 models.json 文件——Model 对象直接传 createAgentSession（spike 报告实测形态）。
 */
import type { Model } from '@mariozechner/pi-ai'
import type { AppConfig } from '@shared/types/config'
import { resolveLightModel, resolvePrimaryModel } from '@shared/lib/model-slots'

/** 窗口值与 SDK 侧 CLAUDE_CODE_MAX_CONTEXT_TOKENS 对齐。 */
const ONE_M_CONTEXT_WINDOW = 1_000_000
const DEFAULT_CONTEXT_WINDOW = 200_000
/** 我们**想要**的输出上限。⚠️ 注意它当前并不等于实发值——上游把实发封在 32000，见下方
 * PI_UPSTREAM_MAX_OUTPUT_CAP。原为 32000（对齐 SDK 路径的 Claude CLI 默认值），真机撞顶后抬到 64000。
 *
 * 为什么 32000 不够：DeepSeek V4 默认开着 thinking，而 thinking 计入 output_tokens。真机第 22 章
 * （3912 字）走一次冷改实测 output 21561 tokens，其中 **87% 是 thinking**——32000 只剩三分之一
 * 余量，生产上冷改还要带任务书、正文路径与四遍指令，撞顶是必然。撞顶的后果不只是慢：主会话
 * 会一路降级重试（先禁止贴正文、再砍遍数、最后拆成定点补丁），把「冷改必须整章重缝」这条已被
 * 盲读验证过的质量纪律给跨了。
 *
 * provider 不是瓶颈：deepseek-v4-flash 输出上限 384K。卡住的也不是这个常量——是上游的 32000 硬顶。
 *
 * 注意这里只加余量，不动 thinking。thinking 的分档开关另见下方 PiThinkingMode（issue #42）：
 * 冷改关、热写开，冷改那 87% 已有盲读证据可以白省。超限仍触发 stopReason='length'，由事件映射
 * fail-loud。 */
export const TARGET_MAX_OUTPUT_TOKENS = 64_000

/**
 * 上游硬顶（本机假端点抓包实测，pi-ai@0.73.1）：**实发 max_tokens 恒为
 * `min(model.maxTokens, 32000)`，我们这边配多少都越不过 32000。**
 *
 * 链路：`pi-agent-core/dist/agent.js:114` 的 `streamFn = options.streamFn ?? streamSimple`
 * ——`pi-coding-agent/dist/core/sdk.js:190` 构造 Agent 时不接受外部 streamFn，生产恒走
 * `streamSimple` → `anthropic.js:561` 的 `streamSimpleAnthropic` → `simple-options.js:1` 的
 *
 *     maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32000) : undefined)
 *
 * 它把 `options.maxTokens` **恒填成一个正数**，于是 `anthropic.js:663` 的
 * `max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0` 永远走左边——**那条除 3 的分支
 * 在生产路径上根本到不了**。issue #35 当时按「除 3」写的补偿系数（×3）因此是空转，issue #46 把
 * 目标值 32000 抬到 64000 同样是空转：两次改动前后实发都是 32000。
 *
 * 抓包证据（走真实 `runPiSession` + 本机假 Anthropic 端点，读真实请求体）：
 * `model.maxTokens=20000 → 实发 20000`（除 3 的话应是 6666）、`60000 → 32000`、
 * `192000 → 32000`、`300000 → 32000`。
 *
 * ## 怎么突破 32000（已做）
 *
 * 唯一口子是官方扩展事件 `before_provider_request`（`sdk.js:215` 的 `onPayload` →
 * `anthropic.js:318` 用返回值整份替换 params），直接改写请求体里的 `max_tokens`。实现与白名单
 * 在 `pi-max-output-tokens.ts`——**只对查得到第一手文档依据的模型抬**，其余照旧 32000：各家上限
 * 差得很远，发一个超上限的值是硬 400。
 *
 * 所以「实发多少」现在有两种情况：装配了那个扩展 → TARGET；没装配 → 本函数返回的 32000。
 * `effectivePiMaxTokens` 描述的是**没有扩展时**的上游行为，别拿它当全局结论。
 */
export const PI_UPSTREAM_MAX_OUTPUT_CAP = 32_000
const DEFAULT_MAX_TOKENS = TARGET_MAX_OUTPUT_TOKENS

/**
 * 复刻上游真实算式（`simple-options.js` 的 buildBaseOptions），供测试与排查核对
 * 「我们配的值 → 实际发出去的值」。**排查时只信这个函数的返回值，别信 model.maxTokens。**
 */
export function effectivePiMaxTokens(modelMaxTokens: number): number {
  return Math.min(modelMaxTokens, PI_UPSTREAM_MAX_OUTPUT_CAP)
}
const ANTHROPIC_OFFICIAL_BASE_URL = 'https://api.anthropic.com'

/** 可选 wire 支持的 Model 泛型：anthropic-messages（默认）或 openai-completions（custom 渠道可选）。 */
export type PiModelWire = 'anthropic-messages' | 'openai-completions'

/**
 * 子 agent frontmatter 的 model 别名 → 槽位（模型池化）：opus/sonnet 继承 run 模型（主力槽），
 * haiku 映射轻量槽。子会话共用 run 的 provider/apiKey，故轻量槽跨 provider 时回落主力
 * （返回 undefined = 继承）；直调轻活路径无此约束。非法别名一律 undefined，不做透传旁路。
 */
export function resolvePiModelAlias(config: AppConfig, alias: string | undefined): string | undefined {
  if (alias !== 'haiku') return undefined
  const primary = resolvePrimaryModel(config)
  const light = resolveLightModel(config)
  if (!primary || !light) return undefined
  if (light.provider !== primary.provider) return undefined
  return light.modelId === primary.modelId ? undefined : light.modelId
}

/**
 * 思考档位（issue #42）。**这个开关的语义是「要不要由我们接管 thinking」，不是「开不开思考」**——
 * 关键在于「不发」与「发 disabled」是两件事：
 *
 * - `provider-default`：请求里**根本不带** thinking 字段 → provider 用自己的默认。DeepSeek V4 的
 *   默认是开着的，且文档写明 `budget_tokens` 被忽略（思考长度不可限制），所以这一档 = thinking 全开。
 * - `off`：显式发 `thinking: {type: "disabled"}` → 真正关掉。
 *
 * 为什么关它值钱：thinking 计入 `output_tokens`。真机实测冷改与热写两个环节，thinking 都占输出的
 * **87%**（冷改 21561 → 2775）。冷改是低自由度任务（输入是完整正文，只做打磨），两臂产出相似度
 * 98.7%、54 处差异全是采样抖动 —— 那 87% 是白烧的。热写反过来（盲读偏好开 thinking 的那份），
 * 所以只能分档，不能全局关。
 */
export type PiThinkingMode = 'provider-default' | 'off'

export function createPiModel(
  config: AppConfig,
  explicitId?: string,
  thinking: PiThinkingMode = 'provider-default',
): Model<PiModelWire> {
  const primary = resolvePrimaryModel(config)
  if (!primary) throw new Error('未配置任何模型，无法构造 Pi 模型描述')
  // openai wire 没有「官方默认端点」语义（custom 渠道必填 baseUrl）；空着打到 anthropic 官方端点
  // 会得到一堆难懂的 404，提前拦下给出可操作提示。
  if (primary.wire === 'openai' && !primary.baseUrl) {
    throw new Error('OpenAI 协议渠道需要先在设置中填写接口地址（以 /v1 结尾，如 https://example.com/v1）。')
  }
  const id = explicitId || primary.modelId
  return {
    id,
    name: id,
    api: primary.wire === 'openai' ? 'openai-completions' : 'anthropic-messages',
    provider: primary.provider,
    baseUrl: primary.baseUrl || ANTHROPIC_OFFICIAL_BASE_URL,
    /**
     * ⚠️ 字段名会骗人：`reasoning: true` 不是「开启思考」，而是「本请求由我们决定 thinking」。
     * 链路（pi-ai@0.73.1 / pi-agent-core）：`pi-session.ts` 恒传 `thinkingLevel: 'off'`
     * → `agent.js:280` 把它译成 `options.reasoning = undefined`
     * → `anthropic.js:561` 据此传 `thinkingEnabled: false`
     * → `anthropic.js:702` 的 `buildParams` **只有 `model.reasoning` 为真才进那段**，才写出
     *   `thinking: {type: "disabled"}`。
     * 所以 false 的效果是「一个字都不发、听 provider 的」，true 才是「显式关掉」。
     * 假端点抓包已验证两档实发的请求体（见 pi-model.test.ts 那条护栏用例的注释）。
     */
    reasoning: thinking === 'off',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // [1m] 按实际选中模型判（修掉旧「三档任一带即全局 1M」怪味）
    contextWindow: id.includes('[1m]') ? ONE_M_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  }
}

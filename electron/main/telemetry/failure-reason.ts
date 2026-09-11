import type { TelemetryFailureReason } from '@shared/types/telemetry'

/**
 * 把一次 run 失败归类成枚举码（ADR-0039 的"报错枚举码"灰区项）。
 *
 * **本文件是原始错误文本的终点站**：入参的 error 只用来判断落进哪个枚举，返回值永远是
 * TELEMETRY_FAILURE_REASONS 里的常量之一，一个来自错误文本的字符都不会被带出去。
 * 调用方只拿得到枚举——红线不靠"记得别写"，靠这个函数没有任何透传路径。
 *
 * 为什么要分类：`run-failed` 占写章节的 20%（2026-09-11 实测 94/471，44% 的活跃设备遇到过），
 * 但它只说"失败了"。不知道败在哪，就既不知道该修什么，也无法验证修完有没有效。
 *
 * 判定顺序是有讲究的，**从具体到宽泛**：
 *   ① run.failed 自带的结构化 reason 最可靠，有就直接用，不看文本；
 *   ② 语义关键词（"rate limit"、"context length"）比状态码可靠——状态码可能只是错误文本里
 *      恰好出现的数字；
 *   ③ 状态码兜底，且必须带词边界匹配。
 * 尤其 context-overflow 与 model-not-found 要排在 400 之前：上游常把这两种也返回成 400/404，
 * 先匹配语义才不会把它们冲进笼统的 provider-bad-request。
 */

/** run.failed 事件自带的结构化 reason → 埋点枚举。这四个是引擎自己判定的，最可信。 */
const STRUCTURED_REASONS: Readonly<Record<string, TelemetryFailureReason>> = Object.freeze({
  'max-turns': 'max-turns',
  'output-limit': 'output-limit',
  'idle-timeout': 'idle-timeout',
  'model-service-required': 'model-service-required',
})

/**
 * 关键词 → 枚举。**顺序即优先级**，命中即返回。
 *
 * 状态码一律用词边界（`\b429\b`），避免把 "request id 4291..." 这类数字误判成状态码。
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, TelemetryFailureReason]> = Object.freeze([
  // —— 上下文超限：上游常以 400 返回，必须排在 provider-bad-request 之前 ——
  [/context[_ -]?length|maximum context|context window|too many tokens|token limit/i, 'context-overflow'],

  // —— 模型/端点不存在：常以 404 返回，同样要先于状态码兜底 ——
  [/model[_ ]?not[_ ]?found|no such model|unknown model|model does not exist/i, 'model-not-found'],

  // —— 限流 ——
  [/rate[_ ]?limit|too many requests|quota exceeded|\b429\b/i, 'provider-rate-limit'],

  // —— 鉴权 ——
  [
    /unauthorized|forbidden|invalid[_ ]?api[_ ]?key|authentication|invalid token|permission denied|\b401\b|\b403\b/i,
    'provider-auth',
  ],

  // —— 流中途断：连上了、开始回了，然后断了。undici 的 `terminated` 是 #103 那位用户的原样报错 ——
  [
    /\bterminated\b|socket hang up|econnreset|\bepipe\b|premature close|stream (?:closed|ended|aborted)|aborted|other side closed/i,
    'network-interrupted',
  ],

  // —— 压根连不上：DNS、拒连、证书、连接超时。裸 `fetch failed`（undici 不带 cause 时的形态）
  //    归在这里——它的 cause 绝大多数是 ECONNREFUSED / ENOTFOUND 这类连接阶段故障 ——
  [
    /enotfound|econnrefused|eai_again|getaddrinfo|etimedout|connect(?:ion)? (?:timeout|refused|error)|certificate|self[- ]signed|fetch failed/i,
    'provider-unreachable',
  ],

  // —— 上游故障 ——
  [
    /internal server error|bad gateway|service unavailable|gateway timeout|overloaded|\b500\b|\b502\b|\b503\b|\b504\b/i,
    'provider-server-error',
  ],

  // —— 请求被拒：协议字段错配（自建网关 / 中转 / 本地 Ollama 落进 pi-ai 默认 compat 档）的主要形态 ——
  [/invalid[_ ]?request|bad request|unsupported|unrecognized|\b400\b|\b422\b/i, 'provider-bad-request'],
])

/**
 * 归类一次 run 失败。归不出来一律 `unknown`——宁可标成未知，也不要硬塞进某一类，
 * 那会让整张表失去意义。`unknown` 占比本身就是信号：过高说明 PATTERNS 该补了。
 */
export function classifyRunFailure(input: { reason?: string; error?: string }): TelemetryFailureReason {
  const structured = input.reason ? STRUCTURED_REASONS[input.reason] : undefined
  if (structured) return structured

  const text = input.error
  if (!text) return 'unknown'

  for (const [pattern, reason] of PATTERNS) {
    if (pattern.test(text)) return reason
  }
  return 'unknown'
}

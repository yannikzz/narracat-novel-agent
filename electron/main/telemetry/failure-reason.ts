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

/**
 * run.failed 事件自带的结构化 reason → 埋点枚举。这四个是引擎自己判定的，最可信。
 *
 * **用 Map 而不是对象字面量**：入参的 `reason` 是宽松的 `string`（故意的，好让不认识的新
 * reason 回落到文本判定）。对象查表会走原型链——`reason='constructor'` 会取到 `Function`，
 * 它 `String()` 之后只有 38 个字符、没有换行，**两道形态闸都拦不住，会真的发到 PostHog**。
 * 当前生产者的类型收窄让这不可达，但本文件的红线承诺是「返回值永远是枚举常量之一」，
 * 那句话不该依赖调用方的类型。
 */
const STRUCTURED_REASONS: ReadonlyMap<string, TelemetryFailureReason> = new Map([
  ['max-turns', 'max-turns'],
  ['output-limit', 'output-limit'],
  ['idle-timeout', 'idle-timeout'],
  ['model-service-required', 'model-service-required'],
] as const)

/**
 * HTTP 状态码的匹配形态。
 *
 * **不能裸用 `\b400\b`**：`\b` 在中文与连字符旁边同样成立，而本仓的错误文案本身就是
 * 中文夹数字——`写了 400 字后中断`、`耗时 500 ms` 都会被当成状态码。
 *
 * 所以只认两种位置：**行首**（`400 Bad Request` 这种最常见的形态），或**紧跟在状态词之后**
 * （`status: 404` / `HTTP/1.1 500` / `code 401`）。后面再跟数字的一律不算（`4001` 不是 400）。
 * 宁可漏判成 unknown，也不要把正文里的数字认成状态码——unknown 占比高只是提示该补表了，
 * 而误判会让整张表指向错误的结论。
 */
function statusCode(...codes: number[]): RegExp {
  const prefix = String.raw`(?:^|[(\[]|\bstatus\b\W{0,3}|\bcode\b\W{0,3}|\bHTTP\b\S*\s*|\berror\b\W{0,3})`
  return new RegExp(`${prefix}(?:${codes.join('|')})(?!\\d)`, 'i')
}

/**
 * 关键词 → 枚举。**顺序即优先级**，命中即返回。
 */

const PATTERNS: ReadonlyArray<readonly [RegExp, TelemetryFailureReason]> = Object.freeze([
  // —— 上下文超限：上游常以 400 返回，必须排在 provider-bad-request 之前 ——
  // 三家措辞各不相同，都要认：OpenAI 系 `maximum context length` / `context_length_exceeded`；
  // Anthropic `prompt is too long: N tokens > M maximum`、`input length and max_tokens exceed
  // context limit`；国内网关（GLM 等）直接中文。
  // ⚠️ 这一类归错会直接污染本次埋点最想量的那个数（provider-bad-request 的占比决定要不要做
  // 「后端类型」选择器），而超长章节写到后期必然撞上下文上限，量不小。
  [
    /context[_ -]?length|maximum context|context window|too many tokens|token limit|prompt is too long|exceeds? context limit|input length and|上下文|长度超过|超出.*(?:长度|上限)/i,
    'context-overflow',
  ],

  // —— 模型/端点不存在：常以 404 返回 ——
  // `does not exist` 与 `model` 之间会夹模型名（OpenAI 是 ``model `gpt-9` does not exist``），
  // 所以不能要求两者相邻；404 本身也要认，否则纯状态码形态会掉进 unknown。
  [
    /model[_ ]?not[_ ]?found|no such model|unknown model|does not exist|模型不存在|未找到模型/i,
    'model-not-found',
  ],
  [statusCode(404), 'model-not-found'],

  // —— 限流 ——
  [/rate[_ ]?limit|too many requests|quota exceeded|并发|请求过于频繁|频率过高/i, 'provider-rate-limit'],
  [statusCode(429), 'provider-rate-limit'],

  // —— 鉴权 ——
  [
    /unauthorized|forbidden|invalid[_ ]?api[_ ]?key|authentication|invalid token|permission denied|鉴权|认证失败|密钥|余额不足|欠费/i,
    'provider-auth',
  ],
  [statusCode(401, 403), 'provider-auth'],

  // —— 流中途断：连上了、开始回了，然后断了。undici 的 `terminated` 是 #103 那位用户的原样报错 ——
  // `aborted` 加词边界（别匹配到别的词里去），但保留裸匹配：请求被中止本身就属于这一类，
  // 去掉只会把真实的中止推进 unknown。用户主动取消走的是 cancelled 终态，根本不到这里。
  [
    /\bterminated\b|socket hang up|econnreset|\bepipe\b|premature close|stream (?:closed|ended|aborted)|\baborted\b|other side closed|连接中断|连接已断开/i,
    'network-interrupted',
  ],

  // —— 压根连不上：DNS、拒连、证书、连接超时。裸 `fetch failed`（undici 不带 cause 时的形态）
  //    归在这里——它的 cause 绝大多数是 ECONNREFUSED / ENOTFOUND 这类连接阶段故障 ——
  [
    /enotfound|econnrefused|eai_again|getaddrinfo|etimedout|connect(?:ion)? (?:timeout|refused|error)|certificate|self[- ]signed|fetch failed|无法连接|连接超时/i,
    'provider-unreachable',
  ],

  // —— 上游故障 ——
  [
    /internal server error|bad gateway|service unavailable|gateway timeout|overloaded|服务(?:暂时)?不可用|服务器(?:内部)?错误/i,
    'provider-server-error',
  ],
  [statusCode(500, 502, 503, 504), 'provider-server-error'],

  // —— 请求被拒：协议字段错配（自建网关 / 中转 / 本地 Ollama 落进 pi-ai 默认 compat 档）的主要形态 ——
  [/invalid[_ ]?request|bad request|unsupported|unrecognized|参数错误|请求(?:参数)?非法/i, 'provider-bad-request'],
  [statusCode(400, 422), 'provider-bad-request'],
])

/**
 * 归类一次 run 失败。归不出来一律 `unknown`——宁可标成未知，也不要硬塞进某一类，
 * 那会让整张表失去意义。`unknown` 占比本身就是信号：过高说明 PATTERNS 该补了。
 */
export function classifyRunFailure(input: { reason?: string; error?: string }): TelemetryFailureReason {
  const structured = input.reason ? STRUCTURED_REASONS.get(input.reason) : undefined
  if (structured) return structured

  const text = input.error
  if (!text) return 'unknown'

  for (const [pattern, reason] of PATTERNS) {
    if (pattern.test(text)) return reason
  }
  return 'unknown'
}

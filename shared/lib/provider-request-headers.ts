/**
 * 按渠道补的请求头（issue #108），双链路共用：pi（`model.headers`）与直连 `@anthropic-ai/sdk`
 * （`defaultHeaders`）各自挂到 SDK 原生扩展点上，判定只在这一处。
 *
 * opencode go 网关拒收缺头请求（400「Request is missing x-opencode-session」），官方文档
 * （opencode.ai/docs/go）要求两样：
 * - `x-opencode-session`：每段对话一个稳定 id，用于路由与提示缓存；
 * - `User-Agent`：客户端自己的标识，不能是 SDK / HTTP 库的默认名。
 *
 * 只对 opencode.ai 域名生效：其它渠道一个字节都不变，避免给不认识这些头的网关添乱。
 * 会话 id 由调用方按自身会话语义给；一次性请求不给时随机生成（仍满足「必须带」）。
 * 调用方不要把本机路径之类的隐私直接当 id——这个头会发给第三方服务商。
 */

export const NARRACAT_USER_AGENT = 'NarraCat'

export function isOpencodeGoEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

export function providerRequestHeaders(
  baseUrl: string | undefined,
  sessionId: string = globalThis.crypto.randomUUID(),
): Record<string, string> | undefined {
  if (!isOpencodeGoEndpoint(baseUrl)) return undefined
  return { 'User-Agent': NARRACAT_USER_AGENT, 'x-opencode-session': sessionId }
}

/**
 * 网络代理地址校验（issue #120），双进程共用：设置页据此即时提示，主进程据此决定是否生效。
 *
 * 只收 HTTP / HTTPS 代理：主进程用 Node 内置的全局代理（`http.setGlobalProxyFromEnv`），它不支持
 * SOCKS；Clash 等工具的混合端口本就同时接受 HTTP，填 http:// 即可。
 * 不收带账号密码的地址：配置文件是明文 json，凭据不能落盘明文（API Key 走 keytar 是同一条纪律）。
 * 只写「主机:端口」时按 http:// 补全——作者从代理工具里抄来的通常就是这个形状。
 */

export type NetworkProxyCheck = { ok: true; url: string } | { ok: false; error: string }

const FORMAT_ERROR = '代理地址格式不对，示例：http://127.0.0.1:7890'

export function checkNetworkProxyUrl(input: unknown): NetworkProxyCheck {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return { ok: true, url: '' }

  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch {
    return { ok: false, error: FORMAT_ERROR }
  }
  if (url.protocol.startsWith('socks')) {
    return { ok: false, error: '目前只支持 HTTP 代理。Clash 等工具的混合端口可以直接填 http://127.0.0.1:7890' }
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return { ok: false, error: FORMAT_ERROR }
  }
  if (url.username || url.password) {
    return { ok: false, error: '暂不支持带账号密码的代理地址。' }
  }
  return { ok: true, url: `${url.protocol}//${url.host}` }
}

/** 落盘口径：非法地址按「不使用代理」存，设置页在保存前已拦下并提示，这里只兜底手改配置文件。 */
export function normalizeNetworkProxyUrl(input: unknown): string {
  const checked = checkNetworkProxyUrl(input)
  return checked.ok ? checked.url : ''
}

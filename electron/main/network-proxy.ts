/**
 * 网络代理生效（issue #120）：主进程所有 Node fetch / http(s) 请求（模型服务、测试连接、埋点）走作者
 * 设置的代理；本机地址永远直连，本地模型（Ollama 等）不受影响。
 *
 * 用 Node 内置的 `http.setGlobalProxyFromEnv`，不引新依赖：它重置全局 agent 与 fetch 的全局
 * dispatcher，返回的函数恢复到调用前状态——再次设置前先恢复，「改成留空」就是回到直连。
 * Electron 自己的网络栈（自动更新下载等）不在此列，仍按系统设置走。
 */
import { setGlobalProxyFromEnv } from 'node:http'

const LOCAL_NO_PROXY = 'localhost,127.0.0.1,::1'

let restorePrevious: (() => void) | undefined

export function applyNetworkProxy(proxyUrl: string): void {
  restorePrevious?.()
  restorePrevious = undefined
  if (!proxyUrl) return
  restorePrevious = setGlobalProxyFromEnv({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: LOCAL_NO_PROXY })
}

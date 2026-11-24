import { useCallback, useEffect, useState } from 'react'
import { getConfig, saveConfig } from './ipc'
import { CURRENT_PRO_NOTICE_VERSION } from './pro-edition'

export type ProNoticeStatus = 'loading' | 'notice' | 'ready'

// 与 useIntroGate / useTelemetryNotice 一致的桥接探测：非 electron（测试 / 浏览器）环境无 IPC 桥。
function hasBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electron)
}

export function proNoticeNeeded(seenVersion: number | undefined): boolean {
  return (seenVersion ?? 0) < CURRENT_PRO_NOTICE_VERSION
}

/**
 * 专业版推荐的强提醒门：排在埋点告知屏之后、进首页之前，每个版本号只弹一次。
 * 读配置失败按 ready 放行——推荐不是保证，不能把用户挡在门外。
 */
export function useProNotice() {
  const [status, setStatus] = useState<ProNoticeStatus>('loading')

  useEffect(() => {
    if (!hasBridge()) {
      setStatus('ready')
      return
    }
    let cancelled = false
    getConfig()
      .then(({ config }) => {
        if (!cancelled) setStatus(proNoticeNeeded(config.proNoticeVersion) ? 'notice' : 'ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('ready')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 记「看过了」：点下载或「暂不」都算看过；回写失败下次再弹一次，可接受。
  const markSeen = useCallback(() => {
    if (!hasBridge()) return
    getConfig()
      .then(({ config }) => saveConfig({ ...config, proNoticeVersion: CURRENT_PRO_NOTICE_VERSION }))
      .catch(() => {})
  }, [])

  const complete = useCallback(() => {
    setStatus('ready')
    markSeen()
  }, [markSeen])

  return { status, markSeen, complete }
}

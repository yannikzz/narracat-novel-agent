import { useCallback, useEffect, useState } from 'react'
import { CURRENT_TELEMETRY_NOTICE_VERSION } from '@shared/types/telemetry'
import { acknowledgeTelemetryNotice, getTelemetryState, setTelemetryEnabled } from './ipc'

export type TelemetryNoticeStatus = 'loading' | 'notice' | 'ready'

// 与 useIntroGate / useReleaseGuard 一致的桥接探测：非 electron（测试 / 浏览器）环境无 IPC 桥。
function hasBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electron)
}

/**
 * 还要不要弹告知屏。判的是"确认过的版本 >= 当前版本"而非"确认过任意一版"——
 * 告知文案升版（CURRENT_TELEMETRY_NOTICE_VERSION +1）后，只见过旧口径的用户要重看一次，
 * 否则新增的采集项就等于没告知。
 */
export function telemetryNoticeNeeded(ackedVersion: number): boolean {
  return ackedVersion < CURRENT_TELEMETRY_NOTICE_VERSION
}

/**
 * 「不参与」：**先关开关，再记已告知**。顺序不能反——反了会在两次写配置之间留出一个
 * "已告知且默认开"的窗口，那一瞬间闸门是开的，可以发出事件。
 */
export async function declineTelemetry(): Promise<void> {
  await setTelemetryEnabled(false)
  await acknowledgeTelemetryNotice()
}

/**
 * 匿名使用统计的告知门（ADR-0039 决定八）。排在首启介绍之后：
 * 新用户看完介绍看它一次，存量用户升级后直接看它一次——两条路都走同一套标准，
 * 不给"老用户静默开启"留缝。
 *
 * 刻意**不**复用 introVersion 门控：那样会逼存量用户把五幕介绍重看一遍，
 * 为一屏告知付出的体验代价太大。
 *
 * 读状态失败时按 ready 放行（不把用户挡在门外）——此时主进程侧的闸门仍然是关的，
 * 因为它读的是同一份配置，读不到就不发。宁可少一次告知，也不能少一道闸。
 */
export function useTelemetryNotice() {
  const [status, setStatus] = useState<TelemetryNoticeStatus>('loading')

  useEffect(() => {
    if (!hasBridge()) {
      setStatus('ready')
      return
    }

    let cancelled = false
    getTelemetryState()
      .then((state) => {
        if (cancelled) return
        setStatus(telemetryNoticeNeeded(state.noticeAckedVersion) ? 'notice' : 'ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('ready')
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 「知道了」：记下已告知，主进程随即开始发送。 */
  const accept = useCallback(() => {
    setStatus('ready')
    if (!hasBridge()) return
    acknowledgeTelemetryNotice().catch(() => {})
  }, [])

  const decline = useCallback(() => {
    setStatus('ready')
    if (!hasBridge()) return
    declineTelemetry().catch(() => {})
  }, [])

  return { status, accept, decline }
}

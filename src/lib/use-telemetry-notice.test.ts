import { afterEach, describe, expect, test } from 'bun:test'
import { CURRENT_TELEMETRY_NOTICE_VERSION } from '@shared/types/telemetry'
import { declineTelemetry, telemetryNoticeNeeded } from './use-telemetry-notice'

/**
 * 告知门的契约测试（ADR-0039 决定八）。钉的是两件在真机上几乎不可能被人肉发现的事：
 *   ①只确认过旧版告知的用户必须重看——否则新增采集项等于没告知；
 *   ②「不参与」必须先关开关、后记已告知——顺序反了会留出一个"已告知且默认开"的窗口，
 *     那一瞬间是能发出事件的，表现只是"偶尔多几条数据"，没人会察觉。
 */

const originalWindow = globalThis.window

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
})

describe('要不要弹告知屏', () => {
  test('从未告知过的用户要看', () => {
    expect(telemetryNoticeNeeded(0)).toBe(true)
  })

  test('确认过当前版本的不再打扰', () => {
    expect(telemetryNoticeNeeded(CURRENT_TELEMETRY_NOTICE_VERSION)).toBe(false)
  })

  test('只确认过旧版本的要重看一次', () => {
    expect(telemetryNoticeNeeded(CURRENT_TELEMETRY_NOTICE_VERSION - 1)).toBe(true)
  })
})

describe('「不参与」', () => {
  test('先关开关，再记已告知——中间不留可发送的窗口', async () => {
    const calls: string[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electron: {
          setTelemetryEnabled: async (enabled: boolean) => {
            calls.push(`set:${enabled}`)
            return { enabled, noticeAckedVersion: 0, anonymousId: '' }
          },
          acknowledgeTelemetryNotice: async () => {
            calls.push('ack')
            return { enabled: false, noticeAckedVersion: CURRENT_TELEMETRY_NOTICE_VERSION, anonymousId: '' }
          },
        },
      },
    })

    await declineTelemetry()

    expect(calls).toEqual(['set:false', 'ack'])
  })

  test('关开关失败时不记已告知——下次启动会重新问，而不是当成已同意', async () => {
    const calls: string[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electron: {
          setTelemetryEnabled: async () => {
            throw new Error('写配置失败')
          },
          acknowledgeTelemetryNotice: async () => {
            calls.push('ack')
            return { enabled: true, noticeAckedVersion: CURRENT_TELEMETRY_NOTICE_VERSION, anonymousId: '' }
          },
        },
      },
    })

    await expect(declineTelemetry()).rejects.toThrow('写配置失败')
    expect(calls).toEqual([])
  })
})

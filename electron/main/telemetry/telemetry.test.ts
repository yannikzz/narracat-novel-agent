import { describe, expect, test } from 'bun:test'
import {
  buildWirePayload,
  createFeatureUsedDeduper,
  dayKey,
  durationBucket,
  isTelemetryAllowed,
  sanitizeEvent,
  sizeBucket,
  trimQueue,
} from './telemetry.ts'
import type { TelemetryEvent, TelemetryQueuedEvent } from '@shared/types/telemetry'

const AT = new Date('2026-08-30T10:00:00.000Z')

describe('分桶', () => {
  test('章数落桶', () => {
    expect(sizeBucket(0)).toBe('0')
    expect(sizeBucket(1)).toBe('1-5')
    expect(sizeBucket(5)).toBe('1-5')
    expect(sizeBucket(6)).toBe('6-20')
    expect(sizeBucket(20)).toBe('6-20')
    expect(sizeBucket(21)).toBe('21-100')
    expect(sizeBucket(100)).toBe('21-100')
    expect(sizeBucket(101)).toBe('100+')
  })

  test('非法输入落最小桶而不是抛或发出原值', () => {
    expect(sizeBucket(Number.NaN)).toBe('0')
    expect(sizeBucket(-3)).toBe('0')
    expect(durationBucket(Number.NaN)).toBe('<1m')
  })

  test('时长落桶覆盖每个边界', () => {
    expect(durationBucket(59_999)).toBe('<1m')
    expect(durationBucket(60_000)).toBe('1-5m')
    expect(durationBucket(5 * 60_000 - 1)).toBe('1-5m')
    expect(durationBucket(5 * 60_000)).toBe('5-15m')
    expect(durationBucket(15 * 60_000)).toBe('15-30m')
    expect(durationBucket(30 * 60_000)).toBe('30m+')
  })
})

describe('清洗（红线的机械执行者）', () => {
  test('白名单外的字段被丢掉', () => {
    const event = {
      event: 'feature_used',
      props: { module: 'write-chapter', chapterTitle: '第一章 开局' },
    } as unknown as TelemetryEvent
    expect(sanitizeEvent(event, AT)?.props).toEqual({ module: 'write-chapter' })
  })

  test('值带换行或超长 → 整条丢弃（枚举值不可能长这样，只可能是夹带了文本）', () => {
    const withNewline = {
      event: 'error_occurred',
      props: { code: 'run-failed\n模型返回：他推开门', module: 'write-chapter' },
    } as unknown as TelemetryEvent
    expect(sanitizeEvent(withNewline, AT)).toBeNull()

    const tooLong = {
      event: 'error_occurred',
      props: { code: 'x'.repeat(65), module: 'write-chapter' },
    } as unknown as TelemetryEvent
    expect(sanitizeEvent(tooLong, AT)).toBeNull()
  })

  test('未登记的事件名发不出去', () => {
    const rogue = { event: 'chapter_text', props: {} } as unknown as TelemetryEvent
    expect(sanitizeEvent(rogue, AT)).toBeNull()
  })
})

describe('发送闸门', () => {
  test('告知过且开着才放行', () => {
    expect(isTelemetryAllowed({ enabled: true, noticeAckedVersion: 1, currentNoticeVersion: 1 })).toBe(true)
  })

  test('开着但没告知过 → 不发（存量用户升级后的静默上报就卡在这）', () => {
    expect(isTelemetryAllowed({ enabled: true, noticeAckedVersion: 0, currentNoticeVersion: 1 })).toBe(false)
  })

  test('告知文案升版后，只确认过旧版的用户重新被拦住', () => {
    expect(isTelemetryAllowed({ enabled: true, noticeAckedVersion: 1, currentNoticeVersion: 2 })).toBe(false)
  })

  test('用户关了就一律不发', () => {
    expect(isTelemetryAllowed({ enabled: false, noticeAckedVersion: 9, currentNoticeVersion: 1 })).toBe(false)
  })
})

describe('队列裁剪', () => {
  function entry(at: string): TelemetryQueuedEvent {
    return { event: 'app_started', props: {}, at }
  }

  test('超过保留期的丢掉', () => {
    const now = new Date('2026-08-30T00:00:00.000Z')
    const kept = trimQueue([entry('2026-08-20T00:00:00.000Z'), entry('2026-08-29T00:00:00.000Z')], { now })
    expect(kept.map((e) => e.at)).toEqual(['2026-08-29T00:00:00.000Z'])
  })

  test('超过条数上限时丢最旧的', () => {
    const now = new Date('2026-08-30T00:00:00.000Z')
    const events = Array.from({ length: 5 }, (_, i) =>
      entry(new Date(now.getTime() - (5 - i) * 1000).toISOString()),
    )
    const kept = trimQueue(events, { now, maxItems: 2 })
    expect(kept).toEqual(events.slice(3))
  })

  test('时间戳坏掉的条目直接丢，不会靠 NaN 混过保留期判定', () => {
    const now = new Date('2026-08-30T00:00:00.000Z')
    expect(trimQueue([entry('不是时间')], { now })).toEqual([])
  })
})

describe('每日去重', () => {
  test('同一模块同一天只记一次，跨天恢复', () => {
    const deduper = createFeatureUsedDeduper()
    const day1 = new Date('2026-08-30T01:00:00')
    const day1Later = new Date('2026-08-30T23:00:00')
    const day2 = new Date('2026-08-31T01:00:00')
    expect(deduper.shouldRecord('outline', day1)).toBe(true)
    expect(deduper.shouldRecord('outline', day1Later)).toBe(false)
    expect(deduper.shouldRecord('outline', day2)).toBe(true)
  })

  test('不同模块互不干扰', () => {
    const deduper = createFeatureUsedDeduper()
    expect(deduper.shouldRecord('outline', AT)).toBe(true)
    expect(deduper.shouldRecord('premise', AT)).toBe(true)
  })

  test('自然日按本地时区算（跨时区不会把同一天算成两天）', () => {
    expect(dayKey(new Date(2026, 7, 30, 23, 30))).toBe('2026-08-30')
  })
})

describe('上报载荷', () => {
  test('只包含事件名、匿名 ID、时刻与白名单属性', () => {
    const payload = buildWirePayload([{ event: 'feature_used', props: { module: 'outline' }, at: AT.toISOString() }], {
      anonymousId: 'abc',
      schemaVersion: 1,
    })
    expect(payload).toEqual({
      batch: [
        {
          event: 'feature_used',
          distinct_id: 'abc',
          timestamp: AT.toISOString(),
          properties: { module: 'outline', schema_version: 1 },
        },
      ],
    })
  })

  test('载荷里没有 api_key —— Key 只存在于 Worker', () => {
    const payload = buildWirePayload([], { anonymousId: 'abc', schemaVersion: 1 })
    expect(payload.api_key).toBeUndefined()
  })
})

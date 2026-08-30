import { describe, expect, test } from 'bun:test'
import { sanitizeIncomingEvent } from './index.ts'

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const AT = '2026-08-30T10:00:00.000Z'

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'feature_used',
    distinct_id: UUID,
    timestamp: AT,
    properties: { module: 'write-chapter', schema_version: 1 },
    ...overrides,
  }
}

describe('服务端红线（第二道闸）', () => {
  test('合格事件原样通过', () => {
    expect(sanitizeIncomingEvent(event())).toEqual({
      event: 'feature_used',
      distinct_id: UUID,
      timestamp: AT,
      properties: { module: 'write-chapter', schema_version: 1 },
    })
  })

  test('字典外的属性被裁掉——客户端被改过也送不进 PostHog', () => {
    const smuggled = event({
      properties: { module: 'write-chapter', chapter_text: '他推开门，风雪扑面而来。' },
    })
    expect(sanitizeIncomingEvent(smuggled)?.properties).toEqual({ module: 'write-chapter' })
  })

  test('属性值带换行或超长 → 整条丢弃', () => {
    expect(sanitizeIncomingEvent(event({ properties: { module: '写\n作' } }))).toBeNull()
    expect(sanitizeIncomingEvent(event({ properties: { module: 'x'.repeat(65) } }))).toBeNull()
  })

  test('未登记的事件名丢弃', () => {
    expect(sanitizeIncomingEvent(event({ event: 'chapter_text' }))).toBeNull()
  })

  test('distinct_id 不是 UUID 就丢弃（防止有人拿它当自由文本字段）', () => {
    expect(sanitizeIncomingEvent(event({ distinct_id: 'yangnik@example.com' }))).toBeNull()
    expect(sanitizeIncomingEvent(event({ distinct_id: '' }))).toBeNull()
  })

  test('时间戳缺失或非法就丢弃', () => {
    expect(sanitizeIncomingEvent(event({ timestamp: '不是时间' }))).toBeNull()
    expect(sanitizeIncomingEvent(event({ timestamp: undefined }))).toBeNull()
  })

  test('非对象输入不会炸', () => {
    expect(sanitizeIncomingEvent(null)).toBeNull()
    expect(sanitizeIncomingEvent('feature_used')).toBeNull()
    expect(sanitizeIncomingEvent(42)).toBeNull()
  })

  test('properties 缺失时按空属性通过（事件本身仍然有计数价值）', () => {
    expect(sanitizeIncomingEvent(event({ event: 'app_started', properties: undefined }))?.properties).toEqual({})
  })
})

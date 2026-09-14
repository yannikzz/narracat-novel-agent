import { describe, expect, test } from 'bun:test'
import { TELEMETRY_ALLOWED_PROP_KEYS } from '../../../shared/types/telemetry.ts'
import { ALLOWED, sanitizeIncomingEvent } from './index.ts'

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

// 两份白名单刻意各写一份（Worker 与 App 分开部署，服务端要能独立对着字典拦），但**内容必须
// 一致**。此前只靠两处注释互相提醒「改一边必须同改另一边」——而这个仓库的信条是「红线不靠
// 记得别写，靠机械执行」。守卫跑在同一个仓库里，不影响 Worker 独立部署这个设计意图。
describe('两份白名单不许漂移', () => {
  test('与 shared/types/telemetry.ts 逐条一致', () => {
    const app = Object.fromEntries(
      Object.entries(TELEMETRY_ALLOWED_PROP_KEYS).map(([event, keys]) => [event, [...keys]]),
    )
    const worker = Object.fromEntries(Object.entries(ALLOWED).map(([event, keys]) => [event, [...keys]]))
    expect(worker).toEqual(app)
  })
})

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

  // 失败原因是新加的白名单字段（2026-09-11）。服务端独立于客户端再放行一次：
  // Worker 与 App 分开部署，不能假设线上跑的客户端就是当前这份源码。
  test('失败原因字段放行，同一条里夹带的正文仍被裁掉', () => {
    const withReason = event({
      event: 'error_occurred',
      properties: {
        code: 'run-failed',
        module: 'write-chapter',
        reason: 'provider-bad-request',
        chapter_text: '他推开门，风雪扑面而来。',
      },
    })
    expect(sanitizeIncomingEvent(withReason)?.properties).toEqual({
      code: 'run-failed',
      module: 'write-chapter',
      reason: 'provider-bad-request',
    })
  })

  // `in` 会命中原型链：event='constructor' 能过白名单检查，随后展开 ALLOWED[name] 拿到
  // 的是 Function，当场抛 TypeError，而 fetch 外层没有兜底——公网端点一条 curl 打成 500。
  test('原型链上的键不是事件名', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(sanitizeIncomingEvent(event({ event: name }))).toBeNull()
    }
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

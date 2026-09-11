import { describe, expect, test } from 'bun:test'
import { TELEMETRY_FAILURE_REASONS } from '@shared/types/telemetry'
import { classifyRunFailure } from './failure-reason.ts'

describe('结构化 reason 优先', () => {
  // run.failed 自带的 reason 是引擎自己判定的，比猜文本可靠，有就不看文本。
  test('四种结构化 reason 直接映射', () => {
    expect(classifyRunFailure({ reason: 'max-turns' })).toBe('max-turns')
    expect(classifyRunFailure({ reason: 'output-limit' })).toBe('output-limit')
    expect(classifyRunFailure({ reason: 'idle-timeout' })).toBe('idle-timeout')
    expect(classifyRunFailure({ reason: 'model-service-required' })).toBe('model-service-required')
  })

  test('结构化 reason 压过错误文本', () => {
    expect(classifyRunFailure({ reason: 'max-turns', error: 'rate limit exceeded' })).toBe('max-turns')
  })

  test('不认识的 reason 回落到文本判定', () => {
    expect(classifyRunFailure({ reason: 'something-new', error: '429 Too Many Requests' })).toBe(
      'provider-rate-limit',
    )
  })
})

describe('按错误文本归类', () => {
  // #103 报告者看到的就是这条：`运行失败：terminated`。undici 在流中途断开时的原样报错。
  test('terminated —— 流中途断（issue #103）', () => {
    expect(classifyRunFailure({ error: 'terminated' })).toBe('network-interrupted')
    expect(classifyRunFailure({ error: 'Agent 运行失败：terminated' })).toBe('network-interrupted')
  })

  test('其它流中断形态', () => {
    for (const text of [
      'socket hang up',
      'read ECONNRESET',
      'write EPIPE',
      'Premature close',
      'The operation was aborted',
      'other side closed',
    ]) {
      expect(classifyRunFailure({ error: text })).toBe('network-interrupted')
    }
  })

  test('连不上', () => {
    for (const text of [
      'getaddrinfo ENOTFOUND api.example.com',
      'connect ECONNREFUSED 127.0.0.1:11434',
      'self signed certificate in certificate chain',
      'TypeError: fetch failed',
    ]) {
      expect(classifyRunFailure({ error: text })).toBe('provider-unreachable')
    }
  })

  test('鉴权', () => {
    for (const text of [
      '401 Unauthorized',
      'Invalid API key provided',
      'authentication_error',
      '403 Forbidden',
    ]) {
      expect(classifyRunFailure({ error: text })).toBe('provider-auth')
    }
  })

  test('限流', () => {
    for (const text of ['429 Too Many Requests', 'Rate limit reached', 'quota exceeded']) {
      expect(classifyRunFailure({ error: text })).toBe('provider-rate-limit')
    }
  })

  test('上游故障', () => {
    for (const text of ['500 Internal Server Error', '502 Bad Gateway', 'Overloaded']) {
      expect(classifyRunFailure({ error: text })).toBe('provider-server-error')
    }
  })

  // 这一类的占比直接决定要不要做「后端类型」选择器：OpenAI 兼容渠道的字段错配就长这样。
  test('请求被拒（协议字段错配的主要形态）', () => {
    for (const text of [
      '400 Bad Request',
      'invalid_request_error: unsupported parameter',
      "Unrecognized request argument supplied: max_completion_tokens",
    ]) {
      expect(classifyRunFailure({ error: text })).toBe('provider-bad-request')
    }
  })
})

describe('易混淆的判定顺序', () => {
  // 上游常把这两类也返回成 400/404。先匹配语义，才不会被冲进笼统的状态码分类。
  test('上下文超限即使带 400 也归 context-overflow', () => {
    expect(
      classifyRunFailure({ error: '400 - This model’s maximum context length is 128000 tokens' }),
    ).toBe('context-overflow')
    expect(classifyRunFailure({ error: 'context_length_exceeded' })).toBe('context-overflow')
  })

  test('模型不存在即使带 404 也归 model-not-found', () => {
    expect(classifyRunFailure({ error: '404 model_not_found: glm-5.2[1m]' })).toBe('model-not-found')
  })

  test('限流即使同时提到 400 也归限流', () => {
    expect(classifyRunFailure({ error: 'Rate limit exceeded (400)' })).toBe('provider-rate-limit')
  })

  // 状态码用词边界匹配，否则请求 ID 里的数字会被当成状态码。
  test('数字串里的状态码不误判', () => {
    expect(classifyRunFailure({ error: 'request id 4291837465 failed' })).toBe('unknown')
    expect(classifyRunFailure({ error: 'trace 5008812 aborted mid-flight' })).toBe('network-interrupted')
  })
})

describe('兜底与红线', () => {
  test('没有任何线索时是 unknown，不硬塞', () => {
    expect(classifyRunFailure({})).toBe('unknown')
    expect(classifyRunFailure({ error: '' })).toBe('unknown')
    expect(classifyRunFailure({ error: '模型返回了空结果' })).toBe('unknown')
  })

  // 本函数是原始错误文本的终点站：返回值永远是枚举常量之一，不可能夹带正文。
  // 这条用一段"长得像小说正文的报错"来守——它必须原样蒸发掉，只剩一个枚举。
  test('返回值恒为枚举之一，错误文本一个字都不带出去', () => {
    const leaky = '林舟握紧了剑，他知道这一战避无可避。\n400 Bad Request'
    const result = classifyRunFailure({ error: leaky })
    expect(TELEMETRY_FAILURE_REASONS).toContain(result)
    expect(result).toBe('provider-bad-request')
    expect(leaky).toContain('林舟') // 原文没被改动，但也没有任何一部分进入返回值
  })

  test('任何输入的返回值都在枚举表内', () => {
    for (const text of ['', 'x', '???', '正文正文', 'ECONNRESET', '429', 'nonsense error']) {
      expect(TELEMETRY_FAILURE_REASONS).toContain(classifyRunFailure({ error: text }))
    }
  })
})

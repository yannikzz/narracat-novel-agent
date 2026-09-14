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

describe('各家上游的真实报错形态（evaluator 实测抓到的漏判）', () => {
  // Anthropic 的措辞与 OpenAI 系完全不同。这一类归错会直接污染 provider-bad-request 的占比，
  // 而那个数是用来决定要不要做「后端类型」选择器的——超长章节写到后期必然撞上限，量不小。
  test('Anthropic 的上下文超长', () => {
    expect(
      classifyRunFailure({
        error: '400 {"type":"error","error":{"message":"prompt is too long: 217527 tokens > 200000 maximum"}}',
      }),
    ).toBe('context-overflow')
    expect(classifyRunFailure({ error: 'input length and `max_tokens` exceed context limit: 200000' })).toBe(
      'context-overflow',
    )
  })

  test('国内网关的中文报错', () => {
    expect(classifyRunFailure({ error: '1214: 请求参数错误：输入长度超过模型最大上下文长度' })).toBe(
      'context-overflow',
    )
    expect(classifyRunFailure({ error: '1302 您当前使用该API的并发数过高，请降低并发' })).toBe(
      'provider-rate-limit',
    )
  })

  // 此前 404 根本没进任何 pattern（400/401/403/422/429/5xx 都有，唯独漏了它），
  // 而 OpenAI 的文案里模型名夹在 model 和 does not exist 中间，字面量也匹配不上。
  test('OpenAI 的模型不存在（纯 404 与带模型名两种）', () => {
    expect(
      classifyRunFailure({ error: '404 The model `gpt-9` does not exist or you do not have access to it.' }),
    ).toBe('model-not-found')
    expect(classifyRunFailure({ error: '404 Not Found' })).toBe('model-not-found')
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

describe('状态码只认真正的状态码', () => {
  // `\b` 在中文与连字符旁边同样成立，而本仓的错误文案本身就是中文夹数字。
  // 此前这三条分别被判成 provider-bad-request / provider-server-error / provider-bad-request。
  test('中文正文里的数字不是状态码', () => {
    expect(classifyRunFailure({ error: '写了 400 字后中断' })).toBe('unknown')
    expect(classifyRunFailure({ error: '耗时 500 ms' })).toBe('unknown')
    expect(classifyRunFailure({ error: 'trace-400-ab' })).toBe('unknown')
  })

  test('行首与状态词之后才算', () => {
    expect(classifyRunFailure({ error: '400 Bad Request' })).toBe('provider-bad-request')
    expect(classifyRunFailure({ error: 'status: 429' })).toBe('provider-rate-limit')
    expect(classifyRunFailure({ error: 'HTTP/1.1 503 Service Unavailable' })).toBe('provider-server-error')
    expect(classifyRunFailure({ error: '(401)' })).toBe('provider-auth')
  })

  test('后面还跟数字的不算状态码', () => {
    expect(classifyRunFailure({ error: '4001 某个内部错误码' })).toBe('unknown')
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

  // reason 的入参类型是宽松的 string（好让不认识的新 reason 回落到文本判定）。
  // 用对象字面量查表会走原型链：'constructor' 会取到 Function，它 String() 之后
  // 只有 38 个字符、没有换行，**两道形态闸都拦不住，会真的发到 PostHog**。
  test('原型链上的键取不出东西来', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      const result = classifyRunFailure({ reason: key })
      expect(TELEMETRY_FAILURE_REASONS).toContain(result)
      expect(typeof result).toBe('string')
    }
  })
})

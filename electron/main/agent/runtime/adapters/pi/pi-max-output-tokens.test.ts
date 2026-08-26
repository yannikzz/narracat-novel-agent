/**
 * 输出上限兑现扩展的测试。
 *
 * 这一刀的风险不在「抬不上去」，而在「抬过头」——发一个超过模型上限的 max_tokens 是硬 400，
 * 整条链当场断。所以用例的重点是**白名单外的一律不动**：跨 provider 不串、未收录不抬、
 * 字段缺席不凭空加、已经更大不往下压。
 *
 * 真实请求体已用本机假 Anthropic 端点抓过（走真实 runPiSession）：
 *   deepseek-v4-pro → max_tokens 64000；未收录的 deepseek-chat → 32000（上游默认，未被改动）。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { TARGET_MAX_OUTPUT_TOKENS } from './pi-model.ts'
import {
  createPiMaxOutputTokensPatch,
  patchMaxOutputTokens,
  resolvePiMaxOutputTokens,
} from './pi-max-output-tokens.ts'

describe('resolvePiMaxOutputTokens（白名单）', () => {
  test('收录的模型取 TARGET 与文档上限的较小值', () => {
    // DeepSeek 文档上限 384K，远高于 TARGET，故取 TARGET。
    expect(resolvePiMaxOutputTokens('deepseek', 'deepseek-v4-pro')).toBe(TARGET_MAX_OUTPUT_TOKENS)
    expect(resolvePiMaxOutputTokens('anthropic', 'claude-opus-5')).toBe(TARGET_MAX_OUTPUT_TOKENS)
  })

  test('[1m] 长上下文变体归一到基础模型——同一个模型，输出上限相同', () => {
    expect(resolvePiMaxOutputTokens('anthropic', 'claude-opus-5[1m]')).toBe(TARGET_MAX_OUTPUT_TOKENS)
  })

  test('未收录的模型一律不抬——失败方向朝「维持现状」，不是朝「赌一把」', () => {
    // 同一家的其它模型（老 deepseek-chat 输出上限低得多）绝不能被顺带抬上去。
    expect(resolvePiMaxOutputTokens('deepseek', 'deepseek-chat')).toBeUndefined()
    // 更老的 Claude 各自上限不同且普遍更低，没收进白名单。
    expect(resolvePiMaxOutputTokens('anthropic', 'claude-sonnet-4-5')).toBeUndefined()
    // 没查过第一手文档的渠道整家不收。
    expect(resolvePiMaxOutputTokens('glm', 'glm-4.6')).toBeUndefined()
    expect(resolvePiMaxOutputTokens('minimax', 'minimax-m2')).toBeUndefined()
  })

  test('键是 provider 限定的：custom 渠道挂同名模型不蹭 deepseek 的依据', () => {
    // custom 渠道的 baseUrl 指向哪儿我们不知道，同名不等于同一个后端。
    expect(resolvePiMaxOutputTokens('custom', 'deepseek-v4-pro')).toBeUndefined()
  })
})

describe('patchMaxOutputTokens（请求体改写）', () => {
  test('anthropic wire：把 max_tokens 抬到目标值，其余字段原样', () => {
    const patched = patchMaxOutputTokens({ model: 'x', max_tokens: 32000, stream: true }, 64000) as Record<
      string,
      unknown
    >
    expect(patched.max_tokens).toBe(64000)
    expect(patched.model).toBe('x')
    expect(patched.stream).toBe(true)
  })

  test('openai wire 的 max_completion_tokens 同样认', () => {
    const patched = patchMaxOutputTokens({ max_completion_tokens: 32000 }, 64000) as Record<string, unknown>
    expect(patched.max_completion_tokens).toBe(64000)
    expect(patched.max_tokens).toBeUndefined()
  })

  test('字段缺席时原样返回——凭空加字段是在猜 provider 契约', () => {
    const payload = { model: 'x' }
    expect(patchMaxOutputTokens(payload, 64000)).toBe(payload)
  })

  test('已经比目标值大就不往下压（只抬不降）', () => {
    const payload = { max_tokens: 128_000 }
    expect(patchMaxOutputTokens(payload, 64000)).toBe(payload)
  })

  test('相等时也原样返回，避免每轮都白替换一次请求体', () => {
    const payload = { max_tokens: 64000 }
    expect(patchMaxOutputTokens(payload, 64000)).toBe(payload)
  })

  test('payload 不是对象时原样返回，不抛', () => {
    expect(patchMaxOutputTokens(null, 64000)).toBeNull()
    expect(patchMaxOutputTokens('nonsense', 64000)).toBe('nonsense')
  })
})

describe('createPiMaxOutputTokensPatch（扩展装配）', () => {
  function handlerOf(maxTokens: number) {
    const handlers = createPiMaxOutputTokensPatch(maxTokens).handlers.get('before_provider_request')
    expect(handlers).toHaveLength(1)
    return handlers![0]!
  }

  test('挂在 before_provider_request 上（唯一改得到真实请求体的官方口子）', () => {
    const extension = createPiMaxOutputTokensPatch(64000)
    expect([...extension.handlers.keys()]).toEqual(['before_provider_request'])
    expect(extension.tools.size).toBe(0)
  })

  test('需要改时返回新 payload', async () => {
    const result = (await handlerOf(64000)({ type: 'before_provider_request', payload: { max_tokens: 32000 } })) as
      | Record<string, unknown>
      | undefined
    expect(result?.max_tokens).toBe(64000)
  })

  test('不需要改时返回 undefined——上游按 !== undefined 判定是否替换', async () => {
    const result = await handlerOf(64000)({ type: 'before_provider_request', payload: { max_tokens: 64000 } })
    expect(result).toBeUndefined()
  })
})

describe('装配守卫', () => {
  test('父会话与子会话两条路径都要装配——写手/审校跑在子会话里，漏一条它们照旧被封在 32000', () => {
    const assembly = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8')
    expect(assembly.match(/createPiMaxOutputTokensPatch\(/g) ?? []).toHaveLength(2)
    // 子会话可能走轻量槽的另一个模型 id，必须各自解析而不是继承父会话的值。
    expect(assembly.match(/resolvePiMaxOutputTokens\(/g) ?? []).toHaveLength(2)
  })
})

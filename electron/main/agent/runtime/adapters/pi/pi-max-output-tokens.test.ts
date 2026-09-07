/**
 * 输出上限兑现扩展的测试。
 *
 * 这一刀的风险不在「抬不上去」，而在「抬过头」——发一个超过模型上限的 max_tokens 是硬 400，
 * 整条链当场断。取值规则本身（白名单 / 用户值 / 区间）的用例住在 shared/lib/model-output-limits.test.ts；
 * 这里钉的是 pi 侧接线：池条目的用户值能被读到、字段缺席不凭空加、扩展挂对事件。
 *
 * 真实请求体已用本机假 Anthropic 端点抓过（走真实 runPiSession）：
 *   deepseek-v4-pro → max_tokens 64000；未收录的 deepseek-chat → 32000（上游默认，未被改动）。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ModelSlotView } from '@shared/lib/model-slots'
import { DEFAULT_PROVIDER_SETTINGS, type ModelPoolEntry } from '@shared/types/config'
import { TARGET_MAX_OUTPUT_TOKENS } from './pi-model.ts'
import {
  createPiMaxOutputTokensPatch,
  patchMaxOutputTokens,
  resolvePiMaxOutputTokens,
} from './pi-max-output-tokens.ts'

function view(pool: ModelPoolEntry[]): ModelSlotView {
  return {
    providers: DEFAULT_PROVIDER_SETTINGS,
    modelPool: pool,
    primaryModelKey: null,
    lightModelKey: null,
    apiKeyMetadata: {},
  }
}

describe('resolvePiMaxOutputTokens（池条目 → 实发值）', () => {
  test('无用户值：收录的模型取建议值（TARGET 与文档上限的较小值）', () => {
    const config = view([{ provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null }])
    expect(resolvePiMaxOutputTokens(config, 'deepseek', 'deepseek-v4-pro')).toBe(TARGET_MAX_OUTPUT_TOKENS)
  })

  test('用户在池条目上填的值是权威值：高于 TARGET 照发，低于上游 32000 也照发', () => {
    const config = view([
      { provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null, maxOutputTokens: 128_000 },
      { provider: 'custom', modelId: 'tiny', verification: null, maxOutputTokens: 8_192 },
    ])
    expect(resolvePiMaxOutputTokens(config, 'deepseek', 'deepseek-v4-pro')).toBe(128_000)
    expect(resolvePiMaxOutputTokens(config, 'custom', 'tiny')).toBe(8_192)
  })

  test('条目不在池里（如轻量槽别名解析出的 id）只剩文档建议值；两者都没有 → undefined', () => {
    const config = view([])
    expect(resolvePiMaxOutputTokens(config, 'glm', 'glm-5.2')).toBe(TARGET_MAX_OUTPUT_TOKENS)
    expect(resolvePiMaxOutputTokens(config, 'custom', 'whatever')).toBeUndefined()
    expect(resolvePiMaxOutputTokens(config, 'minimax', 'MiniMax-M3')).toBeUndefined()
  })

  test('池键是 provider 限定的：custom 渠道挂同名模型不蹭 deepseek 的用户值', () => {
    const config = view([{ provider: 'deepseek', modelId: 'x', verification: null, maxOutputTokens: 100_000 }])
    expect(resolvePiMaxOutputTokens(config, 'custom', 'x')).toBeUndefined()
  })
})

describe('patchMaxOutputTokens（请求体改写）', () => {
  test('anthropic wire：把 max_tokens 改成目标值，其余字段原样', () => {
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

  test('目标值比现值低也改写——用户填的值是权威值（自定义后端上限可能不到 32000）', () => {
    const patched = patchMaxOutputTokens({ max_tokens: 32000 }, 8_192) as Record<string, unknown>
    expect(patched.max_tokens).toBe(8_192)
  })

  test('相等时原样返回，避免每轮都白替换一次请求体', () => {
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
    // 子会话可能走轻量槽的另一个模型 id，必须各自解析而不是继承父会话的值；两处都要带 config 才读得到用户值。
    expect(assembly.match(/resolvePiMaxOutputTokens\(args\.config, /g) ?? []).toHaveLength(2)
  })
})

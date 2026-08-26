/**
 * Provider 装配测试（模型池化切片①）：AppConfig → Pi Model 描述的映射规则，主力/轻量槽驱动
 * （shared/lib/model-slots）。[1m] 上下文按实际选中模型 id 判，不再是「三档任一带即全局 1M」。
 */
import { describe, expect, test } from 'bun:test'
import type { AppConfig, ModelPoolEntry } from '@shared/types/config'
import { DEFAULT_PROVIDER_SETTINGS, POOL_DEFAULT_FIELDS } from '@shared/types/config'
import {
  PI_UPSTREAM_MAX_OUTPUT_CAP,
  TARGET_MAX_OUTPUT_TOKENS,
  createPiModel,
  effectivePiMaxTokens,
  resolvePiModelAlias,
} from './pi-model.ts'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...POOL_DEFAULT_FIELDS,
    apiKeyMetadata: {},
    novelRootDir: '/tmp/novels',
    recentNovelPaths: [],
    systemNotificationsEnabled: true,
    introVersion: 0,
    ...overrides,
  }
}

/** 已验证条目：verification 快照须与 apiKeyMetadata/providers[].baseUrl/wire 匹配才算 verified。 */
function verifiedEntry(provider: ModelPoolEntry['provider'], modelId: string): ModelPoolEntry {
  return {
    provider,
    modelId,
    verification: {
      verifiedAt: '2026-08-02T00:00:00.000Z',
      apiKeyUpdatedAt: '2026-08-01T00:00:00.000Z',
      baseUrl: DEFAULT_PROVIDER_SETTINGS[provider].baseUrl,
      wire: DEFAULT_PROVIDER_SETTINGS[provider].wire,
    },
  }
}

describe('createPiModel', () => {
  test('deepseek 默认配置 → anthropic-messages 自定义端点模型', () => {
    const model = createPiModel(makeConfig())
    expect(model.id).toBe('deepseek-v4-pro')
    expect(model.provider).toBe('deepseek')
    expect(model.api).toBe('anthropic-messages')
    expect(model.baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(model.contextWindow).toBe(200_000)
    // 断言**实发值**而不是 Model 上的存值。注意实发不等于 TARGET：上游把它封在 32000
    // （见 pi-model.ts 的 PI_UPSTREAM_MAX_OUTPUT_CAP，假端点抓包实测）。
    expect(effectivePiMaxTokens(model.maxTokens)).toBe(PI_UPSTREAM_MAX_OUTPUT_CAP)
    // TARGET 是我们想要的值，不是实际发出去的值——两者当前不等，别再把它当成已生效。
    expect(TARGET_MAX_OUTPUT_TOKENS).toBe(64_000)
    expect(model.maxTokens).toBe(TARGET_MAX_OUTPUT_TOKENS)
  })

  test('实发 max_tokens 被上游封在 32000——配置值不是实发值（假端点抓包实测）', () => {
    const model = createPiModel(makeConfig())
    // 复刻 pi-ai@0.73.1 dist/providers/simple-options.js:1 的算式（生产恒走 streamSimple）：
    //   maxTokens: options?.maxTokens ?? Math.min(model.maxTokens, 32000)
    // 它把 options.maxTokens 填成正数，anthropic.js:663 那条「除 3」的分支永远到不了。
    expect(effectivePiMaxTokens(model.maxTokens)).toBe(PI_UPSTREAM_MAX_OUTPUT_CAP)
    // ⚠️ 这条断言就是重点：我们配 64000，实际发出去 32000。它不是 bug 被容忍，是事实被钉住——
    // 前后两刀（#35 的 ×3 补偿、#46 的 32000→64000）都因为断言落在配置值上而误判为「已生效」。
    expect(effectivePiMaxTokens(model.maxTokens)).toBeLessThan(TARGET_MAX_OUTPUT_TOKENS)
    // 上游哪天撤掉 32000 硬顶，这条会红——那时才轮到 TARGET 真正生效。
    expect(PI_UPSTREAM_MAX_OUTPUT_CAP).toBe(32_000)
  })

  test('thinking 档位：缺省不接管（reasoning=false → 请求不带 thinking 字段，听 provider 的）', () => {
    expect(createPiModel(makeConfig()).reasoning).toBe(false)
    expect(createPiModel(makeConfig(), undefined, 'provider-default').reasoning).toBe(false)
  })

  test("thinking 档位：'off' 才置 reasoning=true——这不是「开思考」而是「由我们发 disabled」", () => {
    // 上游两个条件必须同时成立才会写出 thinking:{type:"disabled"}：
    //   ① model.reasoning 为真（否则 anthropic.js:702 整段跳过，连 disabled 都不发）
    //   ② options.thinkingEnabled === false（pi-session 恒传 thinkingLevel:'off' 已经给到）
    // 假端点抓包实测：provider-default → 请求体无 thinking 字段；off → {"type":"disabled"}。
    expect(createPiModel(makeConfig(), undefined, 'off').reasoning).toBe(true)
  })

  test('createPiModel 从主力槽解析 id/provider/baseUrl', () => {
    const config = makeConfig({
      modelPool: [{ provider: 'glm', modelId: 'glm-5.2', verification: null }],
      primaryModelKey: 'glm/glm-5.2',
      providers: { ...DEFAULT_PROVIDER_SETTINGS },
    })
    const model = createPiModel(config)
    expect(model.id).toBe('glm-5.2')
    expect(model.provider).toBe('glm')
    expect(model.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
  })

  test('explicitId 覆盖模型 id（子 agent 别名映射用），空串回落主力槽', () => {
    expect(createPiModel(makeConfig(), 'model-x').id).toBe('model-x')
    expect(createPiModel(makeConfig(), '').id).toBe('deepseek-v4-pro')
  })

  test('[1m] 判定按实际选中模型：主力不带 [1m] 就是 200k，即使池里有 [1m] 条目', () => {
    const config = makeConfig({
      modelPool: [
        { provider: 'glm', modelId: 'glm-5.2', verification: null },
        { provider: 'glm', modelId: 'glm-5.2[1m]', verification: null },
      ],
      primaryModelKey: 'glm/glm-5.2',
    })
    expect(createPiModel(config).contextWindow).toBe(200_000)
    expect(createPiModel(config, 'glm-5.2[1m]').contextWindow).toBe(1_000_000)
  })

  test('baseUrl 为空（anthropic 官方）→ 回落官方端点', () => {
    const config = makeConfig({
      modelPool: [{ provider: 'anthropic', modelId: 'claude-opus-4-7', verification: null }],
      primaryModelKey: 'anthropic/claude-opus-4-7',
    })
    expect(createPiModel(config).baseUrl).toBe('https://api.anthropic.com')
  })

  test('模型池为空（主力槽无法解析）→ 抛明确错误', () => {
    expect(() => createPiModel(makeConfig({ modelPool: [], primaryModelKey: null }))).toThrow('未配置')
  })

  test('custom 渠道 openai wire → api 推导为 openai-completions', () => {
    const config = makeConfig({
      providers: { ...DEFAULT_PROVIDER_SETTINGS, custom: { baseUrl: 'https://gw.example.com/v1', wire: 'openai' } },
      modelPool: [{ provider: 'custom', modelId: 'some-model', verification: null }],
      primaryModelKey: 'custom/some-model',
    })
    const model = createPiModel(config)
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://gw.example.com/v1')
  })

  test('openai wire 缺 baseUrl → 提前抛可操作错误（不打到 anthropic 官方端点得 404）', () => {
    const config = makeConfig({
      providers: { ...DEFAULT_PROVIDER_SETTINGS, custom: { baseUrl: '', wire: 'openai' } },
      modelPool: [{ provider: 'custom', modelId: 'some-model', verification: null }],
      primaryModelKey: 'custom/some-model',
    })
    expect(() => createPiModel(config)).toThrow('OpenAI 协议渠道需要先在设置中填写接口地址')
  })

  test('custom 渠道默认仍为 anthropic wire（anthropic-messages）', () => {
    const config = makeConfig({
      providers: { ...DEFAULT_PROVIDER_SETTINGS },
      modelPool: [{ provider: 'custom', modelId: 'some-model', verification: null }],
      primaryModelKey: 'custom/some-model',
    })
    expect(createPiModel(config).api).toBe('anthropic-messages')
  })
})

describe('resolvePiModelAlias', () => {
  test('opus/sonnet 一律继承 run 模型（undefined）', () => {
    const config = makeConfig()
    expect(resolvePiModelAlias(config, 'opus')).toBeUndefined()
    expect(resolvePiModelAlias(config, 'sonnet')).toBeUndefined()
  })

  test('非法/缺省别名一律 undefined，不做透传旁路', () => {
    const config = makeConfig()
    expect(resolvePiModelAlias(config, 'inherit')).toBeUndefined()
    expect(resolvePiModelAlias(config, 'deepseek-v4-pro')).toBeUndefined()
    expect(resolvePiModelAlias(config, undefined)).toBeUndefined()
  })

  test('haiku：同 provider 已验证轻量槽 → 返回轻量 modelId', () => {
    const config = makeConfig({
      modelPool: [
        { provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null },
        verifiedEntry('deepseek', 'deepseek-lite'),
      ],
      primaryModelKey: 'deepseek/deepseek-v4-pro',
      lightModelKey: 'deepseek/deepseek-lite',
      apiKeyMetadata: { deepseek: { updatedAt: '2026-08-01T00:00:00.000Z' } },
    })
    expect(resolvePiModelAlias(config, 'haiku')).toBe('deepseek-lite')
  })

  test('haiku：跨 provider 已验证轻量槽 → undefined（子会话共用 run 的 provider/apiKey，跨家不可用）', () => {
    const config = makeConfig({
      modelPool: [
        { provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null },
        verifiedEntry('glm', 'glm-4.5-air'),
      ],
      primaryModelKey: 'deepseek/deepseek-v4-pro',
      lightModelKey: 'glm/glm-4.5-air',
      apiKeyMetadata: {
        deepseek: { updatedAt: '2026-08-01T00:00:00.000Z' },
        glm: { updatedAt: '2026-08-01T00:00:00.000Z' },
      },
    })
    expect(resolvePiModelAlias(config, 'haiku')).toBeUndefined()
  })

  test('haiku：轻量槽未验证 → undefined（resolveLightModel 已回落主力，与主力同值时收敛为 undefined）', () => {
    const config = makeConfig({
      modelPool: [
        { provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null },
        { provider: 'deepseek', modelId: 'deepseek-lite', verification: null },
      ],
      primaryModelKey: 'deepseek/deepseek-v4-pro',
      lightModelKey: 'deepseek/deepseek-lite',
      apiKeyMetadata: { deepseek: { updatedAt: '2026-08-01T00:00:00.000Z' } },
    })
    expect(resolvePiModelAlias(config, 'haiku')).toBeUndefined()
  })
})

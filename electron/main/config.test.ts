import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { POOL_DEFAULT_FIELDS } from '@shared/types/config'
import {
  clearProviderApiKeyMetadata,
  findUnsafeApiKeyCharacter,
  hasConfiguredApiKey,
  isModelServiceVerified,
  markModelEntryVerified,
  markProviderApiKeyUpdated,
  markProviderVerified,
  normalizeAppConfig,
  sanitizeConfigForDisk,
  type AppConfig,
} from './config.ts'

// 旧盘面（三档契约）字面量：仅供测试模拟磁盘上的旧版本数据，触发 normalizeAppConfig 的
// 一次性迁移分支——不是公开契约（DEFAULT_PROVIDER_CONFIGS 已随 Task 7 退役）。
const LEGACY_DEEPSEEK = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: { opus: 'deepseek-v4-pro', sonnet: 'deepseek-v4-pro', haiku: 'deepseek-v4-pro' },
}

const legacyVerified = {
  provider: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-4.5-air' },
  apiKeyMetadata: { glm: { updatedAt: '2026-08-01T00:00:00.000Z' } },
  modelServiceVerification: {
    provider: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-4.5-air' },
    apiKeyUpdatedAt: '2026-08-01T00:00:00.000Z',
    verifiedAt: '2026-08-01T12:00:00.000Z',
  },
}

describe('app config', () => {
  test('defaults to DeepSeek V4 Pro', () => {
    const config = normalizeAppConfig(undefined, '/Users/tester')

    expect(config.primaryModelKey).toBe('deepseek/deepseek-v4-pro')
    expect(config.lightModelKey).toBeNull()
    expect(config.modelPool).toEqual([{ provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null }])
    expect(config.providers.deepseek.baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(config.novelRootDir).toBe(join('/Users/tester', 'Documents', 'NarraCat'))
    expect(config.systemNotificationsEnabled).toBe(true)
    expect(config.apiKeyMetadata).toEqual({})
    expect(config.introVersion).toBe(0)
  })

  test('normalizes introVersion: 默认 0，只接受非负整数', () => {
    expect(normalizeAppConfig({ introVersion: 2 }, '/Users/tester').introVersion).toBe(2)
    expect(normalizeAppConfig({ introVersion: -1 }, '/Users/tester').introVersion).toBe(0)
    expect(normalizeAppConfig({ introVersion: 1.5 }, '/Users/tester').introVersion).toBe(0)
    expect(normalizeAppConfig({ introVersion: '3' }, '/Users/tester').introVersion).toBe(0)
  })

  test('normalizes custom provider values', () => {
    const config = normalizeAppConfig(
      {
        provider: 'custom',
        baseUrl: ' https://gateway.example.com/anthropic ',
        models: {
          opus: 'writer-pro',
          sonnet: 'editor-pro',
          haiku: 'keeper-fast',
        },
        novelRootDir: ' /tmp/novels ',
        recentNovelPaths: ['/tmp/a', '', '/tmp/a', ' /tmp/b '],
        apiKeyMetadata: {
          deepseek: { updatedAt: '2026-06-04T01:00:00.000Z' },
          custom: { updatedAt: '2026-06-04T02:00:00.000Z' },
        },
        systemNotificationsEnabled: false,
      },
      '/Users/tester',
    )

    // 旧形态迁移：opus/sonnet 三档收敛进单一「主力」槽（sonnet 优先）；haiku 未验证时
    // resolveLightModel fail-soft 回落主力，故派生 models 三者同值——真实三档差异保留在 modelPool。
    expect(config).toMatchObject({
      primaryModelKey: 'custom/editor-pro',
      lightModelKey: 'custom/keeper-fast',
      providers: { custom: { baseUrl: 'https://gateway.example.com/anthropic' } },
      novelRootDir: '/tmp/novels',
      recentNovelPaths: ['/tmp/a', '/tmp/b'],
      apiKeyMetadata: {
        deepseek: { updatedAt: '2026-06-04T01:00:00.000Z' },
        custom: { updatedAt: '2026-06-04T02:00:00.000Z' },
      },
      systemNotificationsEnabled: false,
    } satisfies Partial<AppConfig>)
    expect(config.modelPool.map((e) => e.modelId)).toEqual(['writer-pro', 'editor-pro', 'keeper-fast'])
  })

  test('accepts new Anthropic-compatible providers and falls back to deepseek on unknown', () => {
    // 裸 provider（无 models 字段）不再具备旧形态特征，不触发迁移分支，落回新形态默认池（deepseek）——
    // 与新契约一致：切换 Provider 须通过 providers/modelPool 走完整新形态，而非只传 provider 一个字段。
    const glm = normalizeAppConfig({ provider: 'glm' }, '/Users/tester')
    expect(glm.primaryModelKey).toBe('deepseek/deepseek-v4-pro')

    // MiniMax：同理落回默认池；显式 apiKey 元数据仍原样保留（PROVIDER_IDS 驱动的遍历覆盖新 Provider）。
    const minimax = normalizeAppConfig(
      { provider: 'minimax', apiKeyMetadata: { minimax: { updatedAt: '2026-06-18T00:00:00.000Z' } } },
      '/Users/tester',
    )
    expect(minimax.primaryModelKey).toBe('deepseek/deepseek-v4-pro')
    expect(minimax.apiKeyMetadata.minimax).toEqual({ updatedAt: '2026-06-18T00:00:00.000Z' })

    // 未知 Provider（同样无 models 字段）→ 不触发迁移分支，落回默认池。
    expect(normalizeAppConfig({ provider: 'whatever' }, '/Users/tester').primaryModelKey).toBe(
      'deepseek/deepseek-v4-pro',
    )
  })

  test('persists verified model service state without storing key material', () => {
    const withKeyMetadata = markProviderApiKeyUpdated(
      normalizeAppConfig(LEGACY_DEEPSEEK, '/Users/tester'),
      'deepseek',
      '2026-06-04T01:00:00.000Z',
    )

    const verified = markModelEntryVerified(withKeyMetadata, 'deepseek/deepseek-v4-pro', '2026-06-04T01:05:00.000Z')

    expect(isModelServiceVerified(verified)).toBe(true)
    expect(verified.modelPool.find((e) => e.modelId === 'deepseek-v4-pro')?.verification).toEqual({
      verifiedAt: '2026-06-04T01:05:00.000Z',
      apiKeyUpdatedAt: '2026-06-04T01:00:00.000Z',
      baseUrl: 'https://api.deepseek.com/anthropic',
      wire: 'anthropic',
    })
    expect(JSON.stringify(verified)).not.toContain('sk-')
    expect(JSON.stringify(verified)).not.toContain('hash')
  })

  test('invalidates model service verification when provider config or key metadata changes', () => {
    const withKeyMetadata = markProviderApiKeyUpdated(
      normalizeAppConfig(LEGACY_DEEPSEEK, '/Users/tester'),
      'deepseek',
      '2026-06-04T01:00:00.000Z',
    )
    const verified = markModelEntryVerified(withKeyMetadata, 'deepseek/deepseek-v4-pro', '2026-06-04T01:05:00.000Z')

    expect(isModelServiceVerified(verified)).toBe(true)

    // 真正携带验证语义的字段是 providers（Provider 端点）与 apiKeyMetadata（Key 代际）——
    // 两者任一变化，池条目验证快照自愈清空。
    expect(
      isModelServiceVerified(
        normalizeAppConfig({
          ...verified,
          providers: {
            ...verified.providers,
            deepseek: { baseUrl: 'https://gateway.example.com/anthropic' },
          },
        }),
      ),
    ).toBe(false)

    expect(
      isModelServiceVerified(
        normalizeAppConfig({
          ...verified,
          apiKeyMetadata: {
            deepseek: { updatedAt: '2026-06-04T02:00:00.000Z' },
          },
        }),
      ),
    ).toBe(false)
  })

  test('hasConfiguredApiKey: 据 config 元数据判断是否已配置 Key（不触碰钥匙串）', () => {
    const base = normalizeAppConfig(LEGACY_DEEPSEEK, '/Users/tester')
    expect(hasConfiguredApiKey(base, 'deepseek')).toBe(false)

    const withKey = markProviderApiKeyUpdated(base, 'deepseek', '2026-06-24T00:00:00.000Z')
    expect(hasConfiguredApiKey(withKey, 'deepseek')).toBe(true)
    // 仅对应 Provider 算已配置，未配过的 Provider 仍为 false。
    expect(hasConfiguredApiKey(withKey, 'minimax')).toBe(false)

    // 删除元数据后回到未配置。
    expect(hasConfiguredApiKey(clearProviderApiKeyMetadata(withKey, 'deepseek'), 'deepseek')).toBe(false)
  })

  test('findUnsafeApiKeyCharacter: 揪出会让 HTTP header 崩溃的非法字符', () => {
    // 正常密钥（纯英文数字与符号）安全；base64 风格的 + / = 也放行，避免误伤自定义 Provider 的密钥。
    expect(findUnsafeApiKeyCharacter('sk-1234567890abcdef')).toBeNull()
    expect(findUnsafeApiKeyCharacter('sk-ab+c/d=ef.gh')).toBeNull()
    expect(findUnsafeApiKeyCharacter('')).toBeNull()

    // 混入中文（如粘贴出错）——返回第一个越界字符的位置与码点；
    // 这正是用户那把 `sk美…` 的形态：第 3 个字符是「美」(U+7F8E = 32654)。
    expect(findUnsafeApiKeyCharacter('sk美key')).toEqual({ index: 2, codePoint: 32654 })

    // 全角符号 / 多余中文字也算非法。
    expect(findUnsafeApiKeyCharacter('ＡＢＣ')?.index).toBe(0)
    expect(findUnsafeApiKeyCharacter('sk-abc 的')?.codePoint).toBe('的'.charCodeAt(0))

    // 控制字符（换行/回车/制表/NUL）虽码点 ≤126，但同样会让请求头崩（undici "invalid header value"），
    // 必须一并拦下——这是 PR review 抓到的缺口。
    expect(findUnsafeApiKeyCharacter('sk\nkey')).toEqual({ index: 2, codePoint: 10 })
    expect(findUnsafeApiKeyCharacter('sk\rkey')).toEqual({ index: 2, codePoint: 13 })
    expect(findUnsafeApiKeyCharacter('sk\tkey')?.codePoint).toBe(9)
    expect(findUnsafeApiKeyCharacter('a\x00b')?.index).toBe(1)
  })

  test('sanitizes secrets before writing config to disk', () => {
    const config = sanitizeConfigForDisk({
      ...POOL_DEFAULT_FIELDS,
      apiKey: 'sk-secret',
      modelServiceVerification: {
        apiKeyHash: 'derived-secret',
      },
      nested: { token: 'secret' },
    })

    expect(JSON.stringify(config)).not.toContain('sk-secret')
    expect(JSON.stringify(config)).not.toContain('token')
    expect(JSON.stringify(config)).not.toContain('derived-secret')
  })

  test('modelPool 归一化：同 key 两条只留第一条', () => {
    const config = normalizeAppConfig(
      {
        apiKeyMetadata: { deepseek: { updatedAt: 'k' } },
        modelPool: [
          { provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null },
          {
            provider: 'deepseek',
            modelId: 'deepseek-v4-pro',
            verification: {
              verifiedAt: '2026-08-01T00:00:00.000Z',
              apiKeyUpdatedAt: 'k',
              baseUrl: 'https://api.deepseek.com/anthropic',
            },
          },
        ],
      },
      '/Users/tester',
    )

    // 只留第一条——若误留第二条，其 verification 快照与当前 apiKeyMetadata 匹配会通过自愈校验非 null，
    // 用这点区分「去重后剩哪条」而不只是数量。
    expect(config.modelPool).toEqual([{ provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null }])
  })

  test('modelPool 归一化：丢弃未知 provider / 空 modelId 的脏条目', () => {
    const config = normalizeAppConfig(
      {
        modelPool: [
          { provider: 'not-a-real-provider', modelId: 'x', verification: null },
          { provider: 'glm', modelId: '', verification: null },
          { provider: 'glm', modelId: '   ', verification: null },
          { provider: 'glm', modelId: 'glm-4.5-air', verification: null },
        ],
      },
      '/Users/tester',
    )

    expect(config.modelPool).toEqual([{ provider: 'glm', modelId: 'glm-4.5-air', verification: null }])
  })

  test('modelPool 归一化：maxOutputTokens 合法则保留，越界/非整数/缺省一律不带字段（回到跟随建议值）', () => {
    const config = normalizeAppConfig({
      ...POOL_DEFAULT_FIELDS,
      modelPool: [
        { provider: 'deepseek', modelId: 'keep', verification: null, maxOutputTokens: 128000 },
        { provider: 'deepseek', modelId: 'string-form', verification: null, maxOutputTokens: '96000' },
        { provider: 'deepseek', modelId: 'too-small', verification: null, maxOutputTokens: 10 },
        { provider: 'deepseek', modelId: 'fraction', verification: null, maxOutputTokens: 64000.5 },
        { provider: 'deepseek', modelId: 'absent', verification: null },
      ],
    })
    expect(config.modelPool).toEqual([
      { provider: 'deepseek', modelId: 'keep', verification: null, maxOutputTokens: 128000 },
      { provider: 'deepseek', modelId: 'string-form', verification: null, maxOutputTokens: 96000 },
      { provider: 'deepseek', modelId: 'too-small', verification: null },
      { provider: 'deepseek', modelId: 'fraction', verification: null },
      { provider: 'deepseek', modelId: 'absent', verification: null },
    ])
  })

  test('modelPool 归一化：验证快照的 Key 代际与当前 apiKeyMetadata 不符 → 自愈清空 verification', () => {
    const config = normalizeAppConfig(
      {
        apiKeyMetadata: { deepseek: { updatedAt: '2026-08-02T00:00:00.000Z' } },
        modelPool: [
          {
            provider: 'deepseek',
            modelId: 'deepseek-v4-pro',
            verification: {
              verifiedAt: '2026-08-01T00:00:00.000Z',
              // 陈旧代际：与当前 apiKeyMetadata.deepseek.updatedAt 不一致
              apiKeyUpdatedAt: '2026-08-01T00:00:00.000Z',
              baseUrl: 'https://api.deepseek.com/anthropic',
            },
          },
        ],
      },
      '/Users/tester',
    )

    expect(config.modelPool[0]?.verification).toBeNull()
  })
})

describe('模型池迁移', () => {
  test('旧形态迁移：三档去重进池、sonnet→主力、haiku→轻量、旧验证过渡到所有条目', () => {
    const config = normalizeAppConfig(legacyVerified, '/Users/tester')
    expect(config.modelPool.map((e) => `${e.provider}/${e.modelId}`)).toEqual([
      'glm/glm-5.2',
      'glm/glm-4.5-air',
    ])
    expect(config.primaryModelKey).toBe('glm/glm-5.2')
    expect(config.lightModelKey).toBe('glm/glm-4.5-air')
    expect(config.providers.glm.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(config.modelPool.every((e) => e.verification?.verifiedAt === '2026-08-01T12:00:00.000Z')).toBe(true)
    expect(isModelServiceVerified(config)).toBe(true)
  })

  test('旧形态三档同值：池仅一条，轻量槽为 null（跟随主力）', () => {
    const config = normalizeAppConfig(
      { ...legacyVerified, models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2' }, modelServiceVerification: null },
      '/Users/tester',
    )
    expect(config.modelPool).toHaveLength(1)
    expect(config.lightModelKey).toBeNull()
  })

  test('旧形态未验证/验证快照失配：迁移后条目全部未验证', () => {
    const config = normalizeAppConfig({ ...legacyVerified, modelServiceVerification: null }, '/Users/tester')
    expect(config.modelPool.every((e) => e.verification === null)).toBe(true)
    expect(isModelServiceVerified(config)).toBe(false)
  })

  test('迁移幂等：迁移产物再 normalize 一次深等于自身', () => {
    const once = normalizeAppConfig(legacyVerified, '/Users/tester')
    expect(normalizeAppConfig(once, '/Users/tester')).toEqual(once)
  })

  test('空输入落默认池：deepseek 单条、主力指向它、未验证', () => {
    const config = normalizeAppConfig(undefined, '/Users/tester')
    expect(config.primaryModelKey).toBe('deepseek/deepseek-v4-pro')
    expect(isModelServiceVerified(config)).toBe(false)
  })
})

describe('markModelEntryVerified', () => {
  test('写入条目验证快照，isModelServiceVerified 随主力槽翻绿', () => {
    const base = normalizeAppConfig(
      { ...legacyVerified, modelServiceVerification: null },
      '/Users/tester',
    )
    const marked = markModelEntryVerified(base, 'glm/glm-5.2', '2026-08-02T08:00:00.000Z')
    expect(isModelServiceVerified(marked)).toBe(true)
    expect(marked.modelPool.find((e) => e.modelId === 'glm-4.5-air')?.verification).toBeNull()
  })

  test('Key 未配置（无 apiKeyMetadata）时拒绝标记', () => {
    const base = normalizeAppConfig({ ...legacyVerified, apiKeyMetadata: {}, modelServiceVerification: null }, '/Users/tester')
    const marked = markModelEntryVerified(base, 'glm/glm-5.2', '2026-08-02T08:00:00.000Z')
    expect(isModelServiceVerified(marked)).toBe(false)
  })
})

describe('markProviderVerified', () => {
  test('该渠道全部条目盖章，其他渠道不动', () => {
    const base = normalizeAppConfig(
      {
        apiKeyMetadata: { glm: { updatedAt: '2026-08-01T00:00:00.000Z' } },
        modelPool: [
          { provider: 'glm', modelId: 'glm-5.2', verification: null },
          { provider: 'glm', modelId: 'glm-4.5-air', verification: null },
          { provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null },
        ],
      },
      '/Users/tester',
    )

    const marked = markProviderVerified(base, 'glm', '2026-08-03T08:00:00.000Z')

    const glmEntries = marked.modelPool.filter((entry) => entry.provider === 'glm')
    expect(glmEntries).toHaveLength(2)
    for (const entry of glmEntries) {
      expect(entry.verification).toEqual({
        verifiedAt: '2026-08-03T08:00:00.000Z',
        apiKeyUpdatedAt: '2026-08-01T00:00:00.000Z',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        wire: 'anthropic',
      })
    }

    const deepseekEntry = marked.modelPool.find((entry) => entry.provider === 'deepseek')
    expect(deepseekEntry?.verification).toBeNull()
  })

  test('Key 未配置原样返回（全部保持未验证）', () => {
    const base = normalizeAppConfig(
      {
        apiKeyMetadata: {},
        modelPool: [
          { provider: 'glm', modelId: 'glm-5.2', verification: null },
          { provider: 'glm', modelId: 'glm-4.5-air', verification: null },
        ],
      },
      '/Users/tester',
    )

    const marked = markProviderVerified(base, 'glm', '2026-08-03T08:00:00.000Z')

    expect(marked.modelPool.every((entry) => entry.verification === null)).toBe(true)
  })
})

describe('wire 归一化', () => {
  test('openai 仅 custom 渠道保留；其余渠道（含手改配置文件）强制回落 anthropic', () => {
    const config = normalizeAppConfig(
      {
        providers: {
          deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', wire: 'openai' },
          glm: { baseUrl: 'https://open.bigmodel.cn/api/anthropic', wire: 'openai' },
          custom: { baseUrl: 'https://gw.example.com/v1', wire: 'openai' },
        },
      },
      '/Users/tester',
    )

    expect(config.providers.deepseek.wire).toBe('anthropic')
    expect(config.providers.glm.wire).toBe('anthropic')
    expect(config.providers.custom.wire).toBe('openai')
  })

  test('非法/缺失 wire 值一律回落 anthropic（旧配置零破坏升级）', () => {
    const config = normalizeAppConfig(
      {
        providers: {
          custom: { baseUrl: 'https://gw.example.com/anthropic' },
          deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', wire: 'grpc' },
        },
      },
      '/Users/tester',
    )

    expect(config.providers.custom.wire).toBe('anthropic')
    expect(config.providers.deepseek.wire).toBe('anthropic')
  })

  test('切 wire（anthropic → openai）→ 该渠道验证快照自愈清空，需重新验证', () => {
    const withKey = markProviderApiKeyUpdated(
      normalizeAppConfig(LEGACY_DEEPSEEK, '/Users/tester'),
      'deepseek',
      '2026-06-04T01:00:00.000Z',
    )
    const verified = markModelEntryVerified(withKey, 'deepseek/deepseek-v4-pro', '2026-06-04T01:05:00.000Z')
    expect(isModelServiceVerified(verified)).toBe(true)

    // custom 渠道同理更有意义，但 deepseek 已被 normalizeWire 强制 anthropic——用 custom 验证同语义：
    const customVerified = normalizeAppConfig(
      {
        apiKeyMetadata: { custom: { updatedAt: '2026-08-01T00:00:00.000Z' } },
        providers: { custom: { baseUrl: 'https://gw.example.com/v1', wire: 'openai' } },
        modelPool: [
          {
            provider: 'custom',
            modelId: 'some-model',
            verification: {
              verifiedAt: '2026-08-02T00:00:00.000Z',
              apiKeyUpdatedAt: '2026-08-01T00:00:00.000Z',
              baseUrl: 'https://gw.example.com/v1',
              wire: 'anthropic',
            },
          },
        ],
      },
      '/Users/tester',
    )

    // 快照 wire=anthropic 与当前 openai 不符 → 清空。
    expect(customVerified.modelPool[0]?.verification).toBeNull()
  })

  test('旧验证快照无 wire 字段按 anthropic 读取：渠道仍是 anthropic 则保持有效', () => {
    const config = normalizeAppConfig(
      {
        apiKeyMetadata: { deepseek: { updatedAt: '2026-08-01T00:00:00.000Z' } },
        modelPool: [
          {
            provider: 'deepseek',
            modelId: 'deepseek-v4-pro',
            verification: {
              verifiedAt: '2026-08-02T00:00:00.000Z',
              apiKeyUpdatedAt: '2026-08-01T00:00:00.000Z',
              baseUrl: 'https://api.deepseek.com/anthropic',
            },
          },
        ],
      },
      '/Users/tester',
    )

    expect(config.modelPool[0]?.verification).toEqual({
      verifiedAt: '2026-08-02T00:00:00.000Z',
      apiKeyUpdatedAt: '2026-08-01T00:00:00.000Z',
      baseUrl: 'https://api.deepseek.com/anthropic',
      wire: 'anthropic',
    })
  })
})

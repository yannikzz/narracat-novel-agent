// 渠道元数据 + 状态派生纯函数测试（设置页渠道两级 UI v2 T3）。
import { describe, expect, test } from 'bun:test'
import { DEFAULT_PROVIDER_SETTINGS, PROVIDER_IDS } from '@shared/types/config'
import type { ModelSlotView } from '@shared/lib/model-slots'
import {
  canListModels,
  MODEL_CATALOG,
  MODEL_PROVIDERS,
  parseModelProviderParam,
  providerStatus,
  providerStatusLabel,
} from './model-providers'

function baseView(overrides: Partial<ModelSlotView> = {}): ModelSlotView {
  return {
    providers: DEFAULT_PROVIDER_SETTINGS,
    modelPool: [],
    primaryModelKey: null,
    lightModelKey: null,
    apiKeyMetadata: {},
    ...overrides,
  }
}

describe('MODEL_PROVIDERS（渠道元数据）', () => {
  test('label 是纯厂商名——deepseek 不再带遗留版本后缀「V4 Pro」', () => {
    const labels = Object.fromEntries(MODEL_PROVIDERS.map((item) => [item.id, item.label]))
    expect(labels.deepseek).toBe('DeepSeek')
    expect(labels.glm).toBe('智谱 GLM')
    expect(labels.minimax).toBe('MiniMax')
    expect(labels.kimi).toBe('Kimi')
    expect(labels.anthropic).toBe('Anthropic')
    expect(labels.custom).toBe('自定义')
  })

  // 两条断言各管一件事，别合并：顺序是 UI 契约（列表怎么排给用户看），
  // 完整性是「加渠道时不会漏配元数据」。只留集合比较会让顺序随便漂。
  test('渠道顺序固定：国产四家在前，Anthropic 次之，自定义末位', () => {
    expect(MODEL_PROVIDERS.map((item) => item.id)).toEqual([
      'deepseek',
      'glm',
      'minimax',
      'kimi',
      'anthropic',
      'custom',
    ])
  })

  test('PROVIDER_IDS 里每个渠道都有一行元数据', () => {
    expect([...MODEL_PROVIDERS.map((item) => item.id)].sort()).toEqual([...PROVIDER_IDS].sort())
  })
})

describe('MODEL_CATALOG（内置推荐目录）', () => {
  test('每个渠道都有键；custom 空数组兜底手填', () => {
    expect(Object.keys(MODEL_CATALOG).sort()).toEqual([...PROVIDER_IDS].sort())
    expect(MODEL_CATALOG.custom).toEqual([])
    expect(MODEL_CATALOG.deepseek.length).toBeGreaterThan(0)
  })
})

describe('canListModels（该渠道有没有模型清单端点）', () => {
  test('Kimi 拉不到清单——它的清单接口只在 OpenAI 侧，anthropic wire 上是 404', () => {
    expect(canListModels('kimi')).toBe(false)
  })

  test('其余渠道默认可拉（不显式标记就是能拉）', () => {
    for (const provider of PROVIDER_IDS.filter((id) => id !== 'kimi')) {
      expect(canListModels(provider)).toBe(true)
    }
  })
})

describe('providerStatus（四态判据）', () => {
  test('无 Key 且无条目 → unconfigured', () => {
    expect(providerStatus(baseView(), 'deepseek')).toEqual({ kind: 'unconfigured' })
  })

  test('有 Key 无条目 → no-models', () => {
    const view = baseView({ apiKeyMetadata: { deepseek: { updatedAt: '2026-08-01T09:00:00.000Z' } } })
    expect(providerStatus(view, 'deepseek')).toEqual({ kind: 'no-models' })
  })

  test('有条目·全部 isEntryVerified → enabled verified=true', () => {
    const view = baseView({
      apiKeyMetadata: { deepseek: { updatedAt: '2026-08-01T09:00:00.000Z' } },
      modelPool: [
        {
          provider: 'deepseek',
          modelId: 'deepseek-v4-pro',
          verification: {
            verifiedAt: '2026-08-01T10:00:00.000Z',
            apiKeyUpdatedAt: '2026-08-01T09:00:00.000Z',
            baseUrl: DEFAULT_PROVIDER_SETTINGS.deepseek.baseUrl,
            wire: 'anthropic',
          },
        },
      ],
    })
    expect(providerStatus(view, 'deepseek')).toEqual({ kind: 'enabled', count: 1, verified: true })
  })

  test('有条目·任一未验证（含 Key 轮换后自动失效）→ enabled verified=false', () => {
    const view = baseView({
      apiKeyMetadata: { deepseek: { updatedAt: '2026-08-01T09:00:00.000Z' } },
      modelPool: [
        {
          provider: 'deepseek',
          modelId: 'deepseek-v4-pro',
          verification: {
            verifiedAt: '2026-08-01T10:00:00.000Z',
            apiKeyUpdatedAt: '2026-08-01T09:00:00.000Z',
            baseUrl: DEFAULT_PROVIDER_SETTINGS.deepseek.baseUrl,
            wire: 'anthropic',
          },
        },
        { provider: 'deepseek', modelId: 'deepseek-v4-lite', verification: null },
      ],
    })
    expect(providerStatus(view, 'deepseek')).toEqual({ kind: 'enabled', count: 2, verified: false })
  })

  test('其它渠道的条目不计入本渠道统计', () => {
    const view = baseView({
      apiKeyMetadata: { deepseek: { updatedAt: '2026-08-01T09:00:00.000Z' } },
      modelPool: [{ provider: 'glm', modelId: 'glm-4.5-air', verification: null }],
    })
    expect(providerStatus(view, 'deepseek')).toEqual({ kind: 'no-models' })
    expect(providerStatus(view, 'glm')).toEqual({ kind: 'enabled', count: 1, verified: false })
  })
})

describe('providerStatusLabel（状态文案）', () => {
  test('unconfigured → 未配置', () => {
    expect(providerStatusLabel({ kind: 'unconfigured' })).toBe('未配置')
  })

  test('no-models → 未启用模型', () => {
    expect(providerStatusLabel({ kind: 'no-models' })).toBe('未启用模型')
  })

  test('enabled verified=true → N 个模型已启用 · 已连接', () => {
    expect(providerStatusLabel({ kind: 'enabled', count: 2, verified: true })).toBe('2 个模型已启用 · 已连接')
  })

  test('enabled verified=false → N 个模型已启用 · 未测试', () => {
    expect(providerStatusLabel({ kind: 'enabled', count: 1, verified: false })).toBe('1 个模型已启用 · 未测试')
  })
})

describe('parseModelProviderParam', () => {
  test('合法 ProviderId → 原样返回', () => {
    expect(parseModelProviderParam('glm')).toBe('glm')
    expect(parseModelProviderParam('custom')).toBe('custom')
  })

  test('null / 空串 / 非法值 → null', () => {
    expect(parseModelProviderParam(null)).toBeNull()
    expect(parseModelProviderParam('')).toBeNull()
    expect(parseModelProviderParam('bogus')).toBeNull()
  })
})

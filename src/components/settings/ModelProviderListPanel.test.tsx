// 渠道一级列表面板测试（设置页渠道两级 UI v2 T3）。
//
// 本文件全部走 SSR（renderToStaticMarkup）：覆盖各渠道行渲染、状态副标题文案、槽位摘要行。
// 行点击本身（onOpenProvider 实际收到的 provider 参数是否对得上）不在覆盖范围——SSR 静态 HTML
// 不含事件绑定，接线正确性靠 code review 走查（同 ModelProviderDetailPanel.test.tsx 头注的既有取舍）。
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_PROVIDER_SETTINGS, PROVIDER_IDS } from '@shared/types/config'
import type { AppConfig } from '@shared/types/ipc'
import { ModelProviderListPanel } from './ModelProviderListPanel'

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    providers: DEFAULT_PROVIDER_SETTINGS,
    modelPool: [],
    primaryModelKey: null,
    lightModelKey: null,
    apiKeyMetadata: {},
    novelRootDir: '/novels',
    recentNovelPaths: [],
    systemNotificationsEnabled: true,
    introVersion: 0,
    ...overrides,
  }
}

function render(config: AppConfig): string {
  return renderToStaticMarkup(<ModelProviderListPanel config={config} onOpenProvider={() => {}} />)
}

function rowHtml(html: string, provider: string): string {
  return html.match(new RegExp(`<button[^>]*data-model-provider-row="${provider}"[\\s\\S]*?</button>`))?.[0] ?? ''
}

describe('ModelProviderListPanel（SSR 结构断言）', () => {
  test('每个渠道都渲染出一行', () => {
    const html = render(baseConfig())
    for (const id of PROVIDER_IDS) {
      expect(html).toContain(`data-model-provider-row="${id}"`)
    }
    expect(html).toContain('data-model-service-layout="providers"')
  })

  test('无 Key 无条目 → 未配置', () => {
    const html = render(baseConfig())
    const row = rowHtml(html, 'deepseek')
    expect(row).toContain('data-model-provider-status="unconfigured"')
    expect(row).toContain('未配置')
  })

  test('有 Key 无条目 → 未启用模型', () => {
    const html = render(baseConfig({ apiKeyMetadata: { deepseek: { updatedAt: '2026-08-01T09:00:00.000Z' } } }))
    const row = rowHtml(html, 'deepseek')
    expect(row).toContain('data-model-provider-status="no-models"')
    expect(row).toContain('未启用模型')
  })

  test('有条目全验证 → N 个模型已启用 · 已连接', () => {
    const html = render(
      baseConfig({
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
        primaryModelKey: 'deepseek/deepseek-v4-pro',
      }),
    )
    const row = rowHtml(html, 'deepseek')
    expect(row).toContain('data-model-provider-status="enabled"')
    expect(row).toContain('1 个模型已启用 · 已连接')
  })

  test('有条目未验证 → N 个模型已启用 · 未测试', () => {
    const html = render(
      baseConfig({
        modelPool: [{ provider: 'glm', modelId: 'glm-4.5-air', verification: null }],
      }),
    )
    const row = rowHtml(html, 'glm')
    expect(row).toContain('data-model-provider-status="enabled"')
    expect(row).toContain('1 个模型已启用 · 未测试')
  })

  test('槽位摘要：主力显示 modelId，lightModelKey=null 时轻量显示「跟随主力」', () => {
    const html = render(
      baseConfig({
        modelPool: [{ provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null }],
        primaryModelKey: 'deepseek/deepseek-v4-pro',
        lightModelKey: null,
      }),
    )
    expect(html).toContain('data-model-slots-summary="true"')
    expect(html).toContain('主力：deepseek-v4-pro')
    expect(html).toContain('轻量：跟随主力')
  })

  test('槽位摘要：空池时主力显示「未设置」', () => {
    const html = render(baseConfig())
    expect(html).toContain('主力：未设置')
  })

  test('槽位摘要：轻量槽指定具体条目时显示其 modelId', () => {
    const html = render(
      baseConfig({
        modelPool: [
          { provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null },
          { provider: 'glm', modelId: 'glm-4.5-air', verification: null },
        ],
        primaryModelKey: 'deepseek/deepseek-v4-pro',
        lightModelKey: 'glm/glm-4.5-air',
      }),
    )
    expect(html).toContain('轻量：glm-4.5-air')
  })
})

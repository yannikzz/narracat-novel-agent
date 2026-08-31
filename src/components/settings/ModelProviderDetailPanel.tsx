import { CheckCircle2, Loader2, RefreshCw, Trash2, Wifi } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsRow } from '@/components/settings/SettingsLayout'
import { GROUP_CLASS, MUTED_PILL_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'
import { isEntryVerified, modelEntryKey } from '@shared/lib/model-slots'
import type { WireId } from '@shared/types/config'
import type { AppConfig, ConnectionTestResult, ModelPoolEntry, ProviderId } from '@shared/types/ipc'
import { canListModels, MODEL_CATALOG, MODEL_PROVIDERS } from './model-providers'

/**
 * 渠道详情二级页（渠道两级 UI v2 T4）：四分组——Key 与连接 / 接口协议与地址 / 模型列表 / 添加自定义模型。
 * 池 / 槽位 / wire 改动一律走 settings.tsx 的 commitConfig 即时落盘；端点草稿只在 onTestConnection 的
 * saveConfig 落盘（唯一入口，语义见 src/lib/settings-config.ts 头注）。
 */
export function ModelProviderDetailPanel({
  provider,
  config,
  busy,
  savingKey,
  apiKeyInput,
  testing,
  testResult,
  fetchedModels,
  fetchingModels,
  fetchError,
  onApiKeyChange,
  onSaveApiKey,
  onDeleteApiKey,
  onBaseUrlChange,
  onWireChange,
  onTestConnection,
  onRefreshModels,
  onToggleModel,
  onAddCustomModel,
  onSetPrimary,
  onSetLight,
}: {
  provider: ProviderId
  config: AppConfig
  busy: boolean
  savingKey: boolean
  apiKeyInput: string
  testing: boolean
  testResult: ConnectionTestResult | null
  fetchedModels: string[] | null
  fetchingModels: boolean
  fetchError: string | null
  onApiKeyChange: (value: string) => void
  onSaveApiKey: () => void | Promise<void>
  onDeleteApiKey: () => void | Promise<void>
  onBaseUrlChange: (value: string) => void
  /** 切换接口协议（仅 custom 渠道渲染选择器；端点草稿随 baseUrl 语义，测试连接时一并落盘）。 */
  onWireChange: (wire: WireId) => void
  onTestConnection: () => void | Promise<void>
  onRefreshModels: () => void | Promise<void>
  onToggleModel: (modelId: string, enabled: boolean) => void
  onAddCustomModel: (modelId: string) => void
  onSetPrimary: (key: string) => void
  onSetLight: (key: string | null) => void
}) {
  const [addModelId, setAddModelId] = useState('')

  const providerMeta = MODEL_PROVIDERS.find((item) => item.id === provider) ?? MODEL_PROVIDERS[0]
  const hasSavedKey = Boolean(config.apiKeyMetadata[provider]?.updatedAt)
  const endpointLocked = provider === 'anthropic'
  const poolEntries = config.modelPool.filter((entry) => entry.provider === provider)
  const poolEmpty = poolEntries.length === 0
  const channelVerified = poolEntries.length > 0 && poolEntries.every((entry) => isEntryVerified(config, entry))

  const noKey = !hasSavedKey && apiKeyInput.trim().length === 0
  const testDisabled = busy || noKey || poolEmpty
  const testTitle = noKey ? '请先保存 Key' : poolEmpty ? '请先启用至少一个模型再测试' : undefined

  const rows = buildModelRows(MODEL_CATALOG[provider], fetchedModels, poolEntries)

  const trimmedAddModelId = addModelId.trim()
  const addDuplicate = trimmedAddModelId.length > 0 && poolEntries.some((entry) => entry.modelId === trimmedAddModelId)
  const addDisabled = trimmedAddModelId.length === 0 || addDuplicate

  function handleAdd() {
    if (addDisabled) return
    onAddCustomModel(trimmedAddModelId)
    setAddModelId('')
  }

  return (
    <section aria-label={`${providerMeta.label} 渠道详情`} data-model-provider-detail={provider} className="space-y-4">
      <section className={GROUP_CLASS}>
        <SettingsRow
          align="start"
          title="API Key"
          description={hasSavedKey ? '输入新 Key 会在保存时覆盖当前值' : '仅保存到系统凭据库'}
        >
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Input
                data-model-api-key-input="true"
                type="password"
                value={apiKeyInput}
                disabled={busy}
                placeholder={hasSavedKey ? '输入新 API Key' : '输入 API Key'}
                className="h-8 text-xs"
                onChange={(event) => onApiKeyChange(event.target.value)}
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || apiKeyInput.trim().length === 0}
                onClick={() => void onSaveApiKey()}
              >
                {savingKey ? <Loader2 className="size-3.5 animate-spin" /> : null}
                保存 Key
              </Button>
              {hasSavedKey ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="删除 API Key"
                  disabled={busy}
                  onClick={() => void onDeleteApiKey()}
                >
                  {savingKey ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                </Button>
              ) : null}
            </div>
            {hasSavedKey ? (
              <div className="flex items-center gap-1.5 text-xs leading-none text-success">
                <CheckCircle2 className="size-3.5 shrink-0" />
                <span>已保存当前服务商的 Key</span>
              </div>
            ) : null}
          </div>
        </SettingsRow>
      </section>

      <section className={GROUP_CLASS}>
        {provider === 'custom' ? (
          <SettingsRow title="接口协议" description="切换后需重新「测试连接」；旧验证与旧对话会自动失效">
            <div className="flex items-center gap-1.5" data-model-wire-selector="true">
              <Button
                type="button"
                size="xs"
                variant={config.providers[provider].wire === 'anthropic' ? 'secondary' : 'ghost'}
                disabled={busy}
                aria-pressed={config.providers[provider].wire === 'anthropic'}
                data-model-wire-option="anthropic"
                onClick={() => onWireChange('anthropic')}
              >
                Anthropic 兼容
              </Button>
              <Button
                type="button"
                size="xs"
                variant={config.providers[provider].wire === 'openai' ? 'secondary' : 'ghost'}
                disabled={busy}
                aria-pressed={config.providers[provider].wire === 'openai'}
                data-model-wire-option="openai"
                onClick={() => onWireChange('openai')}
              >
                OpenAI 兼容
              </Button>
            </div>
          </SettingsRow>
        ) : null}
        {provider === 'custom' && config.providers[provider].wire === 'openai' ? (
          <SettingsRow align="start" title="OpenAI 协议须知" description="前缀缓存费用与功能覆盖范围">
            {/* 文案为维护者定稿（#5 前提 1 + PR #13 review 功能缺口告知），改动需先与维护者对齐 */}
            <div className="grid gap-1.5" data-model-wire-cache-hint="true">
              <p className="text-xs leading-relaxed text-muted-foreground">
                OpenAI 兼容协议不支持 Anthropic 式的前缀缓存。超长篇写作每一轮都要带很大的上下文包，缓存是成本命门——同样的内容，无缓存时的花费可能是有缓存时的数倍，请按无缓存预估你的开销。
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                另外，此协议目前只覆盖写作主链。角色聊天、能力包编译等功能仍走 Anthropic 协议，选择此项后将无法使用。
              </p>
            </div>
          </SettingsRow>
        ) : null}
        <SettingsRow
          title="接口地址"
          description={
            endpointLocked
              ? 'Anthropic 直连不需要填写'
              : config.providers[provider].wire === 'openai'
                ? 'OpenAI 兼容端点（/chat/completions），以 /v1 结尾'
                : '兼容 Anthropic 协议的服务地址'
          }
        >
          <Input
            value={config.providers[provider].baseUrl}
            disabled={endpointLocked || busy}
            placeholder={
              endpointLocked
                ? 'Anthropic 官方端点'
                : config.providers[provider].wire === 'openai'
                  ? 'https://api.example.com/v1'
                  : 'https://api.example.com/anthropic'
            }
            className="h-8 font-mono text-xs"
            onChange={(event) => onBaseUrlChange(event.target.value)}
          />
        </SettingsRow>
      </section>

      <section className={GROUP_CLASS} data-model-catalog="true">
        <div className="flex items-center justify-between gap-3 px-3 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight text-foreground">
              {poolEntries.length} / {rows.length} 个模型已启用
            </div>
            {fetchError ? <p className="mt-1 text-xs text-muted-foreground">{fetchError}</p> : null}
          </div>
          {canListModels(provider) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-model-refresh="true"
              disabled={busy || fetchingModels}
              onClick={() => void onRefreshModels()}
            >
              <RefreshCw className={cn('size-3.5', fetchingModels && 'animate-spin')} />
              刷新清单
            </Button>
          ) : null}
        </div>

        {rows.map((modelId) => (
          <ModelRow
            key={modelId}
            config={config}
            provider={provider}
            modelId={modelId}
            busy={busy}
            poolEntries={poolEntries}
            onToggleModel={onToggleModel}
            onSetPrimary={onSetPrimary}
            onSetLight={onSetLight}
          />
        ))}
      </section>

      <section className={GROUP_CLASS}>
        <SettingsRow title="添加自定义模型" description="填入官方目录还没有的最新款 model id，添加即启用">
          <div className="flex items-center gap-2">
            <Input
              value={addModelId}
              disabled={busy}
              placeholder="输入自定义模型 ID"
              className="h-8 font-mono text-xs"
              onChange={(event) => setAddModelId(event.target.value)}
            />
            <Button type="button" size="sm" disabled={busy || addDisabled} onClick={handleAdd}>
              添加
            </Button>
          </div>
        </SettingsRow>
      </section>

      {/* 「测试连接」恒为最后一个分组：它要用到上面全部配置（Key、端点、已启用模型），
          排在中间会让用户在还没选模型时就去点它。分组顺序即配置顺序。 */}
      <section className={GROUP_CLASS} data-model-connection="true">
        <SettingsRow align="start" title="连接" description="用当前 Key 与已启用模型发一次真实测试请求">
          <div className="grid gap-2">
            <Button
              type="button"
              size="sm"
              aria-label="测试连接"
              disabled={testDisabled}
              title={testTitle}
              onClick={() => void onTestConnection()}
            >
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Wifi className="size-3.5" />}
              测试连接
            </Button>
            <TestResultLine testResult={testResult} channelVerified={channelVerified} />
          </div>
        </SettingsRow>
      </section>
    </section>
  )
}

function ModelRow({
  busy,
  config,
  modelId,
  onSetLight,
  onSetPrimary,
  onToggleModel,
  poolEntries,
  provider,
}: {
  busy: boolean
  config: AppConfig
  modelId: string
  onSetLight: (key: string | null) => void
  onSetPrimary: (key: string) => void
  onToggleModel: (modelId: string, enabled: boolean) => void
  poolEntries: ModelPoolEntry[]
  provider: ProviderId
}) {
  const key = modelEntryKey({ provider, modelId })
  const enabled = poolEntries.some((entry) => entry.modelId === modelId)
  const isPrimary = config.primaryModelKey === key
  const isLight = config.lightModelKey === key

  return (
    <div
      data-model-toggle={modelId}
      data-enabled={enabled ? 'true' : 'false'}
      className="flex min-h-[52px] items-center justify-between gap-3 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs text-foreground">{modelId}</span>
        {isPrimary ? <span className={MUTED_PILL_CLASS}>主力</span> : null}
        {isLight ? <span className={MUTED_PILL_CLASS}>轻量</span> : null}
        {enabled ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {!isPrimary ? (
              <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => onSetPrimary(key)}>
                设为主力
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => onSetLight(isLight ? null : key)}
            >
              {isLight ? '跟随主力' : '设为轻量'}
            </Button>
          </div>
        ) : null}
      </div>
      <Switch
        checked={enabled}
        disabled={busy}
        aria-label={enabled ? `停用 ${modelId}` : `启用 ${modelId}`}
        onCheckedChange={(checked) => onToggleModel(modelId, checked)}
      />
    </div>
  )
}

function TestResultLine({
  channelVerified,
  testResult,
}: {
  channelVerified: boolean
  testResult: ConnectionTestResult | null
}) {
  if (testResult) {
    if (testResult.ok) {
      return (
        <p className="text-xs text-success">连接成功{testResult.verifiedAt ? ` · ${formatVerificationTime(testResult.verifiedAt)}` : ''}</p>
      )
    }
    return <p className="text-xs text-destructive">{testResult.message}</p>
  }
  if (channelVerified) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-success">
        <CheckCircle2 className="size-3.5 shrink-0" />
        已连接
      </p>
    )
  }
  return null
}

function formatVerificationTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/**
 * 模型行合集（渠道内）：fetched 非空时 = fetched ∪ poolEntries.modelId（保序去重，池里手填的哪怕
 * 不在 fetched 清单里也要出现）；fetched 为 null（未拉取过）时改用内置目录 catalog 兜底同样的并集
 * 逻辑——静默回落语义（拉取失败/未拉取，模型列表照常显示）。
 */
export function buildModelRows(catalog: string[], fetched: string[] | null, poolEntries: ModelPoolEntry[]): string[] {
  const source = fetched ?? catalog
  const seen = new Set<string>()
  const rows: string[] = []
  for (const modelId of source) {
    if (seen.has(modelId)) continue
    seen.add(modelId)
    rows.push(modelId)
  }
  for (const entry of poolEntries) {
    if (seen.has(entry.modelId)) continue
    seen.add(entry.modelId)
    rows.push(entry.modelId)
  }
  return rows
}

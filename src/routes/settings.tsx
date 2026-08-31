import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import {
  Activity,
  FolderOpen,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { BrandStoryBanner } from '@/components/brand'
import { TitlebarDragGutter } from '@/components/TitlebarDragGutter'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AgentProfileInspector } from '@/components/settings/AgentProfileInspector'
import {
  CapabilityPackLibraryPanel,
  packsSubTitle,
  parsePacksSubParam,
  readPacksSubHistoryDepth,
} from '@/components/settings/CapabilityPackLibraryPanel'
import { ModelProviderDetailPanel } from '@/components/settings/ModelProviderDetailPanel'
import { ModelProviderListPanel } from '@/components/settings/ModelProviderListPanel'
import { MODEL_PROVIDERS, parseModelProviderParam } from '@/components/settings/model-providers'
import { UpdateRow } from '@/components/settings/UpdateRow.tsx'
import { TelemetryPanel } from '@/components/settings/TelemetryPanel'
import { APP_CANVAS_CLASS, WORKSPACE_SHELL_CLASS } from '@/design-system'
import {
  SettingsActionRow,
  SettingsBreadcrumb,
  SettingsCard,
  SettingsPrimarySidebar,
  SettingsRow,
} from '@/components/settings/SettingsLayout'
import { useTheme, DARK_MODE_ENABLED, type Theme } from '@/lib/theme'
import { Disclosure } from '@/components/ui/disclosure'
import {
  deleteApiKey,
  getConfig,
  getNarraCatDiagnostics,
  getProcessHealth,
  listProviderModels,
  runCorpusHealthProbe,
  runEmbeddingHealthProbe,
  readWorkLocation,
  saveConfig,
  selectDirectory,
  setApiKey,
  testConnection,
} from '@/lib/ipc'
import { buildPoolEntry, modelEntryKey } from '@shared/lib/model-slots'
import { useNovelStore } from '@/lib/novel-store'
import { createLoadIssue } from '@/lib/load-state'
import { resolveSettingsReturnTarget } from '@/lib/work-location'
import { applyConfigCommit, mergeProviderDraft, shouldWarnPrimaryModelDisabled } from '@/lib/settings-config'
import { POOL_DEFAULT_FIELDS, type WireId } from '@shared/types/config'
import type {
  AppConfig,
  ConnectionTestResult,
  CorpusHealthProbeResult,
  EmbeddingHealthProbeResult,
  ProviderId,
} from '@shared/types/ipc'
import { summarizeProcessHealthEvent } from '@shared/lib/process-health'
import type { ProcessHealthReport } from '@shared/types/process-health'

declare const __NARRACAT_CLIENT_VERSION__: string | undefined

const APP_VERSION_FALLBACK = '0.1.0'
const ABOUT_TAGLINE = '故事生于人，成于智能。'
const ABOUT_STORY_PARAGRAPHS = [
  '在人类文明中，故事一直来自人的记忆、情感与想象。\n从口述，到书写，再到数字时代，技术不断改变表达方式，但创造故事的，始终是人。',
  '在智能时代，创作不必再被时间与执行成本限制。\nNarraCat 让智能先理解你的所想，再协助构建世界观、推进剧情结构、生成章节内容。',
  '你决定故事的意义与方向，智能负责让故事持续生长。',
  '我们不试图替代创作者，我们只希望—\n让更多故事，有机会被完成。',
]

const ABOUT_BETA_NOTICE = [
  '内测版 · 请勿外传。软件按现状提供，模型费用由你自理，不对生成结果或 API 账单负责。',
  '稿件默认保存在本机小说目录，API Key 经系统凭据库加密保存——NarraCat 不自建服务器保存它们。',
  '运行 Agent / 角色聊天时，必要内容会发送到你配置的模型服务商以生成结果。建议定期备份小说目录，以防误删或丢失。',
  '匿名使用统计只上报版本、功能模块名与成败耗时区间，不含任何稿件内容；可在「安全与项目」里随时关闭。',
]

const DEFAULT_CONFIG: AppConfig = {
  ...POOL_DEFAULT_FIELDS,
  apiKeyMetadata: {},
  novelRootDir: '',
  recentNovelPaths: [],
  systemNotificationsEnabled: true,
  introVersion: 0,
  telemetryEnabled: true,
  telemetryNoticeAckedVersion: 0,
  telemetryAnonymousId: '',
}

const SETTINGS_SECTIONS = [
  { id: 'model', title: '模型服务' },
  { id: 'agents', title: 'Agent 档案' },
  { id: 'packs', title: '能力包', badge: '测试' },
  { id: 'workspace', title: '安全与项目' },
  { id: 'appearance', title: '外观' },
  { id: 'window', title: '窗口' },
  { id: 'about', title: '关于' },
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

function readSettingsSectionId(searchParams: URLSearchParams): SettingsSectionId {
  const value = searchParams.get('section')?.trim()
  return SETTINGS_SECTIONS.some((section) => section.id === value) ? (value as SettingsSectionId) : 'model'
}

// 模型服务二级视图（`?section=model&provider=<id>`）的导航来源标记：应用内点渠道行进入时打标记，
// 面包屑/返回据此走 navigate(-1) 弹历史；深链/刷新进入没有标记，回退改用 replace 清参数——
// 语义仿 packs 分区（CapabilityPackLibraryPanel 的 packsSubInternal），只是模型服务只有一层，不必记深度。
type ModelProviderHistoryState = { modelProviderInternal: true }

function hasInternalModelProviderOrigin(state: unknown): boolean {
  return Boolean((state as Partial<ModelProviderHistoryState> | null)?.modelProviderInternal)
}

function readClientVersion(): string {
  const injectedVersion =
    typeof __NARRACAT_CLIENT_VERSION__ === 'string' ? __NARRACAT_CLIENT_VERSION__.trim() : ''
  return injectedVersion || APP_VERSION_FALLBACK
}




function formatEmbeddingModelSource(result: EmbeddingHealthProbeResult | null): string {
  if (!result) return '未运行'
  const { modelSource } = result
  if (modelSource.kind === 'bundled-offline') return `内置离线包（${modelSource.modelPath ?? '已就绪'}）`
  if (modelSource.kind === 'on-demand-download') return '按需下载（开发态，无内置模型）'
  return `未找到（已检查：${modelSource.candidates.join(' · ') || '—'}）`
}

/** 取自检某一环节并渲染；自检整体未返回时给出进程级原因。 */
function formatEmbeddingStep(
  result: EmbeddingHealthProbeResult | null,
  pick: (report: NonNullable<EmbeddingHealthProbeResult['selfTest']>) => { ok: boolean; error?: string } | undefined,
  renderOk: (report: NonNullable<EmbeddingHealthProbeResult['selfTest']>) => string,
): string {
  if (!result) return '未运行'
  if (!result.selfTest) return result.process.error ? `自检未返回（${result.process.error}）` : '自检未返回结果'
  const step = pick(result.selfTest)
  if (!step) return '未运行'
  if (!step.ok) return step.error ? `失败：${step.error}` : '失败'
  return renderOk(result.selfTest)
}

function AboutBrandStory() {
  return (
    <section
      className="mb-5 overflow-hidden rounded-workspace border border-border bg-workspace"
      data-settings-about-brand-story="true"
    >
      <div className="aspect-[200/73] w-full overflow-hidden bg-active">
        <BrandStoryBanner />
      </div>

      <div className="p-5 sm:p-6">
        <h2 className="text-xl font-semibold leading-tight text-foreground">{ABOUT_TAGLINE}</h2>
        <div className="mt-5 space-y-2 whitespace-pre-line text-sm leading-7 text-muted-foreground">
          {ABOUT_STORY_PARAGRAPHS.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </div>
    </section>
  )
}

function AboutBetaNotice() {
  return (
    <section
      className="mt-4 rounded-workspace border border-border bg-workspace px-5 py-4 sm:px-6"
      data-settings-about-beta-notice="true"
    >
      <h3 className="text-sm font-medium leading-tight text-foreground">内测声明与数据安全</h3>
      <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
        {ABOUT_BETA_NOTICE.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
    </section>
  )
}

/**
 * 稳定性事件的一行摘要（#39）。
 *
 * 「未记录到异常」是有意义的信息，不是空态占位——它告诉作者「查过了，没事」，
 * 与「读取中」（可能自己就是故障信号）必须分开显示。
 */
function formatProcessHealthSummary(report: ProcessHealthReport | null): string {
  if (!report) return '读取中'
  if (report.events.length === 0) return '未记录到异常'
  const latest = summarizeProcessHealthEvent(report.events[0])
  return report.events.length === 1 ? latest : `${latest}（共 ${report.events.length} 条）`
}

/**
 * 关于页诊断折叠（通用 Disclosure 的薄封装：钉住 data 锚点与摘要行样式）。
 *
 * 为什么不用原生 <details>：Windows 打包版（asar）实测渲染原生 details 元素会把渲染主线程
 * 挂死（无 CPU 的同步阻塞；dev 的非 asar file:// 与 mac 均正常）——Electron 41.2.1（对应 Chromium 146）引擎级问题，
 * 与业务代码无关（纯净 <details> 即可复现）。全库统一走 ui/disclosure。
 */
function AboutDiagnosticsDisclosure({ children }: { children: React.ReactNode }) {
  return (
    <Disclosure
      data-settings-about-diagnostics="true"
      summary={(open) => (
        <span className="flex min-h-[56px] w-full items-center justify-between gap-4 px-3 py-3 text-sm font-medium text-foreground">
          <span>诊断信息</span>
          <span className="text-xs font-normal text-muted-foreground">{open ? '收起' : '展开'}</span>
        </span>
      )}
    >
      <div className="divide-y divide-border border-t border-border">{children}</div>
    </Disclosure>
  )
}

export function SettingsRoute() {
  const { theme, setTheme } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  // 首次挂载捕获进入设置时的来源页（工作台/书架）；之后子视图导航改写
  // location.state 也不会污染它。旧入口没有来源时，从主进程耐久落点恢复。
  const settingsSourceRef = useRef((location.state as { from?: string } | null)?.from)
  const [returnTo, setReturnTo] = useState<string | null>(() => {
    const source = settingsSourceRef.current
    if (!source || source === '/workbench') return null
    return resolveSettingsReturnTarget(source, { version: 1, landing: 'library' })
  })
  const storedDiagnostics = useNovelStore((state) => state.diagnostics)
  const diagnostics = storedDiagnostics ?? useNovelStore.getState().diagnostics
  const setDiagnostics = useNovelStore((state) => state.setDiagnostics)
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG)
  // commitConfig 需要"当前最新 config"而非闭包捕获的旧值——用作 applyConfigCommit 的 draft
  // 参数（回显时把落盘结果的 providers 换回本地正在编辑的端点草稿）。useState 的 config 变量
  // 会捕获调用时刻的旧闭包，ref 跟随 state 走保证读到的是最新值。
  const configRef = useRef(config)
  configRef.current = config
  // T4 复审 F2：渠道详情页请求在途时用户可经面包屑切到另一渠道（或退回一级页）；闭包捕获的
  // `modelSub` 是发起请求那次渲染的旧值，判断不出"用户是否已经切走"——须用 ref 跟随最新值
  // （赋值见 modelSub 计算处），异步回调里每次 setState 前用它核对，过期响应直接丢弃不落地。
  const modelSubRef = useRef<ProviderId | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [savingConfig, setSavingConfig] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [processHealth, setProcessHealth] = useState<ProcessHealthReport | null>(null)
  const [embeddingProbe, setEmbeddingProbe] = useState<EmbeddingHealthProbeResult | null>(null)
  const [embeddingProbeRunning, setEmbeddingProbeRunning] = useState(false)
  const [embeddingProbeStatus, setEmbeddingProbeStatus] = useState<string | null>(null)
  const [corpusProbe, setCorpusProbe] = useState<CorpusHealthProbeResult | null>(null)
  const [corpusProbeRunning, setCorpusProbeRunning] = useState(false)
  const [corpusProbeStatus, setCorpusProbeStatus] = useState<string | null>(null)
  // 二级页（渠道详情）状态：切换 provider 时重置，避免上一个渠道的拉取结果/输入残留串到下一个渠道。
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void readWorkLocation()
      .then((stored) => {
        if (!cancelled) setReturnTo(resolveSettingsReturnTarget(settingsSourceRef.current, stored))
      })
      .catch((error) => {
        createLoadIssue('startup', error)
        if (!cancelled) setReturnTo('/')
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const payload = await getConfig()
        if (cancelled) return
        setConfig(payload.config)
      } catch (error) {
        if (!cancelled) setStatus((error as Error).message)
      } finally {
        if (!cancelled) setLoadingConfig(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadDiagnostics() {
      try {
        const result = await getNarraCatDiagnostics()
        if (!cancelled) setDiagnostics(result)
      } catch {
        // Settings still renders without Agent Core diagnostics; Library surfaces the detailed error path.
      }
    }
    void loadDiagnostics()
    return () => {
      cancelled = true
    }
  }, [setDiagnostics])

  useEffect(() => {
    let cancelled = false
    async function loadProcessHealth() {
      try {
        const report = await getProcessHealth()
        if (!cancelled) setProcessHealth(report)
      } catch {
        // 取证读不出来不该让设置页打不开——诊断行会停在「读取中」，本身也是一种信号。
      }
    }
    void loadProcessHealth()
    return () => {
      cancelled = true
    }
  }, [])

  // 池 / 槽位改动的统一落盘 helper：模型池化后这些改动不再走「改草稿 + 手动保存设置」，
  // 一律即时持久化，杜绝「忘了保存」。
  // F1 终审修复：mutate 基线用 getConfig() 取回的最近已持久化 config，不用 configRef.current——
  // 后者可能带着用户正在编辑但没提交的端点草稿（如删到剩 "https://ap"），若随「设为主力」
  // 「添加模型」一起落盘，会触发 normalizeAppConfig 自愈清空该 provider 全部条目验证。
  // 端点草稿仍只在 onTestConnection 的 saveConfig 路径落盘。落盘后用 toDisplay 把 providers 换回
  // 本地草稿，避免用户正在编辑的输入框被这次落盘结果（不含草稿）回滚。
  // busy 门（disabled={busy}）已挡连点，此处不需要额外竞态兜底。
  // T4 复审 F1：返回落盘后的显示态（成功）或 null（失败）——调用方据此判断"是否真的落盘成功"再决定
  // 要不要发依赖落盘结果的 toast（如"主力已自动切换"），不能在 mutate 里提前发，mutate 必须保持纯函数
  // （在 applyConfigCommit 内同步跑在 saveConfig 之前，落盘失败时提前发的 toast 会跟实际结果对不上）。
  async function commitConfig(mutate: (current: AppConfig) => AppConfig): Promise<AppConfig | null> {
    setSavingConfig(true)
    try {
      const persisted = (await getConfig()).config
      const { toPersist, toDisplay } = applyConfigCommit(persisted, configRef.current, mutate)
      const payload = await saveConfig(toPersist)
      const display = toDisplay(payload.config)
      setConfig(display)
      return display
    } catch (error) {
      const message = (error as Error).message
      setStatus(message)
      toast.error(message)
      return null
    } finally {
      setSavingConfig(false)
    }
  }

  function onSetPrimary(key: string) {
    void commitConfig((current) => ({ ...current, primaryModelKey: key }))
  }

  function onSetLight(key: string | null) {
    void commitConfig((current) => ({ ...current, lightModelKey: key }))
  }

  function onModelBaseUrlChange(baseUrl: string) {
    if (!modelSub) return
    // 端点是打字输入，不逐键落盘——下一次「测试连接」（onTestConnection）落盘会带上它。
    // 展开保留 wire：协议与地址同属端点草稿，只写 baseUrl 会把本地 wire 抹掉。
    setConfig((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [modelSub]: { ...current.providers[modelSub], baseUrl },
      },
    }))
  }

  // 切换接口协议：离散操作即时落盘（与切槽位同语义）。落盘后 normalize 自愈会让该渠道
  // 全部验证快照失效（wire 不符），用户需重新「测试连接」；会话指纹含 wire，旧对话同步失效。
  function onModelWireChange(wire: WireId) {
    if (!modelSub) return
    void commitConfig((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [modelSub]: { ...current.providers[modelSub], wire },
      },
    }))
  }

  // 启用/停用渠道内某个模型：启用即入池（继承渠道级验证快照，见 buildPoolEntry）；停用即出池。
  // 若停用的正是当前主力，自动切到池内第一个模型（fail-soft，不留悬空主力键）。
  // T4 复审 F1：mutate 保持纯函数（不在其中调用 toast）——"是否曾是主力"在调用 commitConfig 前
  // 用 configRef.current 同步判定一次（快照），toast 挪到 commitConfig 落盘成功（返回非 null）之后才发，
  // 避免落盘失败时用户先看到"已自动切换"提示、UI 实际却没变的时序错配。
  function onToggleModel(modelId: string, enabled: boolean) {
    if (!modelSub) return
    const provider = modelSub
    const wasPrimary = shouldWarnPrimaryModelDisabled(configRef.current, provider, modelId, enabled)
    void commitConfig((current) => {
      if (enabled) {
        return { ...current, modelPool: [...current.modelPool, buildPoolEntry(current, provider, modelId)] }
      }
      const key = modelEntryKey({ provider, modelId })
      return { ...current, modelPool: current.modelPool.filter((entry) => modelEntryKey(entry) !== key) }
    }).then((saved) => {
      if (saved && wasPrimary) toast.info('主力模型已被停用，已自动切到池内第一个模型')
    })
  }

  // 添加自定义模型 = 启用一个不在目录/拉取清单里的手填 model id，语义等同 onToggleModel(id, true)。
  function onAddCustomModel(modelId: string) {
    onToggleModel(modelId, true)
  }

  async function onSaveApiKey() {
    if (!modelSub) return
    setSavingKey(true)
    setStatus(null)
    try {
      await setApiKey(modelSub, apiKeyInput)
      const payload = await getConfig()
      setConfig(payload.config)
      setApiKeyInput('')
      setStatus('API Key 已保存。')
      toast.success('API Key 已保存')
    } catch (error) {
      const message = (error as Error).message
      setStatus(message)
      toast.error(message)
    } finally {
      setSavingKey(false)
    }
  }

  // 渠道级测试连接：先落盘端点草稿（唯一落盘入口）+ 未保存的 Key 输入，再测试整个渠道并回读盖章结果。
  // T4 复审 F2：请求在途时用户可能已经切到另一渠道——每次 await 之后、设置视图态之前用 modelSubRef
  // 核对当前仍是发起请求时的渠道，不是才 return，防止过期响应把 A 渠道的结果写进 B 渠道的界面。
  // setTesting(false) 只是通用忙态标志（不是某渠道的数据），finally 里不guard，永远要执行，否则
  // 用户切走后 busy 会卡死在 true。
  // 终审修复 F1②：落盘前只把当前渠道的端点草稿并入紧邻取回的 persisted config
  // （mergeProviderDraft）——不再整份 saveConfig(configRef.current)，避免别的渠道遗留的半成品
  // 端点草稿被这次测试连带持久化。
  // 终审修复 F3：测试结果的 toast（成功/失败）不属于渠道视图态——服务端盖章已经发生，无论用户
  // 是否已切走都要提示，口径与 catch 分支的 toast.error 一致；因此这两条 toast 挪到 modelSubRef
  // guard 之前发出，guard 只挡后续的 setState（视图态）。
  async function onTestConnection() {
    if (!modelSub) return
    const provider = modelSub
    setTesting(true)
    setTestResult(null)
    try {
      const persisted = (await getConfig()).config
      const payload = await saveConfig(mergeProviderDraft(persisted, configRef.current, provider))
      if (modelSubRef.current !== provider) return
      setConfig(payload.config)
      if (apiKeyInput.trim()) {
        await setApiKey(provider, apiKeyInput)
        if (modelSubRef.current !== provider) return
        setApiKeyInput('')
      }
      const result = await testConnection(provider)
      if (result.ok) {
        toast.success('连接成功，模型已启用')
      } else {
        toast.error(result.message)
      }
      if (modelSubRef.current !== provider) return
      setTestResult(result)
      const refreshed = await getConfig()
      if (modelSubRef.current !== provider) return
      setConfig(refreshed.config)
    } catch (error) {
      const message = (error as Error).message
      toast.error(message)
      if (modelSubRef.current === provider) setTestResult({ ok: false, message })
    } finally {
      setTesting(false)
    }
  }

  async function onRefreshModels() {
    if (!modelSub) return
    const provider = modelSub
    setFetchingModels(true)
    setFetchError(null)
    try {
      const result = await listProviderModels(provider)
      if (modelSubRef.current !== provider) return
      if (result.ok) setFetchedModels(result.models)
      else setFetchError(result.message)
    } finally {
      setFetchingModels(false)
    }
  }

  async function onSaveConfig() {
    setSavingConfig(true)
    setStatus(null)
    setTestResult(null)
    try {
      const payload = await saveConfig(config)
      setConfig(payload.config)
      setStatus('设置已保存。')
      toast.success('设置已保存')
    } catch (error) {
      const message = (error as Error).message
      setStatus(message)
      toast.error(message)
    } finally {
      setSavingConfig(false)
    }
  }

  async function onDeleteApiKey() {
    if (!modelSub) return
    setSavingKey(true)
    setStatus(null)
    try {
      await deleteApiKey(modelSub)
      const payload = await getConfig()
      setConfig(payload.config)
      setApiKeyInput('')
      setStatus('API Key 已删除。')
      toast.success('API Key 已删除')
    } catch (error) {
      const message = (error as Error).message
      setStatus(message)
      toast.error(message)
    } finally {
      setSavingKey(false)
    }
  }

  async function onSelectNovelRoot() {
    setStatus(null)
    try {
      const directory = await selectDirectory()
      if (!directory) return
      setConfig((current) => ({ ...current, novelRootDir: directory }))
      setStatus('小说根目录已选择，记得保存设置。')
      toast.info('已选择小说根目录')
    } catch (error) {
      const message = (error as Error).message
      setStatus(message)
      toast.error(message)
    }
  }

  async function onRunEmbeddingProbe() {
    setEmbeddingProbeRunning(true)
    setEmbeddingProbeStatus(null)
    try {
      const result = await runEmbeddingHealthProbe()
      setEmbeddingProbe(result)
      setEmbeddingProbeStatus(result.summary)
      if (result.ok) {
        toast.success('向量语义检索正常')
      } else {
        toast.error(result.summary)
      }
    } catch (error) {
      const message = (error as Error).message
      setEmbeddingProbeStatus(message)
      setEmbeddingProbe(null)
      toast.error(message)
    } finally {
      setEmbeddingProbeRunning(false)
    }
  }

  async function onRunCorpusProbe() {
    setCorpusProbeRunning(true)
    setCorpusProbeStatus(null)
    try {
      const result = await runCorpusHealthProbe()
      setCorpusProbe(result)
      setCorpusProbeStatus(result.summary)
      if (result.ok) {
        toast.success('语料服务连通')
      } else {
        toast.error(result.summary)
      }
    } catch (error) {
      const message = (error as Error).message
      setCorpusProbeStatus(message)
      setCorpusProbe(null)
      toast.error(message)
    } finally {
      setCorpusProbeRunning(false)
    }
  }

  const busy = loadingConfig || savingConfig || savingKey || testing || embeddingProbeRunning || corpusProbeRunning
  const statusText = status ?? ''
  const activeSectionId = readSettingsSectionId(searchParams)
  const activeSection = SETTINGS_SECTIONS.find((section) => section.id === activeSectionId) ?? SETTINGS_SECTIONS[0]
  const clientVersion = readClientVersion()
  // 设置页二级视图导航规范：二级经 ?sub= / ?provider= 路由化，titlebar 变面包屑（一级可点返回）。
  const packsSub = activeSectionId === 'packs' ? parsePacksSubParam(searchParams.get('sub')) : null
  // 应用内 push 深度：列表→我的创作=1，我的创作→编辑器=2；0=深链/刷新进入（历史里没有上级页）。
  // 面包屑按实际深度选 navigate(-N) 步数，不硬编码层级——刷新落在中间层后再下钻，深度可能小于设计层级。
  const packsSubDepth = readPacksSubHistoryDepth(location.state)
  // 模型服务二级视图（渠道详情）：只有一层，不需要 packsSub 那种深度计数。
  const modelSub = activeSectionId === 'model' ? parseModelProviderParam(searchParams.get('provider')) : null
  modelSubRef.current = modelSub

  // 切换渠道（含从一级页进入/一级页退出/换渠道）时清空上一个渠道的二级页临时态——拉取结果、
  // 输入框草稿、上一次测试结果都不该串到下一个渠道。
  // 终审修复 F1①：同时把 config.providers 草稿回滚到已持久化态——不这样做，上一渠道遗留的
  // 半成品端点（如编辑到剩 "https://ap"）会跟着 configRef.current 活到下一次别的渠道点「测试
  // 连接」，被整份带下盘。用 modelSubRef 核对：若 getConfig() 落地时用户又切到了别的渠道，
  // 丢弃这次结果（下一次 effect 触发会用更新的持久化态重跑一遍）。
  useEffect(() => {
    setFetchedModels(null)
    setFetchError(null)
    setApiKeyInput('')
    setTestResult(null)
    const enteringSub = modelSub
    void getConfig().then((payload) => {
      if (modelSubRef.current !== enteringSub) return
      setConfig((current) => ({ ...current, providers: payload.config.providers }))
    })
  }, [modelSub])

  function openModelProvider(provider: ProviderId) {
    setSearchParams({ section: 'model', provider }, { state: { modelProviderInternal: true } })
  }

  function backToModelProviderList() {
    if (hasInternalModelProviderOrigin(location.state)) navigate(-1)
    else setSearchParams({ section: 'model' }, { replace: true })
  }

  return (
    <div className={`${APP_CANVAS_CLASS} flex h-full min-h-0 overflow-hidden`} data-settings-layout="split">
      <SettingsPrimarySidebar
        activeSectionId={activeSectionId}
        sections={SETTINGS_SECTIONS}
        returnTo={returnTo}
      />

      {/* 顶部 padding 平台感知：win32 下内容卡从 caption 带下方开始（方案 A 上下分区，
          与工作台舞台同构；左栏保持通顶）。 */}
      <main className="relative min-h-0 min-w-0 flex-1 px-3 pb-3 pt-[max(0.75rem,var(--titlebar-gutter-top))]" data-settings-stage="true">
        <section
          className={`${WORKSPACE_SHELL_CLASS} flex h-full min-h-0 flex-col overflow-hidden`}
          data-settings-content-shell="true"
        >
          <header
            className="flex h-14 shrink-0 items-center border-b border-border bg-workspace px-5"
            data-settings-content-titlebar="true"
          >
            {modelSub ? (
              <SettingsBreadcrumb
                trail={[
                  {
                    label: activeSection.title,
                    onNavigate: backToModelProviderList,
                  },
                  { label: MODEL_PROVIDERS.find((item) => item.id === modelSub)?.label ?? '渠道详情' },
                ]}
              />
            ) : packsSub ? (
              <SettingsBreadcrumb
                trail={
                  packsSub.kind === 'draft' || packsSub.kind === 'wizard' || packsSub.kind === 'learn'
                    ? [
                        {
                          label: activeSection.title,
                          // 回列表要跳 2 层历史（列表→我的创作→编辑器/作家向导/从书学写法）；实际深度不够（刷新落在
                          // 我的创作后才下钻）或深链进入，才 replace 直接定位到列表
                          onNavigate: () => {
                            if (packsSubDepth >= 2) navigate(-2)
                            else setSearchParams({ section: activeSectionId }, { replace: true })
                          },
                        },
                        {
                          label: '我的创作',
                          // 上一级回我的创作只需跳 1 层，内部来源恒满足（push 到三级视图前必先经过我的创作）
                          onNavigate: () => {
                            if (packsSubDepth >= 1) navigate(-1)
                            else setSearchParams({ section: activeSectionId, sub: 'creations' }, { replace: true })
                          },
                        },
                        { label: packsSubTitle(packsSub) },
                      ]
                    : [
                        {
                          label: activeSection.title,
                          // 内部进入的二级弹历史条目（navigate(-1)），深链/刷新进入才 replace 清 sub——
                          // 否则 push 进入 + replace 返回会留下重复历史，后退键一次无变化
                          onNavigate: () => {
                            if (packsSubDepth >= 1) navigate(-1)
                            else setSearchParams({ section: activeSectionId }, { replace: true })
                          },
                        },
                        { label: packsSubTitle(packsSub) },
                      ]
                }
              />
            ) : (
              <h1 className="truncate text-sm font-semibold text-foreground">{activeSection.title}</h1>
            )}
          </header>

          <div className="min-h-0 flex-1 overflow-auto">
            {/* 作家向导是 ChatBot 式钉底布局：容器转全高，消息区在面板内部自滚、composer 钉底；
                其余页面保持自然高度随外层滚动 */}
            <div
              className={
                packsSub?.kind === 'wizard'
                  ? 'mx-auto h-full w-full max-w-[900px] p-6'
                  : 'mx-auto w-full max-w-[900px] p-6'
              }
              data-settings-page={activeSectionId}
            >
              {activeSectionId === 'model' ? (
                modelSub ? (
                  <ModelProviderDetailPanel
                    provider={modelSub}
                    config={config}
                    busy={busy}
                    savingKey={savingKey}
                    apiKeyInput={apiKeyInput}
                    testing={testing}
                    testResult={testResult}
                    fetchedModels={fetchedModels}
                    fetchingModels={fetchingModels}
                    fetchError={fetchError}
                    onApiKeyChange={setApiKeyInput}
                    onSaveApiKey={onSaveApiKey}
                    onDeleteApiKey={onDeleteApiKey}
                    onBaseUrlChange={onModelBaseUrlChange}
                    onWireChange={onModelWireChange}
                    onTestConnection={onTestConnection}
                    onRefreshModels={onRefreshModels}
                    onToggleModel={onToggleModel}
                    onAddCustomModel={onAddCustomModel}
                    onSetPrimary={onSetPrimary}
                    onSetLight={onSetLight}
                  />
                ) : (
                  <ModelProviderListPanel config={config} onOpenProvider={openModelProvider} />
                )
              ) : null}

              {activeSectionId === 'agents' ? <AgentProfileInspector /> : null}

              {activeSectionId === 'packs' ? <CapabilityPackLibraryPanel /> : null}

              {activeSectionId === 'workspace' ? (
                <SettingsCard>
                  <SettingsRow title="小说根目录" description="NarraCat 读取和写入项目文件的位置">
                    <div className="flex gap-2">
                      <Input
                        value={config.novelRootDir}
                        disabled={busy}
                        placeholder="~/Documents/NarraCat"
                        className="h-7 text-xs"
                        onChange={(e) => setConfig((current) => ({ ...current, novelRootDir: e.target.value }))}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label="选择小说根目录"
                        disabled={busy}
                        onClick={onSelectNovelRoot}
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                    </div>
                  </SettingsRow>

                  <SettingsActionRow status="小说根目录变化后需要保存设置。">
                    <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onSaveConfig}>
                      {savingConfig ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      保存项目设置
                    </Button>
                  </SettingsActionRow>

                  {/* 匿名使用统计（ADR-0039）：自带即时生效，不走上面的「保存设置」。 */}
                  <TelemetryPanel />
                </SettingsCard>
              ) : null}

              {activeSectionId === 'appearance' ? (
                <SettingsCard>
                  <SettingsRow
                    title="主题"
                    description={DARK_MODE_ENABLED ? '跟随系统会随 OS dark/light mode 自动切换' : '外观主题'}
                  >
                    {/* 深色门控关闭时：隐藏「跟随系统」、锁定「深色」，并强制选中「浅色」 */}
                    <Select
                      value={DARK_MODE_ENABLED ? theme : 'light'}
                      onValueChange={(v) => setTheme(v as Theme)}
                    >
                      <SelectTrigger size="sm" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DARK_MODE_ENABLED ? <SelectItem value="system">跟随系统</SelectItem> : null}
                        <SelectItem value="light">浅色</SelectItem>
                        {DARK_MODE_ENABLED ? (
                          <SelectItem value="dark">深色</SelectItem>
                        ) : (
                          <SelectItem value="dark" disabled>
                            深色（即将开放）
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                </SettingsCard>
              ) : null}

              {activeSectionId === 'window' ? (
                <SettingsCard>
                  <SettingsRow
                    title="后台任务完成时系统通知提醒"
                    description="App 不活跃时提醒成功、失败和等待确认"
                  >
                    <div className="flex justify-end">
                      <Switch
                        checked={config.systemNotificationsEnabled}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          setConfig((current) => ({
                            ...current,
                            systemNotificationsEnabled: checked,
                          }))
                        }
                      />
                    </div>
                  </SettingsRow>
                  <SettingsRow title="最小化到托盘" description="即将推出">
                    <div className="flex justify-end">
                      <Switch disabled />
                    </div>
                  </SettingsRow>
                  <SettingsActionRow status="窗口设置变化后需要保存设置。">
                    <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onSaveConfig}>
                      {savingConfig ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      保存窗口设置
                    </Button>
                  </SettingsActionRow>
                </SettingsCard>
              ) : null}

              {activeSectionId === 'about' ? (
                <>
                  <AboutBrandStory />
                  <div data-settings-about-list="true">
                    <SettingsCard>
                      <SettingsRow title="客户端版本">
                        <div className="text-right text-sm tabular">{clientVersion}</div>
                      </SettingsRow>
                      <SettingsRow title="软件更新">
                        <UpdateRow />
                      </SettingsRow>
                      <SettingsRow title="NarraCat Agent Core 版本">
                        <div className="truncate text-right text-sm tabular">
                          {diagnostics?.version ?? '未检测'}
                        </div>
                      </SettingsRow>
                      <SettingsRow title="作者">
                        <div className="text-right text-sm">Lumos Yannik</div>
                      </SettingsRow>
                      <SettingsRow title="官网">
                        <div className="text-right">
                          <a
                            href="https://narracat.com/"
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-foreground hover:underline"
                          >
                            narracat.com
                          </a>
                        </div>
                      </SettingsRow>
                      <SettingsRow title="字体">
                        <div className="text-right text-sm">
                          本软件使用{' '}
                          <a
                            href="https://hyperos.mi.com/font/zh/download/"
                            target="_blank"
                            rel="noreferrer"
                            className="text-foreground hover:underline"
                          >
                            MiSans 字体
                          </a>
                        </div>
                      </SettingsRow>
                      {/* 规避 Electron 41.2.1（对应 Chromium 146）在 Windows 打包版（asar）渲染原生 <details> 挂起主线程的
                          引擎级 bug——换 ui/disclosure（AboutDiagnosticsDisclosure，功能 1:1）。 */}
                      <AboutDiagnosticsDisclosure>
                          <SettingsRow title="Agent Core lock">
                            <div className="truncate text-right font-mono text-xs">
                              {diagnostics?.versionLock.path ?? 'agent-core/narracat-agent-core.lock.json'}
                            </div>
                          </SettingsRow>
                          <SettingsRow title="Agent Core path">
                            <div className="truncate text-right font-mono text-xs">
                              {diagnostics?.agentCorePath ?? '未检测'}
                            </div>
                          </SettingsRow>
                          <SettingsRow
                            title="稳定性事件"
                            description="界面崩溃、子进程退出、主线程卡死的留痕。反馈问题时把这里和下面的记录文件一起发来。"
                          >
                            <div
                              className={`text-right text-xs ${
                                processHealth && processHealth.events.length > 0
                                  ? 'text-destructive'
                                  : 'text-muted-foreground'
                              }`}
                            >
                              {formatProcessHealthSummary(processHealth)}
                            </div>
                          </SettingsRow>
                          {processHealth && processHealth.events.length > 0 ? (
                            <SettingsRow title="记录文件">
                              <div className="truncate text-right font-mono text-xs">
                                {processHealth.logPath}
                              </div>
                            </SettingsRow>
                          ) : null}
                          <SettingsRow
                            title="向量语义检索"
                            description="检查 embedding 模型与检索链路是否正常，区分「语义检索」与「降级为纯 FTS」。"
                          >
                            <div
                              className={`text-right text-xs font-medium ${
                                embeddingProbe
                                  ? embeddingProbe.ok
                                    ? 'text-foreground'
                                    : 'text-destructive'
                                  : 'text-muted-foreground'
                              }`}
                            >
                              {embeddingProbe?.summary ?? '未运行'}
                            </div>
                          </SettingsRow>
                          <SettingsRow title="模型来源">
                            <div className="truncate text-right font-mono text-xs">
                              {formatEmbeddingModelSource(embeddingProbe)}
                            </div>
                          </SettingsRow>
                          <SettingsRow title="模型加载">
                            <div className="truncate text-right text-xs">
                              {formatEmbeddingStep(
                                embeddingProbe,
                                (report) => report.modelLoad,
                                (report) =>
                                  `${report.modelLoad.modelName ?? '已加载'}（${report.modelLoad.dim ?? '?'} 维）`,
                              )}
                            </div>
                          </SettingsRow>
                          <SettingsRow title="向量生成">
                            <div className="truncate text-right text-xs">
                              {formatEmbeddingStep(
                                embeddingProbe,
                                (report) => report.embed,
                                (report) =>
                                  `${report.embed.dim ?? '?'} 维归一向量（${report.embed.durationMs ?? '?'}ms）`,
                              )}
                            </div>
                          </SettingsRow>
                          <SettingsRow title="sqlite-vec 扩展">
                            <div className="truncate text-right text-xs">
                              {formatEmbeddingStep(
                                embeddingProbe,
                                (report) => report.sqliteVec,
                                () => '已加载',
                              )}
                            </div>
                          </SettingsRow>
                          <SettingsRow title="检索自检">
                            <div className="truncate text-right text-xs">
                              {formatEmbeddingStep(
                                embeddingProbe,
                                (report) => report.retrieval,
                                (report) =>
                                  `KNN 命中（distance ${report.retrieval.topDistance?.toFixed(3) ?? '?'}）`,
                              )}
                            </div>
                          </SettingsRow>
                          <SettingsActionRow
                            status={embeddingProbeStatus ?? '主动验证向量模型及检索链路，离线可跑、不联网下载。'}
                          >
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={onRunEmbeddingProbe}
                            >
                              {embeddingProbeRunning ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Activity className="size-3.5" />
                              )}
                              检测
                            </Button>
                          </SettingsActionRow>
                          <SettingsRow
                            title="语料服务连通"
                            description="检查真人范例语料服务是否可达；不可达时写作可正常进行，仅暂不注入范例。"
                          >
                            <div
                              className={`text-right text-xs font-medium ${
                                corpusProbe
                                  ? corpusProbe.ok
                                    ? 'text-foreground'
                                    : 'text-destructive'
                                  : 'text-muted-foreground'
                              }`}
                            >
                              {corpusProbe?.summary ?? '未运行'}
                            </div>
                          </SettingsRow>
                          <SettingsActionRow
                            status={corpusProbeStatus ?? '联网探测语料服务（不上传任何小说内容）。'}
                          >
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={onRunCorpusProbe}
                            >
                              {corpusProbeRunning ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Activity className="size-3.5" />
                              )}
                              检测
                            </Button>
                          </SettingsActionRow>
                      </AboutDiagnosticsDisclosure>
                    </SettingsCard>
                  </div>
                  <AboutBetaNotice />
                </>
              ) : null}
            </div>
          </div>
        </section>
        <TitlebarDragGutter />
      </main>
    </div>
  )
}

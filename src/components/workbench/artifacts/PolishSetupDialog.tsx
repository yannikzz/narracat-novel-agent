import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { METADATA_TEXT_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'
import { getConfig, getPolishSettings, listPolishRecipes, savePolishRecipe, setStandingPolishSlot } from '@/lib/ipc'
import { usePolishRun } from '@/lib/polish-store'
import { isEntryVerified, modelEntryKey } from '@shared/lib/model-slots'
import { DEFAULT_PROVIDER_SETTINGS, type AppConfig } from '@shared/types/config'
import { POLISH_SLOT_IDS, type PolishRecipe, type PolishSlotId } from '@shared/types/prose-polish'

/**
 * 润色的配置弹窗（ADR-0041）：三套方案横版并排，主按钮「开始润色」。
 *
 * 配置用弹窗而不是抽屉，是因为**结果不在这里看**——跑起来之后版本回到工作台正文区的 tab 里，
 * 那才是读三千字的地方。抽屉会把要读的正文整个盖住，等于让作者隔着一层看自己的书。
 *
 * 配方存 userData（跨书复用），但入口在这里而不是设置页：调提示词是「改一版、再跑一次」的紧
 * 循环，把作者赶去设置页会把这个循环撕成两半。「本书常驻」是项目内设置，同页可改可关。
 */

export const POLISH_SLOT_LABELS: Record<PolishSlotId, string> = {
  'slot-1': '方案一',
  'slot-2': '方案二',
  'slot-3': '方案三',
}

/**
 * 容器遵 `docs/design.md` §9.7 弹窗规范：`bg-workspace p-0` 三段式（header / 自滚内容 / 按钮条），
 * **不用 DialogContent 默认的 `bg-floating` + `p-6`**——那是轻确认框的形态。
 *
 * 宽度走 §9.7 的「对比型弹窗」档（≤1320px + 窄窗降栏），不是私自越线：常规档的 560–680 是给
 * 单栏表单与长文清单的，680 摊到每栏不足 210px，要求正文会被压成一条缝。
 */
export const POLISH_SETUP_DIALOG_CONTENT_CLASS = [
  // gap-0 是必须的：DialogContent 默认带 gap-4，三段式下会在 header/内容/按钮条之间白白多出 16px，
  // 表现为标题下方一大片空白（真机看出来的）。p-0 只去掉外圈内边距，管不到段间距。
  'flex flex-col gap-0 overflow-hidden bg-workspace p-0',
  // 高度吃满可用空间：三栏各要一个能写下几行要求的输入框，靠内容撑出来的高度不够用。
  'h-[min(860px,calc(100dvh-4rem))] max-h-[calc(100dvh-4rem)]',
  'sm:max-w-[1320px]',
].join(' ')

/**
 * 空槽引导只给骨架，一个风格词都不给——给了示例就等于出厂模板，效果不好锅回到产品身上，
 * 与「不承诺效果」的定位直接冲突（ADR-0041 §2）。
 */
const PROMPT_PLACEHOLDER = ['要它做什么…', '不要它做什么…', '必须保留什么…'].join('\n')

function providerWire(config: AppConfig | null, provider: string): string {
  if (!config) return 'anthropic'
  const stored = config.providers[provider as keyof typeof config.providers]?.wire
  if (stored === 'anthropic' || stored === 'openai') return stored
  return DEFAULT_PROVIDER_SETTINGS[provider as keyof typeof DEFAULT_PROVIDER_SETTINGS]?.wire ?? 'anthropic'
}

export function PolishSetupDialog({
  open,
  onOpenChange,
  projectPath,
  chapter,
  originalText,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  chapter: number
  /** 送去润色的那一份正文，同时作为版本的基线（用来判断它们后来有没有过期）。 */
  originalText: string
  onStarted: (slotIds: PolishSlotId[]) => void
}) {
  const [recipes, setRecipes] = useState<PolishRecipe[]>([])
  const [selected, setSelected] = useState<PolishSlotId[]>([])
  const [standingSlotId, setStandingSlot] = useState<PolishSlotId | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [starting, setStarting] = useState(false)

  const start = usePolishRun((state) => state.start)

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void Promise.all([listPolishRecipes(), getPolishSettings(projectPath), getConfig()])
      .then(([file, settings, appConfig]) => {
        if (cancelled) return
        setRecipes(file.recipes)
        setStandingSlot(settings.standingSlotId)
        setConfig(appConfig.config)
        const filled = file.recipes.filter((recipe) => recipe.prompt.trim()).map((recipe) => recipe.slotId)
        // 默认沿用上次跑过的组合——迭代提示词时往往只想重跑改动的那一槽。
        const lastRun = file.lastRunSlotIds.filter((slotId) => filled.includes(slotId))
        setSelected(lastRun.length > 0 ? lastRun : filled)
      })
      .catch((error) => {
        console.error(error)
        toast.error('读取润色方案失败')
      })

    return () => {
      cancelled = true
    }
  }, [open, projectPath])

  const modelOptions = useMemo(() => {
    if (!config) return []
    return config.modelPool.map((entry) => {
      const wireUnsupported = providerWire(config, entry.provider) !== 'anthropic'
      // 「已填写但未验证的配置不能等同于可用连接」（CONTEXT.md）。快捷切换器守着这条线，
      // 而槽位是从整个池子里挑的——不在这里挡住，作者会拿一个从没连通过的渠道跑三版。
      const unverified = !isEntryVerified(config, entry)
      return {
        key: modelEntryKey(entry),
        label: `${entry.provider} · ${entry.modelId}`,
        disabled: wireUnsupported || unverified,
        reason: wireUnsupported ? '（OpenAI 兼容协议，润色暂不支持）' : unverified ? '（还没测试连接）' : '',
      }
    })
  }, [config])

  /**
   * 主力槽本身没通过连接测试时，「跟随主力模型」同样跑不起来——不置灰的话作者会挑一个
   * 看起来最安全的选项然后收到服务端拒绝。
   */
  const primaryUnverified = useMemo(() => {
    if (!config) return false
    const primary = config.modelPool.find((entry) => modelEntryKey(entry) === config.primaryModelKey)
    return primary ? !isEntryVerified(config, primary) : config.modelPool.length > 0
  }, [config])

  function updateRecipe(
    slotId: PolishSlotId,
    patch: Partial<Pick<PolishRecipe, 'prompt' | 'modelKey' | 'thinking'>>,
  ): void {
    setRecipes((current) => current.map((item) => (item.slotId === slotId ? { ...item, ...patch } : item)))
  }

  function persist(slotId: PolishSlotId, patch: Partial<Pick<PolishRecipe, 'prompt' | 'modelKey' | 'thinking'>>): void {
    const recipe = recipes.find((item) => item.slotId === slotId)
    if (!recipe) return
    const next = { ...recipe, ...patch }
    void savePolishRecipe({
      slotId,
      prompt: next.prompt,
      modelKey: next.modelKey,
      thinking: next.thinking,
    }).catch((error) => {
      console.error(error)
      toast.error('保存润色要求失败')
    })
  }

  function toggleSelected(slotId: PolishSlotId): void {
    setSelected((current) =>
      current.includes(slotId) ? current.filter((item) => item !== slotId) : [...current, slotId],
    )
  }

  function handleStandingChange(value: string): void {
    const slotId = value === 'off' ? null : (value as PolishSlotId)
    void setStandingPolishSlot({ projectPath, slotId })
      // 不发成功 toast（design.md：Toast 不做操作确认）——下拉框本身显示的就是当前状态。
      .then((settings) => setStandingSlot(settings.standingSlotId))
      .catch((error) => {
        console.error(error)
        toast.error('设置常驻失败')
      })
  }

  async function handleStart(): Promise<void> {
    const runnable = selected.filter((slotId) =>
      recipes.some((recipe) => recipe.slotId === slotId && recipe.prompt.trim()),
    )
    if (runnable.length === 0) {
      toast.error('先写一条润色要求再跑')
      return
    }

    setStarting(true)
    try {
      await start({ projectPath, chapter, slotIds: runnable, baselineText: originalText })
      onStarted(runnable)
      onOpenChange(false)
    } catch (error) {
      console.error(error)
      toast.error(error instanceof Error ? error.message : '润色没能跑起来')
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={POLISH_SETUP_DIALOG_CONTENT_CLASS} data-polish-setup-dialog="true">
        <DialogHeader className="shrink-0 border-b border-border px-6 pb-5 pt-6 text-left">
          <DialogTitle className="text-lg leading-tight">润色第 {chapter} 章</DialogTitle>
          <DialogDescription className="sr-only">
            为本章配置润色方案并开始润色，结果在正文页横向对比。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5">
          <p className="shrink-0 text-xs leading-5 text-muted-foreground">
            用你自己的要求改这一章的文字。改成什么样由你的要求决定；我只负责盯住人名、数字这些已经定下的事实。
            选中的方案会各出一版，跑完在正文页横向对比。
          </p>

          {/* 窄窗降成单栏：1320px 是给三栏并排的，窗口不够宽时硬排三栏每栏只剩一条缝。 */}
          <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3">
            {POLISH_SLOT_IDS.map((slotId) => {
              const recipe = recipes.find((item) => item.slotId === slotId)
              const checked = selected.includes(slotId)
              return (
                <div
                  key={slotId}
                  className={cn(
                    'flex min-h-0 flex-col rounded-row border p-3 transition-colors duration-200',
                    checked ? 'border-ring bg-active/40' : 'border-border',
                  )}
                >
                  <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-foreground">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelected(slotId)}
                      aria-label={`本轮跑${POLISH_SLOT_LABELS[slotId]}`}
                    />
                    {POLISH_SLOT_LABELS[slotId]}
                    {standingSlotId === slotId && <span className={METADATA_TEXT_CLASS}>常驻</span>}
                  </label>

                  <Textarea
                    className="mt-2 min-h-40 flex-1 resize-none bg-workspace text-sm"
                    value={recipe?.prompt ?? ''}
                    placeholder={PROMPT_PLACEHOLDER}
                    onChange={(event) => updateRecipe(slotId, { prompt: event.target.value })}
                    onBlur={() => persist(slotId, {})}
                  />

                  <Select
                    value={recipe?.modelKey ?? 'primary'}
                    onValueChange={(value) => {
                      const modelKey = value === 'primary' ? null : value
                      updateRecipe(slotId, { modelKey })
                      persist(slotId, { modelKey })
                    }}
                  >
                    <SelectTrigger className="mt-2 shrink-0 bg-workspace text-xs">
                      <SelectValue placeholder="跟随主力模型" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="primary" disabled={primaryUnverified}>
                        跟随主力模型
                        {primaryUnverified ? '（主力模型还没测试连接）' : ''}
                      </SelectItem>
                      {modelOptions.map((option) => (
                        <SelectItem key={option.key} value={option.key} disabled={option.disabled}>
                          {option.label}
                          {option.reason}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <label className="mt-2 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={recipe?.thinking ?? false}
                      onChange={(event) => {
                        updateRecipe(slotId, { thinking: event.target.checked })
                        persist(slotId, { thinking: event.target.checked })
                      }}
                    />
                    推理模式（更慢更贵，复杂要求可能更好）
                  </label>
                </div>
              )
            })}
          </div>
        </div>

        <DialogFooter className="shrink-0 items-center justify-between border-t border-border bg-active/40 px-6 py-4 sm:justify-between">
          <div className="flex items-center gap-2">
            <span className={METADATA_TEXT_CLASS}>写完新章自动润色</span>
            <Select value={standingSlotId ?? 'off'} onValueChange={handleStandingChange}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">关闭</SelectItem>
                {POLISH_SLOT_IDS.map((slotId) => (
                  <SelectItem key={slotId} value={slotId}>
                    {POLISH_SLOT_LABELS[slotId]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" onClick={() => void handleStart()} disabled={starting || selected.length === 0}>
            开始润色（{selected.length} 版）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useState, type ComponentProps, type FormEventHandler, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { AlertCircle, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DESTRUCTIVE_INLINE_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'
import { createNovelProject } from '@/lib/ipc'
import { useNovelStore } from '@/lib/novel-store'
import { reloadLibraryProjects } from '@/lib/use-novel-project'
import type { CreateNovelProjectInput } from '@shared/types/novel'

type ButtonProps = ComponentProps<typeof Button>

export const CREATE_NOVEL_INITIAL_GENRE = ''
/** 默认推荐档：先让作者拿到整章成品，再决定要不要把手伸回流程里（#27）。 */
export const CREATE_NOVEL_INITIAL_AUTOMATION_LEVEL: CreateNovelProjectInput['automationLevel'] = 'auto'
export const CREATE_NOVEL_TITLE_PLACEHOLDER = '输入小说标题'
export const CREATE_NOVEL_GENRE_PLACEHOLDER = '例如：仙侠、都市异能、悬疑推理'
export const CREATE_NOVEL_GENRE_HELP = '可以填写单一题材或复合题材，Agent 会据此调整后续问题。'
export const CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL = '协作模式'
export const CREATE_NOVEL_AUTOMATION_COLLABORATIVE_HELP =
  '关键节点先和你确认再继续：大纲分段生成、写作前过目。'
export const CREATE_NOVEL_AUTOMATION_AUTO_LABEL = '全自动'
export const CREATE_NOVEL_AUTOMATION_AUTO_HELP =
  '中途不再停下来问你：大纲和写作一口气跑完，适合想直接看结果。'

function Field({
  asLabel = true,
  children,
  className,
  label,
}: {
  asLabel?: boolean
  children: ReactNode
  className?: string
  label: string
}) {
  const classNames = `grid grid-cols-[84px_minmax(0,1fr)] items-start gap-4 py-3 text-xs font-medium text-muted-foreground ${className ?? ''}`

  if (!asLabel) {
    return (
      <div className={classNames}>
        <span className="pt-[11px] leading-none text-muted-foreground">{label}</span>
        {children}
      </div>
    )
  }

  return (
    <label className={classNames}>
      <span className="pt-[11px] leading-none text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function AutomationOption({
  active,
  children,
  onClick,
  recommended = false,
}: {
  active: boolean
  children: ReactNode
  onClick: () => void
  recommended?: boolean
}) {
  return (
    <button
      type="button"
      data-active={active}
      className="flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-hover hover:text-foreground active:scale-[0.97] data-[active=true]:bg-workspace data-[active=true]:text-foreground data-[active=true]:shadow-[var(--shadow-workspace)] data-[active=true]:hover:bg-workspace"
      onClick={onClick}
    >
      <span>{children}</span>
      {recommended && (
        <span
          data-create-novel-automation-recommended="true"
          className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-brand"
        >
          推荐
        </span>
      )}
    </button>
  )
}

export function buildCreatedNovelWorkbenchHref(projectPath: string): string {
  const params = new URLSearchParams({
    project: projectPath,
    section: 'settings',
    tab: 'bible-premise',
  })
  return `/workbench?${params.toString()}`
}

export function CreateNovelDialogPanel({
  automationLevel,
  creating,
  formError,
  genre,
  onAutomationLevelChange,
  onGenreChange,
  onSubmit,
  onTitleChange,
  title,
}: {
  automationLevel: CreateNovelProjectInput['automationLevel']
  creating: boolean
  formError: string | null
  genre: string
  onAutomationLevelChange: (value: CreateNovelProjectInput['automationLevel']) => void
  onGenreChange: (value: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  onTitleChange: (value: string) => void
  title: string
}) {
  return (
    <form onSubmit={onSubmit} data-create-novel-panel="true" className="grid">
      <DialogHeader className="border-b border-border px-6 pb-5 pt-6 text-left">
        <DialogTitle className="text-lg leading-tight">新建小说</DialogTitle>
        <DialogDescription className="sr-only">填写小说基础信息并创建项目。</DialogDescription>
      </DialogHeader>

      <div className="grid px-6 py-5">
        <p data-create-novel-foundation-note="true" className="text-xs leading-5 text-muted-foreground">
          先填写基础设定即可，小说详细设定后续会由 Agent 一起帮助你完成。
        </p>

        <div data-create-novel-fields="true" className="mt-3 grid">
          <Field label="标题">
            <Input
              className="h-9 rounded-row bg-workspace px-3 text-base"
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder={CREATE_NOVEL_TITLE_PLACEHOLDER}
            />
          </Field>

          <Field label="题材">
            <div className="grid gap-1.5">
              <Input
                data-create-novel-genre-input="true"
                className="h-9 rounded-row bg-workspace px-3"
                value={genre}
                onChange={(event) => onGenreChange(event.target.value)}
                placeholder={CREATE_NOVEL_GENRE_PLACEHOLDER}
              />
              <p data-create-novel-genre-help="true" className="text-xs font-normal leading-5 text-hint-foreground">
                {CREATE_NOVEL_GENRE_HELP}
              </p>
            </div>
          </Field>

          <Field label="自动化" asLabel={false}>
            <div className="grid gap-1.5">
              <div data-create-novel-automation="segmented" className="grid grid-cols-2 rounded-row bg-active p-1">
                <AutomationOption
                  active={automationLevel === 'auto'}
                  recommended
                  onClick={() => onAutomationLevelChange('auto')}
                >
                  {CREATE_NOVEL_AUTOMATION_AUTO_LABEL}
                </AutomationOption>
                <AutomationOption
                  active={automationLevel === 'collaborative'}
                  onClick={() => onAutomationLevelChange('collaborative')}
                >
                  {CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL}
                </AutomationOption>
              </div>
              <p data-create-novel-automation-help="true" className="text-xs font-normal leading-5 text-hint-foreground">
                {automationLevel === 'collaborative'
                  ? CREATE_NOVEL_AUTOMATION_COLLABORATIVE_HELP
                  : CREATE_NOVEL_AUTOMATION_AUTO_HELP}
              </p>
            </div>
          </Field>
        </div>

        {formError && (
          <div className={`${DESTRUCTIVE_INLINE_CLASS} mt-4 flex items-start gap-2 text-xs`}>
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{formError}</span>
          </div>
        )}
      </div>

      <DialogFooter className="border-t border-border bg-active/40 px-6 py-4">
        <Button type="submit" disabled={creating}>
          {creating && <Loader2 className="size-4 animate-spin" />}
          创建并打开
        </Button>
      </DialogFooter>
    </form>
  )
}

export function CreateNovelDialog({
  triggerClassName,
  triggerLabel = '新建',
  triggerSize = 'sm',
  triggerVariant = 'ghost',
}: {
  triggerClassName?: string
  triggerLabel?: string
  triggerSize?: ButtonProps['size']
  triggerVariant?: ButtonProps['variant']
} = {}) {
  const navigate = useNavigate()
  const creating = useNovelStore((state) => state.creating)
  const setNovelCreating = useNovelStore((state) => state.setNovelCreating)
  const setNovelError = useNovelStore((state) => state.setNovelError)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [genre, setGenre] = useState(CREATE_NOVEL_INITIAL_GENRE)
  const [automationLevel, setAutomationLevel] = useState(CREATE_NOVEL_INITIAL_AUTOMATION_LEVEL)
  const [formError, setFormError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!title.trim()) {
      setFormError('请输入小说标题。')
      return
    }
    if (!genre.trim()) {
      setFormError('请输入小说题材。')
      return
    }

    setFormError(null)
    setNovelError(null)
    setNovelCreating(true)

    try {
      const created = await createNovelProject({
        title: title.trim(),
        genre: genre.trim(),
        automationLevel,
      })
      await reloadLibraryProjects()
      setOpen(false)
      navigate(buildCreatedNovelWorkbenchHref(created.projectPath))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFormError(message)
      setNovelError(message)
    } finally {
      setNovelCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={triggerVariant}
          size={triggerSize}
          className={cn(triggerVariant === 'ghost' && 'text-foreground', triggerClassName)}
        >
          <Plus className="size-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="overflow-hidden bg-workspace p-0 sm:max-w-[560px]">
        <CreateNovelDialogPanel
          automationLevel={automationLevel}
          creating={creating}
          formError={formError}
          genre={genre}
          title={title}
          onAutomationLevelChange={setAutomationLevel}
          onGenreChange={setGenre}
          onSubmit={submit}
          onTitleChange={setTitle}
        />
      </DialogContent>
    </Dialog>
  )
}

import { BrandIllustration } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { EMPTY_PRIMARY_BODY_CLASS, EMPTY_PRIMARY_TITLE_CLASS, WORKBENCH_GUIDE_ACTION_CLASS } from '@/design-system'
import { WorkbenchGenerationAnimation } from './WorkbenchGenerationAnimation'
import type { WorkbenchGenerationState } from '@/lib/workbench-generation'

export function WorkbenchGenerationEmptyState({
  generationState,
  onAnswerQuestion,
}: {
  generationState: WorkbenchGenerationState
  onAnswerQuestion?: (questionRequestId: string) => void
}) {
  if (generationState.phase === 'waiting-user') {
    return <WorkbenchWaitingUserState generationState={generationState} onAnswerQuestion={onAnswerQuestion} />
  }

  return (
    <div
      className="flex h-full items-center justify-center"
      data-workbench-generation-empty="true"
    >
      <div className="mx-auto flex max-w-sm flex-col items-center text-center">
        <WorkbenchGenerationAnimation size="main" className="mb-5" />
        <h2 className="text-sm font-semibold text-foreground">{generationState.statusText}</h2>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">完成后会自动刷新当前页面。</p>
      </div>
    </div>
  )
}

/**
 * 等作者回答：Agent 已发问，活儿停在人这边。此刻不能显示生成动画（机器没在跑），
 * 更不能退回空态——那会让作者以为「点了没反应」而 Agent 在右侧干等。
 * 插图与右侧问题卡同用 agent-question，点按钮即滚到那张卡。
 */
function WorkbenchWaitingUserState({
  generationState,
  onAnswerQuestion,
}: {
  generationState: WorkbenchGenerationState
  onAnswerQuestion?: (questionRequestId: string) => void
}) {
  const pendingQuestion = generationState.pendingQuestion
  const canJump = Boolean(pendingQuestion && onAnswerQuestion)

  return (
    <div className="flex h-full items-center justify-center" data-workbench-generation-waiting="true">
      <div className="mx-auto flex max-w-sm flex-col items-center text-center">
        <BrandIllustration purpose="agent-question" size="lg" decorative className="mb-4" />
        <h2 className={EMPTY_PRIMARY_TITLE_CLASS}>{generationState.statusText}</h2>
        <p className={`mt-2 ${EMPTY_PRIMARY_BODY_CLASS}`}>
          {pendingQuestion?.prompt
            ? pendingQuestion.prompt
            : `回答后会继续${generationState.label}，问题在右侧对话里。`}
        </p>
        {canJump && (
          <Button
            type="button"
            size="lg"
            className={`mt-5 ${WORKBENCH_GUIDE_ACTION_CLASS}`}
            data-workbench-waiting-answer={pendingQuestion?.questionRequestId}
            onClick={() => pendingQuestion && onAnswerQuestion?.(pendingQuestion.questionRequestId)}
          >
            去回答
          </Button>
        )}
      </div>
    </div>
  )
}

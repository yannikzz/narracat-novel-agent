import type { TelemetryEvent, TelemetryModule } from '@shared/types/telemetry'
import type { RunTelemetryEvent } from '../agent/events/agent-main-side-effects.ts'
import { classifyRunFailure } from './failure-reason.ts'
import { isChapterWriteCommand, resolveRunModule } from './run-module.ts'
import { durationBucket, sizeBucket } from './telemetry.ts'

/**
 * 一次 run 该发哪些埋点事件——**纯函数，是这条链上所有判断的唯一落点**。
 *
 * 为什么单独成文件：`telemetry-runtime.ts` 依赖 electron 的 `app`（userData 路径、isPackaged），
 * 在单测里起不来，于是那里的分支此前**零覆盖**。变异实验证实过后果：把
 * `reason: classifyRunFailure(...)` 换成 `reason: event.failure?.error`（**原始错误文本直接
 * 发出去**，红线当场破），整套测试照样全绿——因为测试测的是自己复刻的一份逻辑，不是生产代码。
 *
 * 现在判断全在这里、runtime 只负责 await 与发送，测这个函数就等于测生产路径。
 *
 * 红线（ADR-0039）：返回的 props 里每个值都只可能是枚举常量或分桶名。`event.failure` 的原始
 * 错误文本只进 classifyRunFailure，它的返回值是枚举，**没有任何一个字符会出现在返回值里**。
 */
export interface RunTelemetryPlan {
  /** 要发的事件，按顺序。 */
  events: TelemetryEvent[]
  /** 需要补记 feature_used 的模块（去重与闸门在调用方，见 recordFeatureUsed）。 */
  featureUsed?: TelemetryModule
  /** 是否需要模型标识：只有写章节的两个事件用得上，其余 command 不必去读配置。 */
  needsModel: boolean
}

export function planRunTelemetry(
  event: RunTelemetryEvent,
  model: { provider: string; model_id: string },
): RunTelemetryPlan {
  const chapterWrite = isChapterWriteCommand(event.command)

  if (event.phase === 'started') {
    // 写章节之外的 command 在起点不发任何东西：它们的「用过一次」由 IPC 通道那条线负责
    // （见 ipc-modules.ts），这里重复记会把模块使用率抬成接近 100%。
    if (!chapterWrite) return { events: [], needsModel: false }
    return {
      events: [
        {
          event: 'chapter_write_started',
          props: { ...model, chapter_bucket: sizeBucket(event.chapter ?? 0) },
        },
      ],
      featureUsed: 'write-chapter',
      needsModel: true,
    }
  }

  const events: TelemetryEvent[] = []

  if (chapterWrite) {
    events.push({
      event: 'chapter_write_finished',
      props: { ...model, outcome: event.outcome, duration_bucket: durationBucket(event.durationMs) },
    })
  }

  if (event.outcome === 'failed') {
    // 原始错误到此为止：classifyRunFailure 只吐枚举码，props 里没有一个字来自它。
    events.push({
      event: 'error_occurred',
      props: {
        code: 'run-failed',
        module: resolveRunModule(event.command),
        reason: classifyRunFailure(event.failure ?? {}),
      },
    })
  }

  return { events, needsModel: chapterWrite }
}

/** 不需要读模型配置时的占位值，形态与 primaryModelLabel 的兜底一致。 */
export const UNKNOWN_MODEL = { provider: 'unknown', model_id: 'unknown' } as const

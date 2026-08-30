import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingsRow } from '@/components/settings/SettingsLayout'
import {
  getTelemetryState,
  resetTelemetryAnonymousId,
  revealTelemetryQueue,
  setTelemetryEnabled,
} from '@/lib/ipc'
import type { TelemetryState } from '@shared/types/telemetry'

/**
 * 匿名使用统计的设置项（ADR-0039）。
 *
 * 刻意不接进设置页那套「改完再点保存」的 config 流程：隐私开关必须**立刻生效**，
 * 让用户在关掉之后还要再找一个保存按钮，是把撤回的成本推给用户。
 * 关闭动作本身也在主进程里做（先发一条 opt_out 再关），渲染端只负责喊一声。
 */
export function TelemetryPanel() {
  const [state, setState] = useState<TelemetryState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getTelemetryState()
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  async function onToggle(enabled: boolean): Promise<void> {
    setBusy(true)
    try {
      setState(await setTelemetryEnabled(enabled))
      toast.success(enabled ? '已开启匿名使用统计' : '已关闭，并清空了本机待发数据')
    } catch {
      toast.error('设置没能保存，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function onResetId(): Promise<void> {
    setBusy(true)
    try {
      setState(await resetTelemetryAnonymousId())
      toast.success('已换成新的匿名 ID，此前的数据不再与本机关联')
    } catch {
      toast.error('重置没能完成，请重试')
    } finally {
      setBusy(false)
    }
  }

  const enabled = state?.enabled ?? false

  return (
    <>
      <SettingsRow
        title="匿名使用统计"
        description="只记录版本、哪个功能被打开过、写章节的成败与耗时区间；小说正文、标题、大纲、人物设定与 Key 永远不传。"
      >
        <div className="flex justify-end">
          <Switch
            checked={enabled}
            disabled={busy || state === null}
            aria-label="匿名使用统计"
            onCheckedChange={(checked) => void onToggle(checked)}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title="查看已发送的数据"
        description="待发队列是明文 JSON，可以自己打开逐条核对。"
      >
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void revealTelemetryQueue().catch(() => {})}
          >
            在文件夹中显示
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        title="重置匿名 ID"
        description={
          state?.anonymousId
            ? `当前 ID ${state.anonymousId.slice(0, 8)}…，与账号和设备指纹无关。重置后等同换了一台新机器。`
            : '尚未生成。数据只关联一个本机随机 ID，与账号和设备指纹无关。'
        }
      >
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void onResetId()}>
            重置
          </Button>
        </div>
      </SettingsRow>
    </>
  )
}

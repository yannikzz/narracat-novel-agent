import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { checkNetworkProxyUrl } from '@shared/lib/network-proxy'
import { SettingsActionRow, SettingsCard, SettingsRow } from './SettingsLayout'

/**
 * 设置页「模型服务」一级页底部的网络代理（issue #120）。留空 = 不使用代理；保存后下一次请求起生效，
 * 不用重启。校验口径与主进程同源（shared/lib/network-proxy）。
 */
export function NetworkProxyPanel({
  savedUrl,
  busy,
  saving,
  onSave,
}: {
  savedUrl: string
  busy: boolean
  saving: boolean
  onSave: (proxyUrl: string) => void
}) {
  const [draft, setDraft] = useState(savedUrl)
  useEffect(() => setDraft(savedUrl), [savedUrl])

  const checked = checkNetworkProxyUrl(draft)
  const unchanged = checked.ok && checked.url === savedUrl
  const status = !checked.ok
    ? checked.error
    : savedUrl
      ? `正在使用代理 ${savedUrl}`
      : '未使用代理'

  return (
    <SettingsCard>
      <SettingsRow title="网络代理" description="访问海外模型服务需要代理时填写；本机地址始终直连">
        <Input
          value={draft}
          disabled={busy}
          placeholder="http://127.0.0.1:7890"
          aria-label="代理地址"
          aria-invalid={!checked.ok || undefined}
          className="h-7 text-xs"
          onChange={(event) => setDraft(event.target.value)}
        />
      </SettingsRow>
      <SettingsActionRow status={<span data-network-proxy-status={checked.ok ? 'ok' : 'invalid'}>{status}</span>}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy || !checked.ok || unchanged}
          onClick={() => checked.ok && onSave(checked.url)}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          保存代理设置
        </Button>
      </SettingsActionRow>
    </SettingsCard>
  )
}

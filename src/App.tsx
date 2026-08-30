import { lazy, Suspense } from 'react'
import { HashRouter, Route, Routes } from 'react-router'
import { Toaster } from './components/ui/sonner.tsx'
import { TooltipProvider } from './components/ui/tooltip.tsx'
import { ResultNotificationOpenBridge } from './components/notifications/ResultNotificationOpenBridge.tsx'
import { ReleaseBlockedScreen } from './components/ReleaseBlockedScreen.tsx'
import { BrandLoading } from './components/brand/BrandLoading.tsx'
import { WorkLocationStartupGate } from './components/WorkLocationStartupGate.tsx'
import { useIntroGate } from './lib/use-intro-gate.ts'
import { useTelemetryNotice } from './lib/use-telemetry-notice.ts'
import { useReleaseGuard } from './lib/use-release-guard.ts'
import { useTheme } from './lib/theme.ts'
import { useAgentEventSubscription } from './lib/use-agent-events.ts'

const LibraryRoute = lazy(() => import('./routes/library.tsx').then((route) => ({ default: route.LibraryRoute })))
const WorkbenchRoute = lazy(() => import('./routes/workbench.tsx').then((route) => ({ default: route.WorkbenchRoute })))
const SettingsRoute = lazy(() => import('./routes/settings.tsx').then((route) => ({ default: route.SettingsRoute })))
// 首次介绍仅首启播一次，且携带 ogl/WebGL 重组件——懒加载，避免进每次启动的初始 chunk。
const FirstRunIntro = lazy(() =>
  import('./components/onboarding/FirstRunIntro.tsx').then((m) => ({ default: m.FirstRunIntro })),
)
// 埋点告知屏同样只在"还没确认过"时出现，懒加载避免进每次启动的初始 chunk。
const TelemetryNotice = lazy(() =>
  import('./components/onboarding/TelemetryNotice.tsx').then((m) => ({ default: m.TelemetryNotice })),
)

function MainApp() {
  // toast 主题跟随应用实际生效主题（深色门控期间恒为浅色），避免深色 OS 下 toast 露馅
  const { effectiveTheme } = useTheme()
  // Agent 事件订阅属于 App 生命周期；路由切换不能让后台 run 暂时失去 renderer 投影消费者。
  useAgentEventSubscription()

  return (
    <TooltipProvider>
      <HashRouter>
        <WorkLocationStartupGate>
          <Suspense fallback={<BrandLoading />}>
            <Routes>
              <Route path="/" element={<LibraryRoute />} />
              <Route path="/workbench" element={<WorkbenchRoute />} />
              <Route path="/settings" element={<SettingsRoute />} />
            </Routes>
          </Suspense>
        </WorkLocationStartupGate>
        <ResultNotificationOpenBridge />
        <Toaster position="bottom-right" richColors closeButton theme={effectiveTheme} />
      </HashRouter>
    </TooltipProvider>
  )
}

// 门控放行后：先读 introVersion，决定首次播介绍还是直接进首页。
function AllowedApp() {
  const intro = useIntroGate()

  if (intro.status === 'loading') {
    return <BrandLoading />
  }
  if (intro.status === 'intro') {
    return (
      <Suspense fallback={<BrandLoading />}>
        <FirstRunIntro onDone={intro.complete} />
      </Suspense>
    )
  }
  return <IntroducedApp />
}

// 介绍看完之后、进首页之前：匿名使用统计的告知屏（ADR-0039）。
// 存量用户没有介绍要看，会直接落在这一步——这正是"没告知就不埋"要覆盖的那批人。
function IntroducedApp() {
  const notice = useTelemetryNotice()

  if (notice.status === 'loading') {
    return <BrandLoading />
  }
  if (notice.status === 'notice') {
    return (
      <Suspense fallback={<BrandLoading />}>
        <TelemetryNotice onAccept={notice.accept} onDecline={notice.decline} />
      </Suspense>
    )
  }
  return <MainApp />
}

export function App() {
  const guard = useReleaseGuard()

  // 内测门控（#354）：判定出来前先不渲染应用，避免 kill / 过期 / 低版本窗口内仍能进入并触发 Agent 操作。
  if (guard.status === 'pending') {
    return <BrandLoading />
  }
  if (guard.status === 'blocked') {
    return <ReleaseBlockedScreen reason={guard.verdict.reason} notice={guard.verdict.notice} />
  }

  return <AllowedApp />
}

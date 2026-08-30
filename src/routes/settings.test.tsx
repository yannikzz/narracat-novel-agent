import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SettingsRoute } from './settings'
import { useNovelStore } from '@/lib/novel-store'
import { formatClientBuildVersion } from '../../scripts/client-build-version.mjs'

const EXPECTED_CLIENT_VERSION = formatClientBuildVersion(253)

globalThis.__NARRACAT_CLIENT_VERSION__ = EXPECTED_CLIENT_VERSION

function renderSettingsRoute(initialEntry: string): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <SettingsRoute />
      </MemoryRouter>
    </TooltipProvider>,
  )
}

function textFromDataRegion(html: string, attribute: string): string {
  const match = html.match(new RegExp(`<[^>]+${attribute}[^>]*>(.*?)</[^>]+>`))
  return match?.[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim() ?? ''
}

// 面包屑含嵌套标签（button/svg/span），textFromDataRegion 的首个闭合标签截断不适用，取整个 nav 区
function textFromBreadcrumb(html: string): string {
  const match = html.match(/<nav[^>]+data-settings-breadcrumb="true"[^>]*>([\s\S]*?)<\/nav>/)
  return match?.[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim() ?? ''
}

describe('SettingsRoute', () => {
  test('uses the same split shell as the novel workbench', () => {
    const html = renderSettingsRoute('/settings')

    expect(html).toContain('data-settings-layout="split"')
    expect(html).toContain('data-settings-sidebar="true"')
    expect(html).toContain('w-64')
    expect(html).toContain('data-settings-stage="true"')
    // 顶部 padding 消费 --titlebar-gutter-top（win32 上下分区：内容卡从 caption 带下开始）
    expect(html).toContain('min-h-0 min-w-0 flex-1 px-3 pb-3 pt-[max(0.75rem,var(--titlebar-gutter-top))]')
    expect(html).toContain('data-settings-content-shell="true"')
    expect(html).toContain('rounded-workspace border border-border bg-workspace')
    expect(html).toContain('data-settings-content-titlebar="true"')
    expect(textFromDataRegion(html, 'data-settings-content-titlebar="true"')).toBe('模型服务')
  })

  test('创作引擎切换卡已随双底座开关退役（拆旧刀5）：任何设置区不再渲染', () => {
    expect(renderSettingsRoute('/settings?section=model')).not.toContain('data-testid="agent-runtime-card"')
    expect(renderSettingsRoute('/settings?section=workspace')).not.toContain('data-testid="agent-runtime-card"')
  })

  test('renders only the selected settings group in the content area', () => {
    const html = renderSettingsRoute('/settings?section=workspace')

    expect(html).toContain('data-settings-page="workspace"')
    expect(textFromDataRegion(html, 'data-settings-content-titlebar="true"')).toBe('安全与项目')
    expect(html).toContain('小说根目录')
    expect(html).toContain('保存项目设置')
    expect(html).not.toContain('data-model-service-layout="progressive"')
    expect(html).not.toContain('Base URL 与 Claude SDK 模型映射')
    expect(html).not.toContain('跟随系统')
  })

  test('packs 二级视图：titlebar 切为面包屑（一级可点返回 + 当前二级名），内容区无返回按钮', () => {
    const guideHtml = renderSettingsRoute('/settings?section=packs&sub=guide')

    expect(guideHtml).toContain('data-settings-breadcrumb="true"')
    expect(textFromBreadcrumb(guideHtml)).toBe('能力包制作能力包')
    expect(guideHtml).toContain('data-pack-guide-view="true"')
    expect(guideHtml).not.toContain('返回包库')

    const detailHtml = renderSettingsRoute('/settings?section=packs&sub=pack:demo@1.0.0')
    expect(textFromBreadcrumb(detailHtml)).toBe('能力包包详情')

    // 无 sub 时 titlebar 保持 h1（面包屑不出现）
    const listHtml = renderSettingsRoute('/settings?section=packs')
    expect(listHtml).not.toContain('data-settings-breadcrumb="true"')
    expect(textFromDataRegion(listHtml, 'data-settings-content-titlebar="true"')).toBe('能力包')
  })

  test('packs 三级视图（learn/wizard 两进料器对称，T6 评审 Minor-4）：面包屑三级 能力包›我的创作›进料器名', () => {
    const learnHtml = renderSettingsRoute('/settings?section=packs&sub=learn')
    expect(textFromBreadcrumb(learnHtml)).toBe('能力包我的创作从书学写法')

    const wizardHtml = renderSettingsRoute('/settings?section=packs&sub=wizard')
    expect(textFromBreadcrumb(wizardHtml)).toBe('能力包我的创作作家向导')
  })

  test('renders the read-only Agent profile inspector', () => {
    const html = renderSettingsRoute('/settings?section=agents')

    expect(html).toContain('data-settings-page="agents"')
    expect(textFromDataRegion(html, 'data-settings-content-titlebar="true"')).toBe('Agent档案')
    expect(html).toContain('data-agent-profile-inspector="true"')
    expect(html).toContain('data-agent-profile-tabs="true"')
    expect(html).toContain('data-agent-profile-tab="outline-architect"')
    expect(html).toContain('data-agent-profile-tab="world-curator"')
    expect(html).toContain('data-agent-profile-tab="chapter-writer"')
    expect(html).toContain('data-agent-profile-tab="continuity-editor"')
    expect(html).toContain('data-agent-profile-tab="memory-keeper"')
    expect(html).toContain('outline-architect.webp')
    expect(html).toContain('world-curator.webp')
    expect(html).toContain('chapter-writer.webp')
    expect(html).toContain('continuity-editor.webp')
    expect(html).toContain('memory-keeper.webp')
    expect(html).toContain('大纲架构师')
    expect(html).toContain('世界观策展人')
    expect(html).toContain('章节写手')
    expect(html).toContain('审校编辑')
    expect(html).toContain('记忆管理员')
    expect(html).toContain('data-agent-profile-introduction="true"')
    expect(html).toContain('在大纲和上下文约束下生成章节正文')
    expect(html).toContain('边界是不改大纲、设定、审修报告或 NovelMemory')
    expect(html).not.toContain('data-agent-profile-inspector-notice="true"')
    expect(html).not.toContain('应用级只读视图')
    expect(html).not.toContain('当前版本不可查看、禁用或编辑')
    expect(html).not.toContain('data-agent-profile-info-list="true"')
    expect(html).not.toContain('能力边界')
    expect(html).not.toContain('内部职责')
    expect(html).not.toContain('原始 prompt')
    expect(html).not.toContain('创建 Skill')
    expect(html).not.toContain('role="switch"')
    expect(html).not.toContain('保存 Agent')
  })

  test('renders a system notification switch in the window settings group', () => {
    const html = renderSettingsRoute('/settings?section=window')

    expect(html).toContain('data-settings-page="window"')
    expect(textFromDataRegion(html, 'data-settings-content-titlebar="true"')).toBe('窗口')
    expect(html).toContain('后台任务完成时系统通知提醒')
    expect(html).toContain('App 不活跃时提醒成功、失败和等待确认')
    expect(html).toContain('role="switch"')
    expect(html).toContain('保存窗口设置')
  })

  test('shows NarraCat Agent Core diagnostics in the about section', () => {
    useNovelStore.getState().setDiagnostics({
      status: 'ready',
      agentCorePath: '/app/agent-core/narracat',
      name: 'narracat',
      version: '3.10.22',
      expectedVersion: '3.10.22',
      versionLock: {
        path: 'agent-core/narracat-agent-core.lock.json',
        name: 'narracat',
        version: '3.10.22',
        manifestPath: '.claude-plugin/plugin.json',
        updateCommand: 'bun --no-cache run prepare:narracat-agent-core -- --source <path>',
        checkCommand: 'bun --no-cache run verify:narracat-agent-core',
      },
      checks: [],
      errors: [],
    })

    const html = renderSettingsRoute('/settings?section=about')

    expect(html).toContain('data-settings-about-brand-story="true"')
    expect(html).toContain('narracat-about-banner.webp')
    // 「关于页用品牌横幅、不用 lockup」这条只管内容区：左栏 headbar 在 win32 上合法地
    // 挂着一枚 lockup（顶栏左上角的 logo + 应用名），整页扫描会把它误判成回归。
    const aboutPage = html.slice(html.indexOf('data-settings-page="about"'))
    expect(aboutPage).not.toContain('data-brand-lockup="true"')
    expect(html).toContain('故事生于人，成于智能。')
    expect(html).toContain('在人类文明中，故事一直来自人的记忆、情感与想象。')
    expect(html).toContain('从口述，到书写，再到数字时代')
    expect(html).toContain('在智能时代，创作不必再被时间与执行成本限制。')
    expect(html).toContain('NarraCat 让智能先理解你的所想')
    expect(html).toContain('我们不试图替代创作者，我们只希望—')
    expect(html).toContain('让更多故事，有机会被完成。')
    expect(html.indexOf('data-settings-about-brand-story="true"')).toBeLessThan(
      html.indexOf('data-settings-about-list="true"'),
    )
    expect(html).toContain('客户端版本')
    expect(html).toContain(EXPECTED_CLIENT_VERSION)
    expect(html).toContain('NarraCat Agent Core 版本')
    expect(html).toContain('3.10.22')
    expect(html).not.toContain('narracat 3.10.22')
    expect(html).toContain('作者')
    expect(html).toContain('Lumos Yannik')
    expect(html).toContain('官网')
    expect(html).toContain('href="https://narracat.com/"')
    expect(html).toContain('字体')
    expect(html).toContain('本软件使用')
    expect(html).toContain('MiSans 字体')
    expect(html).toContain('href="https://hyperos.mi.com/font/zh/download/"')
    expect(html).toContain('data-settings-about-diagnostics="true"')
    expect(html).toContain('Agent Core lock')
    expect(html).toContain('Agent Core path')
    // 拆旧刀5：headless runtime 探针诊断行随 claude-sdk 全链退役，不再渲染
    expect(html).not.toContain('Agent runtime path')
    expect(html).not.toContain('SDK CLI probe')
    // 向量体检卡保留（走 memory worker 通道）
    expect(html).toContain('向量语义检索')
    expect(html.indexOf('data-settings-about-diagnostics="true"')).toBeLessThan(
      html.indexOf('agent-core/narracat-agent-core.lock.json'),
    )
    expect(html.indexOf('data-settings-about-diagnostics="true"')).toBeLessThan(
      html.indexOf('/app/agent-core/narracat'),
    )
  })
})

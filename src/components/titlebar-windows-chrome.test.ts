import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

// Windows 顶栏走查（2026-08-30 真机）抓到两件事，这里各留一条守卫：
//   ① 顶部 56px caption 带拖不动、双击不最大化——win32「上下分区」布局把那条带做成了
//      父容器的 pt padding，而 padding 不带 -webkit-app-region:drag，于是成了死区。
//   ② 顶栏左上角空着——mac 那个位置归红绿灯，win32 上什么都没有，不符合 Windows 惯例
//      （logo + 应用名在标题栏左端）。
// 两件事都只在 Windows 上暴露（mac gutter 为 0、卡片通顶、卡片自身 header 就是 drag 区），
// 本机开发永远看不见，所以必须由守卫兜住。

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.test\.tsx?$/.test(entry.name)) continue
    files.push(full)
  }
  return files
}

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8')
}

describe('win32 caption 带可拖拽', () => {
  test('凡把 --titlebar-gutter-top 用作顶部 padding 的容器，都挂了 TitlebarDragGutter', () => {
    // 语义守卫（不钉某一行写法）：「让出 caption 带」与「那条带可拖」是同一件事的两半，
    // 新增页面只做前一半就会复活死区，且 mac 上无从发现。扫全部生产源码，谁让位谁补拖拽层。
    const offenders = listSourceFiles(SRC_DIR)
      .filter((file) => {
        const source = readFileSync(file, 'utf-8')
        return /p[tb]?-\[max\([^\]]*--titlebar-gutter-top/.test(source)
      })
      .filter((file) => !readFileSync(file, 'utf-8').includes('<TitlebarDragGutter />'))
      .map((file) => file.slice(SRC_DIR.length))

    expect(offenders).toEqual([])
  })

  test('拖拽层贴住容器顶部、高度等于 caption 带、声明 drag', () => {
    const source = read('./TitlebarDragGutter.tsx')

    expect(source).toContain('absolute inset-x-0 top-0')
    expect(source).toContain('h-[var(--titlebar-gutter-top)]')
    expect(source).toContain('[-webkit-app-region:drag]')
  })

  test('首启五幕顶条自带 drag（全屏覆盖层，不拖则整个首启期间窗口拖不动）', () => {
    const source = read('./onboarding/FirstRunIntro.tsx')
    const topBar = source.slice(source.indexOf('relative z-10 flex h-14 shrink-0'))

    expect(topBar.slice(0, 400)).toContain('[-webkit-app-region:drag]')
    // 「跳过」按钮必须反声明 no-drag，否则落在 drag 区里点不动。
    expect(topBar.slice(0, 900)).toContain('[-webkit-app-region:no-drag]')
  })
})

describe('win32 顶栏左上角品牌', () => {
  test('globals.css 定义了 win32 变体（缺了则所有 win32: 类静默失效）', () => {
    // Tailwind 对未定义变体的类不报错、直接不生成规则——品牌会永远停在 hidden，
    // 且只在 Windows 上表现为「左上角还是空的」。这条守卫是那次静默失效的唯一拦截点。
    const css = read('../styles/globals.css')

    expect(css).toContain('@custom-variant win32 (&:is([data-platform="win32"] *));')
  })

  test('工作台与设置左栏 headbar 在 win32 显示品牌，并给它留出左侧呼吸位', () => {
    for (const relative of [
      './workbench/WorkbenchPrimarySidebar.tsx',
      './settings/SettingsLayout.tsx',
    ]) {
      const source = read(relative)

      expect(source).toContain('win32:inline-flex')
      expect(source).toContain('<BrandLockup')
      // mac 仍让位红绿灯（112px），win32/linux 从 0 退回 0.75rem——不加 max 会让品牌贴死左缘。
      expect(source).toContain('pl-[max(0.75rem,var(--titlebar-inset-left))]')
      expect(source).not.toContain('pl-[var(--titlebar-inset-left)]')
    }
  })

  test('图书馆品牌两平台各一份：mac 居中、win32 靠左，互斥显示', () => {
    const source = read('../routes/library.tsx')

    expect(source).toContain('navStart={<LibraryNavBrand className="hidden [-webkit-app-region:drag] win32:inline-flex" />}')
    expect(source).toContain('navCenter={<LibraryNavBrand className="win32:hidden" />}')
  })
})

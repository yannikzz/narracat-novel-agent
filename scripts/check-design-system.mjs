// 设计系统守卫：契约存在性 + 禁用写法 + 品牌资产收口 + 字号刻度。
//
// 跨平台纪律（#24）：本脚本内部一律用 POSIX 路径（正斜杠）与 LF 行尾。
// Windows 上 `relative()` 返回反斜杠，曾让品牌资产白名单的 `Set.has()` 恒 false，
// 三个合规包装器（BrandMark/BrandStoryBanner/brand-illustrations）被当成违规 → 守卫恒红；
// `core.autocrlf=true` 检出的 CRLF 同样会让跨行子串契约匹配不上。两者都在 mac 上永远看不见，
// 所以路径归一化走 toPosixPath()、读文件走 readText()，并由 allowlistCoverageFailure()
// 在白名单落空时 fail loud——不许再退化成一条「某个平台恒红」的守卫。
//
// 用法：node scripts/check-design-system.mjs（退出码 1 = 有违规）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 路径归一化为 POSIX 分隔符（导出供测试）。 */
export function toPosixPath(path) {
  return path.replaceAll('\\', '/')
}

/** 行尾归一化为 LF（导出供测试）。 */
export function normalizeLineEndings(text) {
  return text.replaceAll('\r\n', '\n')
}

function readText(path) {
  return normalizeLineEndings(readFileSync(path, 'utf8'))
}

// 必须存在的契约：[文件, 必须出现的子串]。待读文件清单由本表推导（见 main），
// 不再手写第二份——两份清单人工同步，漏一条就是 `undefined.includes` 崩栈。
const requiredContracts = [
  ['docs/design.md', '浮动工作台，而不是平铺后台'],
  ['docs/design.md', 'Active 不被 Hover 覆盖'],
  ['docs/design.md', 'Logo 通过 `BrandMark` 以原始图片直接展示'],
  ['docs/design.md', '不额外包裹装饰容器'],
  ['docs/design.md', '浅色和暗色模式使用同一张 `narracat-mark.webp`'],
  ['docs/design.md', 'Workbench 使用固定 px 侧栏 + 流式内容区'],
  ['docs/design.md', 'Workbench 内容生命周期'],
  ['docs/design.md', '生成类 Markdown 产物统一进入 reading canvas'],
  ['docs/design.md', '文本框选色'],
  ['docs/design.md', '拖动过程中只更新 grid style'],
  ['docs/design.md', '透明轨道、`10px` 视觉占位'],
  ['docs/agents/workflow.md', '品牌资产'],
  ['docs/agents/workflow.md', 'src/components/brand/README.md'],
  ['src/styles/globals.css', '--color-workspace'],
  ['src/styles/globals.css', '--color-hover'],
  ['src/styles/globals.css', '--color-active'],
  ['src/styles/globals.css', '--color-text-selection'],
  ['src/styles/globals.css', '--text-selection'],
  ['src/styles/globals.css', '--shadow-selection-toolbar'],
  ['src/styles/globals.css', 'background: var(--text-selection)'],
  ['src/styles/globals.css', '--color-brand'],
  ['src/styles/globals.css', '--brand: #04c853'],
  ['src/styles/globals.css', '--brand-soft'],
  ['src/styles/globals.css', 'slide-up-fade'],
  ['src/styles/globals.css', 'scrollbar-color: var(--border) transparent'],
  ['src/styles/globals.css', '::-webkit-scrollbar-thumb:hover'],
  ['src/design-system/surfaces.ts', 'WORKSPACE_SHELL_CLASS'],
  ['src/design-system/surfaces.ts', 'WORKBENCH_GUIDE_ACTION_CLASS'],
  ['src/design-system/surfaces.ts', 'WORKBENCH_READING_CANVAS_CLASS'],
  ['src/design-system/surfaces.ts', 'SIDEBAR_ROW_CLASS'],
  ['src/design-system/surfaces.ts', 'WORKBENCH_RESIZE_HANDLE_CLASS'],
  ['src/design-system/surfaces.ts', 'data-[active=true]:hover:bg-active'],
  ['docs/design.md', '字号角色契约'],
  ['docs/design.md', 'Typography 漂移治理'],
  ['docs/design.md', '剩余可接受债务'],
  ['src/design-system/typography.ts', 'EMPTY_PRIMARY_TITLE_CLASS'],
  ['src/design-system/typography.ts', 'AGENT_BODY_CLASS'],
  ['src/design-system/typography.ts', 'text-[15px]'],
  ['src/components/workbench/WorkbenchEmptyState.tsx', 'EMPTY_PRIMARY_TITLE_CLASS'],
  ['src/components/workbench/WorkbenchEmptyGuide.tsx', 'EMPTY_PRIMARY_TITLE_CLASS'],
  ['src/components/workbench/MarkdownRenderer.tsx', 'AGENT_BODY_CLASS'],
  ['src/components/workbench/agent/AgentQuestionCard.tsx', 'AGENT_QUESTION_OPTION_CLASS'],
  ['src/components/ui/button.tsx', 'active:scale-[0.97]'],
  ['src/components/AppShell.tsx', 'APP_HEADER_CLASS'],
  ['src/components/brand/BrandMark.tsx', 'narracat-mark.webp'],
  ['src/components/brand/BrandMark.tsx', 'data-brand-mark="true"'],
  ['src/components/brand/BrandLockup.tsx', 'BrandMark'],
  ['src/components/brand/BrandLockup.tsx', 'data-brand-lockup="true"'],
  ['src/components/brand/BrandIllustration.tsx', 'getBrandIllustration'],
  ['src/components/brand/BrandIllustration.tsx', 'data-brand-illustration'],
  ['src/components/brand/BrandStoryBanner.tsx', 'narracat-about-banner.webp'],
  ['src/components/brand/BrandStoryBanner.tsx', 'data-brand-story-banner'],
  ['src/components/brand/brand-illustrations.ts', 'BRAND_ILLUSTRATION_PURPOSES'],
  [
    'src/components/brand/brand-illustrations.ts',
    'Record<BrandIllustrationPurpose, BrandIllustrationAsset>',
  ],
  ['src/components/brand/index.ts', 'export { BrandMark }'],
  ['src/components/brand/index.ts', 'export { BrandLockup }'],
  ['src/components/brand/index.ts', 'export { BrandIllustration }'],
  ['src/components/brand/index.ts', 'export { BrandStoryBanner }'],
  ['src/components/brand/README.md', '不要直接 import'],
  ['src/components/brand/README.md', 'docs/design.md'],
]

const forbidden = [
  [/text-(blue|purple|green|orange|red|gray|slate)-\d/, 'use semantic text tokens instead of hardcoded palette classes'],
  [/bg-(blue|purple|green|orange|red|gray|slate)-\d/, 'use semantic background tokens instead of hardcoded palette classes'],
  [/shadow-(sm|md|lg|xl|2xl)/, 'use approved low-opacity product shadow tokens'],
  [/active:translate-y-px/, 'pressed state must use scale, not vertical translation'],
  [/var\(--(bg-|fg-|control|sidebar|stage|app-chrome|border-subtle|border-hairline|accent-surface|color-accent)/, 'use design-system semantic tokens/classes instead of legacy visual variables'],
]

const offScaleFontSizeGuards = [
  [/text-\[13px\]/, 'off-scale font size; use the typography scale or a registered typography role'],
  [/text-\[17px\]/, 'off-scale font size; use the typography scale or a registered typography role'],
]

const rawBrandAssetDirectories = ['assets/brand/', 'assets/illustrations/narracat/']
const directBrandAssetPattern = new RegExp(
  rawBrandAssetDirectories.map((directory) => escapeRegExp(directory)).join('|'),
)

/** 允许直接引用原始品牌资产的合规包装器（POSIX 路径）。 */
export const BRAND_ASSET_ALLOWLIST = [
  'src/components/brand/BrandMark.tsx',
  'src/components/brand/BrandStoryBanner.tsx',
  'src/components/brand/brand-illustrations.ts',
]

/**
 * 白名单覆盖自检（导出供测试）：白名单条目必须真的出现在扫描结果里。
 * 落空只有两种可能——文件搬迁/改名，或路径形态对不上（Windows 反斜杠，即 #24 的根因）；
 * 两种都会让白名单静默失效，让守卫在合规文件上恒红，必须 fail loud 而不是让人去猜。
 * @param {string[]} scannedFiles 扫描到的文件路径
 * @param {string[]} allowlist 白名单
 * @returns {string | null} 错误文案；null = 覆盖正常
 */
export function allowlistCoverageFailure(scannedFiles, allowlist = BRAND_ASSET_ALLOWLIST) {
  const scanned = new Set(scannedFiles.map(toPosixPath))
  const missing = allowlist.filter((file) => !scanned.has(file))
  if (missing.length === 0) return null
  return `check-design-system: 品牌资产白名单有 ${missing.length} 条未出现在扫描结果里（${missing.join('、')}）——文件搬迁了，或路径形态对不上（Windows 反斜杠？），白名单已形同虚设，先修白名单/扫描范围。`
}

/**
 * 是否生产源码（导出供测试）：测试文件豁免字号与品牌资产守卫——它们会写
 * `text-[13px]` 之类的负向断言，扫进来就是误伤。
 * @param {string} path 文件路径
 * @returns {boolean}
 */
export function isProductionSource(path) {
  return !/\.test\.(ts|tsx)$/.test(toPosixPath(path))
}

/**
 * 收集字号刻度违规（导出供测试）。
 * @param {{ files: Array<{ path: string, content: string }> }} input
 * @returns {Array<{ file: string, message: string, pattern: RegExp }>}
 */
export function collectOffScaleFontSizeViolations({ files }) {
  const violations = []
  for (const file of files) {
    if (!isProductionSource(file.path)) continue
    for (const [pattern, message] of offScaleFontSizeGuards) {
      if (pattern.test(file.content)) {
        violations.push({ file: toPosixPath(file.path), message, pattern })
      }
    }
  }
  return violations
}

/**
 * 收集品牌资产违规（导出供测试）。
 * @param {{ files: Array<{ path: string, content: string }>, allowlist?: string[] }} input
 * @returns {string[]} 违规文件路径（POSIX）
 */
export function collectBrandAssetViolations({ files, allowlist = BRAND_ASSET_ALLOWLIST }) {
  const allowed = new Set(allowlist.map(toPosixPath))
  const violations = []
  for (const file of files) {
    const path = toPosixPath(file.path)
    if (allowed.has(path)) continue
    if (directBrandAssetPattern.test(file.content)) violations.push(path)
  }
  return violations
}

function main() {
  const requiredFiles = {}
  for (const [file] of requiredContracts) {
    if (!(file in requiredFiles)) requiredFiles[file] = readText(file)
  }

  for (const [file, needle] of requiredContracts) {
    if (!requiredFiles[file].includes(needle)) {
      console.error(`${file} is missing required design-system contract: ${needle}`)
      process.exit(1)
    }
  }

  // src/dev 是 dev-only 调试工具（生产不打包），不属于产品 UI，豁免设计系统守卫。
  const sourceFiles = listFiles('src').filter(
    (file) => /\.(css|ts|tsx)$/.test(file) && !/^src\/dev\//.test(file),
  )

  // 每个文件只读一次，三道守卫共用同一份内容。
  const sources = sourceFiles.map((path) => ({ path, content: readText(path) }))

  for (const { path, content } of sources) {
    for (const [pattern, message] of forbidden) {
      if (pattern.test(content)) {
        console.error(`${path} violates design-system guard: ${message} (${pattern})`)
        process.exit(1)
      }
    }
  }

  const productionSources = sources.filter(({ path }) => isProductionSource(path))

  const coverageFailure = allowlistCoverageFailure(productionSources.map(({ path }) => path))
  if (coverageFailure) {
    console.error(coverageFailure)
    process.exit(1)
  }

  const brandAssetViolations = collectBrandAssetViolations({ files: productionSources })
  if (brandAssetViolations.length > 0) {
    for (const file of brandAssetViolations) {
      console.error(
        `${file} violates brand asset guard: use BrandMark/BrandLockup/BrandIllustration instead of importing raw brand assets`,
      )
    }
    process.exit(1)
  }

  const offScaleViolations = collectOffScaleFontSizeViolations({ files: productionSources })
  if (offScaleViolations.length > 0) {
    for (const { file, message, pattern } of offScaleViolations) {
      console.error(`${file} violates typography scale guard: ${message} (${pattern})`)
    }
    process.exit(1)
  }

  console.log('Design-system contracts present.')
}

function listFiles(root) {
  const results = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      results.push(...listFiles(path))
    } else {
      results.push(toPosixPath(relative('.', path)))
    }
  }
  return results
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ESM 主模块判断走 pathToFileURL（仓内惯例）：文件名后缀判断会把 not-check-design-system.mjs
// 之类的导入者也当成 CLI 入口，裸 `file://${process.argv[1]}` 则在路径含空格/软链时静默失效。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

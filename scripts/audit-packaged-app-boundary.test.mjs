import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertPackagedLocalesPresent,
  auditAsarEntries,
  auditPackagedResourceEntries,
  classifyAsarEntry,
  classifyPackagedResourceEntry,
  normalizeAsarEntry,
  resolvePackagedAppPath,
  resolvePackagedAsarPath,
  resolvePackagedLayout,
} from './audit-packaged-app-boundary.mjs'
import { resolveNativeTarget } from './stage-narracat-agent-core.mjs'

describe('packaged app.asar boundary audit', () => {
  // 显式钉 darwin：本组断言的是「mac 产物边界」，与测试跑在哪台机器上无关。
  // 省略 target 会走 resolveNativeTarget(process.platform)，在 Linux CI runner 上
  // fail-loud（linux 不是分发目标）——那是 runner 平台泄漏进断言。
  const target = resolveNativeTarget('darwin')

  test('allows only runtime top-level entries', () => {
    const report = auditAsarEntries([
      '/package.json',
      '/out/main/index.js',
      '/out/preload/index.cjs',
      '/out/renderer/index.html',
      '/node_modules/keytar/package.json',
      '/node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
      '/node_modules/hono/dist/tsconfig.build.tsbuildinfo',
    ])

    expect(report).toEqual({
      ok: true,
      entryCount: 7,
      violations: [],
    })
  })

  test('rejects development directories and repository metadata', () => {
    const report = auditAsarEntries([
      '/src/App.tsx',
      '/electron/main/index.ts',
      '/docs/adr/0001-app-orchestrates-narracat-plugin.md',
      '/agent-core/narracat/commands/write.md',
      '/corpus-factory-data/normalized/books.index.json',
      '/workers/release-guard/src/index.ts',
      '/.agents/skills/narracat-ops/SKILL.md',
      '/.env.example',
      '/tsconfig.web.tsbuildinfo',
    ])

    expect(report.ok).toBe(false)
    expect(report.violations.map((violation) => violation.path)).toEqual([
      'src/App.tsx',
      'electron/main/index.ts',
      'docs/adr/0001-app-orchestrates-narracat-plugin.md',
      'agent-core/narracat/commands/write.md',
      'corpus-factory-data/normalized/books.index.json',
      'workers/release-guard/src/index.ts',
      '.agents/skills/narracat-ops/SKILL.md',
      '.env.example',
      'tsconfig.web.tsbuildinfo',
    ])
  })

  test('rejects unexpected top-level files even when not explicitly blacklisted', () => {
    expect(classifyAsarEntry('/LICENSE')).toEqual({
      ok: false,
      path: 'LICENSE',
      reason: 'unexpected top-level app.asar entry: LICENSE',
    })
  })

  test('rejects source maps inside build output', () => {
    expect(classifyAsarEntry('/out/main/index.js.map')).toEqual({
      ok: false,
      path: 'out/main/index.js.map',
      reason: 'renderer/main source maps must not be packaged in app.asar',
    })
  })

  test('rejects staged Agent Core runtime development payloads', () => {
    const report = auditPackagedResourceEntries([
      'NarraCatAgentCore/mcp-server/node_modules/onnxruntime-web/package.json',
      'NarraCatAgentCore/mcp-server/dist/handlers/readers.d.ts',
      'NarraCatAgentCore/mcp-server/node_modules/zod/README.md',
      'NarraCatAgentCore/mcp-server/node_modules/@huggingface/transformers/dist/transformers.node.mjs.map',
      'NarraCatAgentCore/mcp-server/node_modules/@scope/pkg/examples/demo.js',
      'NarraCatAgentCore/mcp-server/src/index.ts',
      'NarraCatAgentCore/docs/adr/0026-staged-distribution-for-internal-test-and-beta.md',
      'fr.lproj',
    ], target)

    expect(report.ok).toBe(false)
    expect(report.violations.map((violation) => violation.path)).toEqual([
      'NarraCatAgentCore/mcp-server/node_modules/onnxruntime-web/package.json',
      'NarraCatAgentCore/mcp-server/dist/handlers/readers.d.ts',
      'NarraCatAgentCore/mcp-server/node_modules/zod/README.md',
      'NarraCatAgentCore/mcp-server/node_modules/@huggingface/transformers/dist/transformers.node.mjs.map',
      'NarraCatAgentCore/mcp-server/node_modules/@scope/pkg/examples/demo.js',
      'NarraCatAgentCore/mcp-server/src/index.ts',
      'NarraCatAgentCore/docs/adr/0026-staged-distribution-for-internal-test-and-beta.md',
      'fr.lproj',
    ])
  })

  test('allows staged Agent Core runtime files and selected Electron locales', () => {
    const report = auditPackagedResourceEntries([
      'NarraCatAgentCore/.claude-plugin/plugin.json',
      'NarraCatAgentCore/commands/write.md',
      'NarraCatAgentCore/skills/novel-style-reference/SKILL.md',
      'NarraCatAgentCore/docs/contracts/world-guided.md',
      'NarraCatAgentCore/mcp-server/dist/index.js',
      'NarraCatAgentCore/mcp-server/node_modules/onnxruntime-node/package.json',
      'NarraCatAgentCore/mcp-server/node_modules/zod/LICENSE.md',
      'NarraCatAgentCore/mcp-server/node_modules/foo/src/runtime.js',
      'en.lproj',
      'zh_CN.lproj',
    ], target)

    expect(report).toEqual({
      ok: true,
      entryCount: 10,
      violations: [],
    })
  })

  test('classifies unexpected Electron locales explicitly', () => {
    expect(classifyPackagedResourceEntry('/zh_TW.lproj', target)).toEqual({
      ok: false,
      path: 'zh_TW.lproj',
      reason: 'unexpected Electron locale resource: zh_TW.lproj',
    })
  })

  test('打包后审计拦下混入的非目标平台二进制', () => {
    const base = 'NarraCatAgentCore/mcp-server/node_modules/onnxruntime-node/bin/napi-v3'
    expect(classifyPackagedResourceEntry(`${base}/darwin/arm64/onnxruntime_binding.node`, target).ok).toBe(true)
    expect(classifyPackagedResourceEntry(`${base}/linux/x64/onnxruntime_binding.node`, target).ok).toBe(false)
    expect(classifyPackagedResourceEntry(`${base}/win32/x64/onnxruntime_binding.node`, target).ok).toBe(false)
    expect(classifyPackagedResourceEntry(`${base}/darwin/x64/onnxruntime_binding.node`, target).ok).toBe(false)
  })

  test('resolves the default packaged app.asar path', () => {
    // 「default」指的是没有 --app 覆盖时的默认产物路径，不是「默认平台」——
    // 平台显式钉 darwin，否则在 Linux CI runner 上解析目标平台时 fail-loud。
    const mac = ['--platform', 'darwin']
    expect(resolvePackagedAppPath(mac, '/repo')).toBe(join('/repo', 'dist', 'mac-arm64', 'NarraCat.app'))
    expect(resolvePackagedAsarPath(mac, '/repo')).toBe(
      join('/repo', 'dist', 'mac-arm64', 'NarraCat.app', 'Contents', 'Resources', 'app.asar'),
    )
    expect(resolvePackagedAsarPath([...mac, '--app', 'dist/custom/NarraCat.app'], '/repo')).toBe(
      join('/repo', 'dist', 'custom', 'NarraCat.app', 'Contents', 'Resources', 'app.asar'),
    )
    expect(resolvePackagedAsarPath(['--asar=dist/app.asar'], '/repo')).toBe(join('/repo', 'dist', 'app.asar'))
  })
})

describe('asar 条目路径分隔符归一化（Windows 战役 2026-08-18 CI 实撞）', () => {
  // @electron/asar 在 Windows 上返回反斜杠路径。不归一化的话按 '/' 切分会把
  // 整条路径当成一个「顶层条目」，于是**每一条**都判违规——实测 29246 条全红，
  // 而 mac 上完全正常。这类问题只在 Windows 出现，本机跑测试永远发现不了。
  test('反斜杠路径归一化成正斜杠', () => {
    expect(normalizeAsarEntry('\\node_modules\\@anthropic-ai\\sdk\\core\\resource.mjs')).toBe(
      'node_modules/@anthropic-ai/sdk/core/resource.mjs',
    )
    expect(normalizeAsarEntry('\\out\\main\\index.js')).toBe('out/main/index.js')
  })

  test('Windows 反斜杠条目按正常规则分类，不再被误判为顶层违规', () => {
    expect(classifyAsarEntry('\\node_modules\\keytar\\package.json')).toEqual({
      ok: true,
      path: 'node_modules/keytar/package.json',
    })
    expect(classifyAsarEntry('\\out\\main\\index.js').ok).toBe(true)
  })

  test('正斜杠路径行为不变（mac 回归）', () => {
    expect(normalizeAsarEntry('/node_modules/keytar/package.json')).toBe('node_modules/keytar/package.json')
    expect(normalizeAsarEntry('pack: /out/main/index.js')).toBe('out/main/index.js')
  })

  test('资源条目同样归一化（extraResources 走同一个谓词）', () => {
    const winTarget = resolveNativeTarget('win32')
    expect(
      classifyPackagedResourceEntry(
        '\\NarraCatAgentCore\\mcp-server\\node_modules\\onnxruntime-node\\bin\\napi-v3\\darwin\\arm64\\onnxruntime_binding.node',
        winTarget,
      ).ok,
    ).toBe(false)
  })
})

describe('打包布局按平台解析（Windows 战役）', () => {
  // 期望值全部照实测的 mac 产物写死（2026-08-18，dist/mac-arm64/NarraCat.app）：
  // Contents/Resources/{en,zh_CN}.lproj 是**空目录**——那是 macOS 的语言声明标记，
  // 拿它当「locale 就绪」的判据会永远误判为通过。真正的 locale.pak 在 Electron
  // Framework 内部，且用 Apple 的下划线惯例（zh_CN / en），与 package.json 的
  // mac electronLanguages 精确对应。
  test('mac 与 win 各自的 app 路径 / 资源目录 / locale 目录', () => {
    expect(resolvePackagedLayout('darwin')).toEqual({
      appPath: join('dist', 'mac-arm64', 'NarraCat.app'),
      resourcesDir: join('Contents', 'Resources'),
      localesDir: join('Contents', 'Frameworks', 'Electron Framework.framework', 'Resources'),
      localeFiles: [join('zh_CN.lproj', 'locale.pak'), join('en.lproj', 'locale.pak')],
    })
    expect(resolvePackagedLayout('win32')).toEqual({
      appPath: join('dist', 'win-unpacked'),
      resourcesDir: 'resources',
      localesDir: 'locales',
      localeFiles: ['zh-CN.pak', 'en-US.pak'],
    })
  })

  test('不支持的平台 fail-loud', () => {
    expect(() => resolvePackagedLayout('linux')).toThrow(/不支持的打包目标平台/)
  })

  test('locale 文件缺失时 fail-loud（issue #3 的真守卫）', async () => {
    const layout = resolvePackagedLayout('win32')
    const appPath = await mkdtemp(join(tmpdir(), 'narracat-audit-win-'))
    try {
      await mkdir(join(appPath, 'locales'), { recursive: true })
      // 空 locales 目录 = issue #3 的现场
      await expect(assertPackagedLocalesPresent(appPath, layout)).rejects.toThrow(/locale/)
      await writeFile(join(appPath, 'locales', 'zh-CN.pak'), 'x')
      await expect(assertPackagedLocalesPresent(appPath, layout)).rejects.toThrow(/en-US\.pak/)
      await writeFile(join(appPath, 'locales', 'en-US.pak'), 'x')
      await assertPackagedLocalesPresent(appPath, layout)
    } finally {
      await rm(appPath, { recursive: true, force: true })
    }
  })

  test('资源分类按目标平台判定外来平台二进制', () => {
    const base = 'NarraCatAgentCore/mcp-server/node_modules/onnxruntime-node/bin/napi-v3'
    const winTarget = resolveNativeTarget('win32')
    expect(classifyPackagedResourceEntry(`${base}/win32/x64/onnxruntime_binding.node`, winTarget).ok).toBe(true)
    expect(classifyPackagedResourceEntry(`${base}/darwin/arm64/onnxruntime_binding.node`, winTarget).ok).toBe(false)
  })

  test('resolvePackagedAppPath / AsarPath 按 --platform 给出对应布局', () => {
    expect(resolvePackagedAppPath(['--platform', 'win32'], '/repo')).toBe(join('/repo', 'dist', 'win-unpacked'))
    expect(resolvePackagedAsarPath(['--platform', 'win32'], '/repo')).toBe(
      join('/repo', 'dist', 'win-unpacked', 'resources', 'app.asar'),
    )
  })
})

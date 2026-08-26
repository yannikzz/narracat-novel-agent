import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import {
  assertBundledOnnxRuntimeNativeBinaryPresent,
  FORBIDDEN_RELATIVE_PATHS,
  findFirstStagedRuntimePayloadViolation,
  hasPrunedMcpNodeModuleDirectory,
  pruneStagedMcpRuntimePayload,
  resolveNativeTarget,
  resolveNativeTargetFromArgv,
  shouldBundleAgentCorePath,
  shouldPruneForeignPlatformBinary,
  shouldPruneMcpDistFile,
  shouldPruneMcpNodeModuleDirectory,
  shouldPruneMcpNodeModuleFile,
} from './stage-narracat-agent-core.mjs'

describe('NarraCat Agent Core 打包白名单', () => {
  // 显式钉目标平台：本组断言测的是「白名单规则」，平台裁剪只是被顺带触发的一环。
  // 省略它会走 resolveNativeTarget(process.platform)，在 Linux CI runner 上 fail-loud
  //（linux 不是分发目标）——那是 runner 平台泄漏进断言，与被测行为无关。
  const target = resolveNativeTarget('darwin')

  test('保留运行时真正引用的内部资源', () => {
    const keep = [
      'narracat.manifest.json',
      'package.json',
      'agents/chapter-writer.md',
      'commands/write.md',
      'schemas/ReviewReport.json',
      'templates/premise-template.md',
      'skills/novel-web-craft/SKILL.md',
      // 真人范例语料已迁往官方只读语料服务（私有仓），不再随包分发（2026-08-05）
      'skills/novel-style-reference/SKILL.md',
      'docs/contracts/world-guided.md',
      'mcp-server/package.json',
      'mcp-server/dist/index.js',
      'mcp-server/node_modules/better-sqlite3/package.json',
      // 能力包发现根（pack-resolver 相对 dist 回溯至此，B2 第一刀，ADR-0034）
      'packs/official-base/pack.json',
      // 造包中心预览资产（T1 评审后从 packs/authoring 迁至此，防复发误落入 pack-resolver 扫描根；刀3）
      'mcp-server/authoring/typical-scenarios.json',
      'mcp-server/authoring/typical-voices.json',
    ]
    for (const rel of keep) {
      expect({ rel, keep: shouldBundleAgentCorePath(rel, target) }).toEqual({ rel, keep: true })
    }
  })

  test('挡掉研发痕迹与非运行时文件', () => {
    const drop = [
      'CHANGELOG.md',
      'CLAUDE.md',
      'CONTEXT.md',
      'README.md',
      // 死配置已删（阶段2切片④）：narracat.manifest.json 是自有契约 SSOT，MCP 由 App 层显式配置，不再随包外发
      '.mcp.json',
      // claude-sdk 适配器工件已随 SDK 退役（拆旧刀5）：plugin.json 不再入包
      '.claude-plugin/plugin.json',
      '.claude-plugin',
      // shell 钩子已整目录删除（钩子判据 TS 化在 App 侧）：hooks/ 若复现也不入包
      'hooks/hooks.json',
      'hooks/scripts/check-chapter-wordcount.sh',
      'hooks',
      '.gitignore',
      '.DS_Store',
      'eval/_runs/run-x/drafts/fixture-01.md',
      'docs/adr/0026-staged-distribution-for-internal-test-and-beta.md',
      'docs/plans/some-plan.md',
      'docs/e2e-verification-guide.md',
      'scripts/corpus-lint.mjs',
      'mcp-server/src/index.ts',
      'skills/novel-web-craft/__tests__/x.ts',
      'schemas/ReviewReport.test.ts',
    ]
    for (const rel of drop) {
      expect({ rel, keep: shouldBundleAgentCorePath(rel, target) }).toEqual({ rel, keep: false })
    }
  })

  test('放行白名单路径的祖先目录以便递归拷贝', () => {
    // fs.cp 的 filter 需要对祖先目录返回 true，否则后代被整棵剪掉
    for (const rel of ['docs', 'mcp-server', 'skills', 'packs']) {
      expect({ rel, keep: shouldBundleAgentCorePath(rel, target) }).toEqual({ rel, keep: true })
    }
    // 但 docs 下非 contracts 的子目录仍被挡掉
    expect(shouldBundleAgentCorePath('docs/adr', target)).toBe(false)
  })

  test('node_modules 内部不透明照搬（不对 test/__tests__ 剔除）', () => {
    expect(shouldBundleAgentCorePath('mcp-server/node_modules/foo/__tests__/a.js', target)).toBe(true)
    expect(shouldBundleAgentCorePath('mcp-server/node_modules/foo/x.test.js', target)).toBe(true)
  })

  test('暂存后裁剪 MCP runtime 的开发型文件与目录', () => {
    expect(shouldPruneMcpDistFile('handlers/readers.d.ts')).toBe(true)
    expect(shouldPruneMcpDistFile('handlers/readers.js')).toBe(false)
    // dist 里运行时只需 .js；源映射会把 TS 源路径/内容明文带进分发包，须一并剪掉。
    expect(shouldPruneMcpDistFile('handlers/readers.js.map')).toBe(true)
    expect(shouldPruneMcpDistFile('handlers/readers.d.ts.map')).toBe(true)
    expect(shouldPruneMcpDistFile('index.js.map')).toBe(true)

    const prunedFiles = [
      '@huggingface/transformers/dist/transformers.node.mjs.map',
      '@huggingface/transformers/types/transformers.d.ts',
      '@huggingface/transformers/src/tokenizers.ts',
      'hono/dist/tsconfig.build.tsbuildinfo',
      'zod/README.md',
      'zod/readme.md',
      'zod/CHANGELOG.md',
      'zod/changelog.md',
      'protobufjs/docs/index.md',
    ]
    for (const rel of prunedFiles) {
      expect({ rel, prune: shouldPruneMcpNodeModuleFile(rel) }).toEqual({ rel, prune: true })
    }

    const keptFiles = [
      '@huggingface/transformers/dist/transformers.node.mjs',
      'better-sqlite3/build/Release/better_sqlite3.node',
      'onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
      'sqlite-vec/sqlite-vec.darwin-arm64.node',
      'zod/LICENSE.md',
      // 许可/版权/归属类 .md 不得当作普通 .md 误删（分发包的许可合规义务）。
      'some-dep/COPYING.md',
      'some-dep/NOTICE.md',
      'some-dep/third-party-license.md',
      'some-dep/COPYRIGHT.md',
      'foo/package.json',
      'foo/src/runtime.js',
    ]
    for (const rel of keptFiles) {
      expect({ rel, prune: shouldPruneMcpNodeModuleFile(rel) }).toEqual({ rel, prune: false })
    }

    expect(shouldPruneMcpNodeModuleDirectory('@scope/pkg/docs')).toBe(true)
    expect(shouldPruneMcpNodeModuleDirectory('@scope/pkg/dist')).toBe(false)
    expect(shouldPruneMcpNodeModuleDirectory('yaml/dist/doc')).toBe(false)
    expect(hasPrunedMcpNodeModuleDirectory('@scope/pkg/examples/demo.js')).toBe(true)
    expect(hasPrunedMcpNodeModuleDirectory('yaml/dist/doc/directives.js')).toBe(false)
  })

  test('回归守卫黑名单锚点覆盖主要研发痕迹', () => {
    expect(FORBIDDEN_RELATIVE_PATHS).toContain('eval')
    expect(FORBIDDEN_RELATIVE_PATHS).toContain('CHANGELOG.md')
    expect(FORBIDDEN_RELATIVE_PATHS).toContain('docs/adr')
  })

  test('prune 删尽 MCP runtime 开发型产物、保留运行时文件，verify 复用同一遍历确认无残留', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'narracat-stage-prune-'))
    const mcp = join(destination, 'mcp-server')
    await mkdir(join(mcp, 'dist', 'handlers'), { recursive: true })
    await mkdir(join(mcp, 'node_modules', 'foo', 'test'), { recursive: true })
    await mkdir(join(mcp, 'node_modules', 'onnxruntime-web'), { recursive: true })

    // dist：运行时只留 .js，声明与源映射须剪
    await writeFile(join(mcp, 'dist', 'index.js'), 'export const x = 1\n')
    await writeFile(join(mcp, 'dist', 'index.js.map'), '{}')
    await writeFile(join(mcp, 'dist', 'index.d.ts'), 'export declare const x: number\n')
    await writeFile(join(mcp, 'dist', 'handlers', 'readers.d.ts'), 'export {}\n')
    // node_modules：运行时文件保留，开发型文件/目录与 onnxruntime-web 剪除，许可证保留
    await writeFile(join(mcp, 'node_modules', 'foo', 'index.js'), 'module.exports = {}\n')
    await writeFile(join(mcp, 'node_modules', 'foo', 'README.md'), '# foo\n')
    await writeFile(join(mcp, 'node_modules', 'foo', 'LICENSE.md'), 'MIT\n')
    await writeFile(join(mcp, 'node_modules', 'foo', 'test', 'a.js'), '// test\n')
    await writeFile(join(mcp, 'node_modules', 'onnxruntime-web', 'index.js'), '// web backend\n')

    try {
      await pruneStagedMcpRuntimePayload(destination)

      // 保留
      expect(existsSync(join(mcp, 'dist', 'index.js'))).toBe(true)
      expect(existsSync(join(mcp, 'node_modules', 'foo', 'index.js'))).toBe(true)
      expect(existsSync(join(mcp, 'node_modules', 'foo', 'LICENSE.md'))).toBe(true)
      // 剪除
      expect(existsSync(join(mcp, 'dist', 'index.js.map'))).toBe(false)
      expect(existsSync(join(mcp, 'dist', 'index.d.ts'))).toBe(false)
      expect(existsSync(join(mcp, 'dist', 'handlers', 'readers.d.ts'))).toBe(false)
      expect(existsSync(join(mcp, 'node_modules', 'foo', 'README.md'))).toBe(false)
      expect(existsSync(join(mcp, 'node_modules', 'foo', 'test'))).toBe(false)
      expect(existsSync(join(mcp, 'node_modules', 'onnxruntime-web'))).toBe(false)

      // verify 复用同一遍历，prune 后应零残留
      expect(await findFirstStagedRuntimePayloadViolation(destination)).toBeNull()
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  })

  test('只保留 darwin/arm64 的 onnxruntime 预编译二进制', () => {
    const base = 'mcp-server/node_modules/onnxruntime-node/bin/napi-v3'
    // 显式钉 darwin：这条断言的是「mac 档裁剪行为」，与测试跑在哪台机器上无关。
    // 省略 target 会走 resolveNativeTarget(process.platform)，在 Linux CI 上直接 fail-loud
    //（linux 不是分发目标）——那是 runner 平台泄漏进断言，不是被测行为。
    const target = resolveNativeTarget('darwin')

    // 目标平台：整条路径放行
    expect(shouldPruneForeignPlatformBinary(`${base}/darwin/arm64/onnxruntime_binding.node`, target)).toBe(false)
    expect(shouldPruneForeignPlatformBinary(`${base}/darwin/arm64/libonnxruntime.1.21.0.dylib`, target)).toBe(false)
    // 平台目录自身放行以便递归进去
    expect(shouldPruneForeignPlatformBinary(`${base}/darwin`, target)).toBe(false)

    // 非目标平台/架构：裁掉（含平台目录自身，整目录不拷）
    expect(shouldPruneForeignPlatformBinary(`${base}/darwin/x64/onnxruntime_binding.node`, target)).toBe(true)
    expect(shouldPruneForeignPlatformBinary(`${base}/linux`, target)).toBe(true)
    expect(shouldPruneForeignPlatformBinary(`${base}/linux/x64/onnxruntime_binding.node`, target)).toBe(true)
    expect(shouldPruneForeignPlatformBinary(`${base}/linux/arm64/onnxruntime_binding.node`, target)).toBe(true)
    expect(shouldPruneForeignPlatformBinary(`${base}/win32`, target)).toBe(true)
    expect(shouldPruneForeignPlatformBinary(`${base}/win32/x64/onnxruntime_binding.node`, target)).toBe(true)

    // 不误伤其他包：同名目录段不构成匹配
    expect(shouldPruneForeignPlatformBinary('mcp-server/node_modules/better-sqlite3/build/Release/better_sqlite3.node', target)).toBe(false)
    expect(shouldPruneForeignPlatformBinary('mcp-server/node_modules/sqlite-vec-darwin-arm64/vec0.dylib', target)).toBe(false)
    expect(shouldPruneForeignPlatformBinary('mcp-server/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib', target)).toBe(false)
    expect(shouldPruneForeignPlatformBinary('skills/napi-v3/linux/notes.md', target)).toBe(false)
  })

  test('白名单谓词接入裁剪：非目标平台二进制不进打包产物', () => {
    const base = 'mcp-server/node_modules/onnxruntime-node/bin/napi-v3'
    expect(shouldBundleAgentCorePath(`${base}/darwin/arm64/onnxruntime_binding.node`, target)).toBe(true)
    expect(shouldBundleAgentCorePath(`${base}/linux/x64/onnxruntime_binding.node`, target)).toBe(false)
    expect(shouldBundleAgentCorePath(`${base}/win32/arm64/onnxruntime_binding.node`, target)).toBe(false)
    expect(shouldBundleAgentCorePath(`${base}/darwin/x64/onnxruntime_binding.node`, target)).toBe(false)
  })

  describe('正向断言：暂存树必须真的留着 darwin/arm64 的 onnxruntime 二进制（防裁剪谓词未来静默失效）', () => {
    const binaryDir = join(
      'mcp-server',
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v3',
      'darwin',
      'arm64',
    )

    test('目录齐全（.node + .dylib）时不抛错', async () => {
      const destination = await mkdtemp(join(tmpdir(), 'narracat-stage-onnx-present-'))
      try {
        await mkdir(join(destination, binaryDir), { recursive: true })
        await writeFile(join(destination, binaryDir, 'onnxruntime_binding.node'), 'binary\n')
        await writeFile(join(destination, binaryDir, 'libonnxruntime.1.21.0.dylib'), 'dylib\n')

        await expect(assertBundledOnnxRuntimeNativeBinaryPresent(destination, target)).resolves.toBeUndefined()
      } finally {
        await rm(destination, { recursive: true, force: true })
      }
    })

    test('目录整个缺失（如未来 ABI 目录名变更导致裁剪谓词误裁）时抛错，说明 embedding 会静默失效', async () => {
      const destination = await mkdtemp(join(tmpdir(), 'narracat-stage-onnx-missing-dir-'))
      try {
        await expect(assertBundledOnnxRuntimeNativeBinaryPresent(destination, target)).rejects.toThrow(/静默失效/)
      } finally {
        await rm(destination, { recursive: true, force: true })
      }
    })

    test('目录存在但缺 .node 或 .dylib（拷贝不全）时抛错', async () => {
      const destination = await mkdtemp(join(tmpdir(), 'narracat-stage-onnx-incomplete-'))
      try {
        await mkdir(join(destination, binaryDir), { recursive: true })
        await writeFile(join(destination, binaryDir, 'onnxruntime_binding.node'), 'binary\n')
        // 故意不写 .dylib

        await expect(assertBundledOnnxRuntimeNativeBinaryPresent(destination, target)).rejects.toThrow(/不完整/)
      } finally {
        await rm(destination, { recursive: true, force: true })
      }
    })
  })
})

describe('打包目标平台参数化（Windows 战役）', () => {
  test('resolveNativeTarget 给出平台 / 架构 / 共享库扩展名三件套', () => {
    expect(resolveNativeTarget('darwin')).toEqual({ platform: 'darwin', arch: 'arm64', sharedLibExt: '.dylib' })
    expect(resolveNativeTarget('win32')).toEqual({ platform: 'win32', arch: 'x64', sharedLibExt: '.dll' })
  })

  test('不支持的平台直接 fail-loud，不静默按 darwin 处理', () => {
    expect(() => resolveNativeTarget('linux')).toThrow(/不支持的打包目标平台/)
  })

  test('目标为 win32 时：保留 win32/x64，裁掉 darwin 与其他架构', () => {
    const target = resolveNativeTarget('win32')
    const base = 'mcp-server/node_modules/onnxruntime-node/bin/napi-v3'
    expect(shouldPruneForeignPlatformBinary(`${base}/win32/x64/onnxruntime_binding.node`, target)).toBe(false)
    expect(shouldPruneForeignPlatformBinary(`${base}/win32/x64/onnxruntime.dll`, target)).toBe(false)
    expect(shouldPruneForeignPlatformBinary(`${base}/win32`, target)).toBe(false)
    expect(shouldPruneForeignPlatformBinary(`${base}/win32/arm64/onnxruntime_binding.node`, target)).toBe(true)
    expect(shouldPruneForeignPlatformBinary(`${base}/darwin/arm64/onnxruntime_binding.node`, target)).toBe(true)
    expect(shouldPruneForeignPlatformBinary(`${base}/linux/x64/onnxruntime_binding.node`, target)).toBe(true)
  })

  test('省略 target 时沿用当前进程平台（mac / win 本机打包的既有行为不变）', () => {
    const base = 'mcp-server/node_modules/onnxruntime-node/bin/napi-v3'

    // 只有 darwin / win32 是分发目标；在别的平台（如 Linux CI runner）上「当前进程平台」
    // 根本没有对应的裁剪目标，省略 target 必须 fail-loud 而不是猜一个——猜错的后果是
    // 把目标平台的二进制整个裁光，embedding 在用户机上无声失效（前科 #312/#316/#320）。
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      expect(() => shouldPruneForeignPlatformBinary(`${base}/darwin/arm64/onnxruntime_binding.node`)).toThrow(
        /不支持的打包目标平台/,
      )
      return
    }

    const foreign = process.platform === 'win32' ? 'darwin' : 'win32'
    expect(shouldPruneForeignPlatformBinary(`${base}/${foreign}/x64/onnxruntime_binding.node`)).toBe(true)
  })

  test('shouldBundleAgentCorePath 把 target 透传给平台裁剪谓词', () => {
    const target = resolveNativeTarget('win32')
    const base = 'mcp-server/node_modules/onnxruntime-node/bin/napi-v3'
    expect(shouldBundleAgentCorePath(`${base}/win32/x64/onnxruntime_binding.node`, target)).toBe(true)
    expect(shouldBundleAgentCorePath(`${base}/darwin/arm64/onnxruntime_binding.node`, target)).toBe(false)
  })

  // CI 里写的是 `--platform $TARGET`。变量拼空时 argv 只剩一个裸 `--platform`，
  // 若此时回落到「当前进程平台」，就会静默打出 darwin 包并当成 Windows 包分发出去——
  // embedding 在用户机上无声失效，正是 issue #312/#316/#320 那类前科。必须炸。
  test('--platform 缺值时 fail-loud，不静默回落到当前平台', () => {
    expect(() => resolveNativeTargetFromArgv(['node', 'stage.mjs', '--platform'])).toThrow(/--platform 缺少取值/)
    expect(() => resolveNativeTargetFromArgv(['node', 'stage.mjs', '--platform', '--verbose'])).toThrow(
      /--platform 缺少取值/,
    )
  })

  test('argv 无 --platform 时用当前进程平台；给了值就按值解析', () => {
    // 在非分发平台（如 Linux CI runner）上，「当前进程平台」没有对应的打包目标，
    // 省略 --platform 必须与直接调用一样 fail-loud——绝不能猜一个目标继续走。
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      expect(() => resolveNativeTargetFromArgv(['node', 'stage.mjs'])).toThrow(/不支持的打包目标平台/)
    } else {
      expect(resolveNativeTargetFromArgv(['node', 'stage.mjs'])).toEqual(resolveNativeTarget(process.platform))
    }
    expect(resolveNativeTargetFromArgv(['node', 'stage.mjs', '--platform', 'win32'])).toEqual(
      resolveNativeTarget('win32'),
    )
    expect(() => resolveNativeTargetFromArgv(['node', 'stage.mjs', '--platform', 'linux'])).toThrow(
      /不支持的打包目标平台/,
    )
  })

  test('正向断言按目标平台找对应的共享库扩展名（win 找 .dll，不是 .dylib）', async () => {
    const target = resolveNativeTarget('win32')
    const root = await mkdtemp(join(tmpdir(), 'narracat-stage-win-'))
    try {
      const binaryDir = join(root, 'mcp-server', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64')
      await mkdir(binaryDir, { recursive: true })
      await writeFile(join(binaryDir, 'onnxruntime_binding.node'), 'x')
      // 只有 .node、缺共享库 → 必须炸
      await expect(assertBundledOnnxRuntimeNativeBinaryPresent(root, target)).rejects.toThrow(/不完整/)
      await writeFile(join(binaryDir, 'onnxruntime.dll'), 'x')
      await assertBundledOnnxRuntimeNativeBinaryPresent(root, target)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

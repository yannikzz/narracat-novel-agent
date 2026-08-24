import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test } from 'bun:test'

import {
  assertCorpusCredentials,
  assertNotarizeCredentials,
  createPackageRcSteps,
  findMissingCorpusEnv,
  findMissingNotarizeEnv,
  captureSourceManifest,
  packagedAppBinaryPath,
  resolvePackageClientVersion,
  restoreSourceManifestIfClobbered,
  resolveStepEnv,
} from './package-rc.mjs'
import { CLIENT_BUILD_VERSION_RE } from './client-build-version.mjs'
import { DEFAULT_APP_PATH } from './verify-signed-artifact.mjs'

const packageRcModuleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'package-rc.mjs')).href

/**
 * 在临时目录（永远不是仓库根目录）里演练 package-rc.mjs 真实的 loadEnvFiles()。
 *
 * 必须 spawn 一个真实的 `node` 子进程，而不是在本测试进程内直接调用：`process.loadEnvFile`
 * 是 Node 独有 API，`bun test` 跑在 Bun 运行时里没有这个函数（会抛 TypeError）。子进程里
 * import 真实模块不会有副作用——loadEnvFiles() 只在 package-rc.mjs 的 CLI 入口调用，
 * import 本身不会读任何 .env 文件——所以这里可以直接调用 m.loadEnvFiles(tmpDir)，
 * 不需要先 delete 掉任何键。子进程的环境变量改动不会外泄回本测试进程。
 */
async function runLoadEnvFilesInSubprocess(tmpDir) {
  const script = [
    `const m = await import(${JSON.stringify(packageRcModuleUrl)})`,
    `m.loadEnvFiles(${JSON.stringify(tmpDir)})`,
    'console.log(JSON.stringify({ missing: m.findMissingNotarizeEnv(), key: process.env.APPLE_API_KEY, keyId: process.env.APPLE_API_KEY_ID, issuer: process.env.APPLE_API_ISSUER }))',
  ].join('\n')
  const stdout = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' })
  return JSON.parse(stdout)
}

describe('RC package script', () => {
  test('builds the macOS arm64 RC with the derived client build version', () => {
    const steps = createPackageRcSteps({ clientVersion: '0.1.42' })

    expect(steps.map((step) => step.label)).toEqual([
      'verify Developer ID signing identity',
      'check node runtime',
      'verify NarraCat Agent Core',
      'prepare NarraCat Agent Core',
      'stage NarraCat Agent Core (whitelist)',
      'ensure Electron-ABI native modules',
      'prepare embedding model',
      'probe staged Agent Core runtime',
      'build Electron bundles',
      'package macOS arm64 DMG + ZIP（仅签名）',
      'audit packaged app boundary',
      'smoke packaged app',
      'verify signed artifact',
    ])
    expect(steps[0].args.some((arg) => arg.endsWith('/scripts/check-signing-identity.mjs'))).toBe(true)
    expect(steps[2].args).toContain('--check-version')
    expect(steps[2].args).toContain('--source')
    expect(steps[2].args.some((arg) => arg.endsWith('/agent-core/narracat'))).toBe(true)
    expect(steps[4].args.some((arg) => arg.endsWith('/scripts/stage-narracat-agent-core.mjs'))).toBe(true)
    expect(steps[5].args.some((arg) => arg.endsWith('/scripts/ensure-electron-native.mjs'))).toBe(true)
    expect(steps[6].args.some((arg) => arg.endsWith('/scripts/prepare-embedding-model.mjs'))).toBe(true)
    expect(steps[7].args.some((arg) => arg.endsWith('/scripts/probe-staged-agent-core-runtime.mjs'))).toBe(true)
    expect(steps[9].args).toContain('--mac')
    expect(steps[9].args).toContain('dmg')
    expect(steps[9].args).toContain('zip')
    expect(steps[9].args).toContain('--arm64')
    expect(steps[9].args).toContain('--config.extraMetadata.version=0.1.42')
    expect(steps[9].args).toContain('--config.mac.notarize=false')
    expect(steps[10].args.some((arg) => arg.endsWith('/scripts/audit-packaged-app-boundary.mjs'))).toBe(true)
    expect(steps[12].args.some((arg) => arg.endsWith('/scripts/verify-signed-artifact.mjs'))).toBe(true)
    expect(steps[12].args).not.toContain('--notarized')
  })
})

describe('两道运行时防线（staged 探针 + 产物冒烟）', () => {
  // 两者验的不是同一个二进制：探针在打包前用当前 Node 跑暂存树（引擎自带的 node-ABI
  // better-sqlite3，跨平台、可进 Windows CI）；冒烟在打包后启动产物 .app，走生产实际路径
  // （根 node_modules 的 Electron-ABI better-sqlite3 + utilityProcess）。少任何一条都留缺口。
  test('冒烟跑在打包之后，且 electron 二进制指向本次产物 .app', () => {
    const steps = createPackageRcSteps({ clientVersion: '0.1.9999' })
    const labels = steps.map((step) => step.label)
    const smoke = steps.find((step) => step.label === 'smoke packaged app')

    expect(smoke.args.some((arg) => arg.endsWith('/scripts/smoke-memory.mjs'))).toBe(true)
    expect(smoke.env.NARRACAT_SMOKE_ELECTRON_BIN).toMatch(
      /\/dist\/mac-arm64\/NarraCat\.app\/Contents\/MacOS\/NarraCat$/,
    )
    // 顺序硬约束：必须在产物存在之后跑，否则 .app 还没生成
    expect(labels.indexOf('smoke packaged app')).toBeGreaterThan(
      labels.findIndex((label) => label.includes('package macOS')),
    )
  })

  test('探针排在打包之前（早失败：暂存树坏了不该先烧几分钟打包）', () => {
    const labels = createPackageRcSteps({ clientVersion: '0.1.9999' }).map((step) => step.label)
    expect(labels.indexOf('probe staged Agent Core runtime')).toBeLessThan(
      labels.findIndex((label) => label.includes('package macOS')),
    )
  })

  test('探针步骤本身不带 env 覆盖，冒烟才需要（避免有人顺手给探针塞 electron 二进制）', () => {
    const steps = createPackageRcSteps({ clientVersion: '0.1.9999' })
    const probe = steps.find((step) => step.label === 'probe staged Agent Core runtime')
    expect(probe.env).toBeUndefined()
  })

  // 冒烟必须排在 audit 之后（文档如此写，且 audit 是只读静态检查、该先拦）
  test('冒烟排在 audit packaged app boundary 之后', () => {
    const labels = createPackageRcSteps({ clientVersion: '0.1.9999' }).map((step) => step.label)
    expect(labels.indexOf('smoke packaged app')).toBeGreaterThan(labels.indexOf('audit packaged app boundary'))
  })

  // 外审变异 M5 实证：把 step.env 的转发删掉，smoke-memory 会静默回落 dev 态 electron 跑 out/，
  // 而 dev 回落的日志输出与跑真产物**逐字相同**（resolveEmbeddingModelPath 同样命中打包链刚
  // prepare 好的 build/embedding-model），事后无从分辨。REQUIRE_PACKAGED 让这种情况硬失败。
  test('冒烟带 REQUIRE_PACKAGED 硬闸，env 没传到时不会静默回落 dev 态', () => {
    const smoke = createPackageRcSteps({ clientVersion: '0.1.9999' }).find(
      (step) => step.label === 'smoke packaged app',
    )
    expect(smoke.env.NARRACAT_SMOKE_REQUIRE_PACKAGED).toBe('1')
  })
})

describe('产物路径一致性', () => {
  // package-rc 刻意不 import verify-signed-artifact（会给 CLI fixture 增加链式复制负担），
  // 所以两处各自写了一份 dist/mac-arm64/NarraCat.app。这条测试是它们之间唯一的防漂移绳：
  // 任一处改了产物目录/产品名而另一处没跟上，这里就红。
  test('冒烟指向的 .app 与 verify-signed-artifact 的 DEFAULT_APP_PATH 同源', () => {
    expect(packagedAppBinaryPath()).toBe(join(DEFAULT_APP_PATH, 'Contents', 'MacOS', 'NarraCat'))
  })
})

describe('步骤 env 合并（外审变异 M4：叠加不得退化成替换）', () => {
  test('带 env 的步骤在 process.env 之上叠加，不丢失继承', () => {
    const env = resolveStepEnv({ env: { FOO: '1' } }, { PATH: '/usr/bin', SECRET: 's' })
    expect(env).toEqual({ PATH: '/usr/bin', SECRET: 's', FOO: '1' })
  })

  test('步骤 env 覆盖同名基底键', () => {
    expect(resolveStepEnv({ env: { FOO: 'new' } }, { FOO: 'old' }).FOO).toBe('new')
  })

  test('无 env 的步骤返回 undefined（execFileSync 走默认继承，不显式传 env）', () => {
    expect(resolveStepEnv({}, { PATH: '/usr/bin' })).toBeUndefined()
  })
})

describe('release 档：dmg 容器公证步骤', () => {
  test('release 档在 audit 之后、verify 之前插入 notarize dmg container', () => {
    const steps = createPackageRcSteps({ clientVersion: '0.1.9999', notarize: true })
    expect(steps.map((step) => step.label)).toEqual([
      'verify Developer ID signing identity',
      'check node runtime',
      'verify NarraCat Agent Core',
      'prepare NarraCat Agent Core',
      'stage NarraCat Agent Core (whitelist)',
      'ensure Electron-ABI native modules',
      'prepare embedding model',
      'probe staged Agent Core runtime',
      'build Electron bundles',
      'package macOS arm64 DMG + ZIP（签名 + 公证）',
      'audit packaged app boundary',
      'smoke packaged app',
      'notarize dmg container',
      'verify signed artifact',
    ])
    const notarizeStep = steps.find((step) => step.label === 'notarize dmg container')
    expect(notarizeStep.args.some((arg) => arg.endsWith('/scripts/notarize-dmg.mjs'))).toBe(true)
    // dmg 路径须显式传递（不依赖下游脚本按 dist/ 里 mtime 最新去猜是哪个产物）
    expect(notarizeStep.args).toContain('--dmg')
    expect(notarizeStep.args.some((arg) => arg.endsWith('NarraCat-0.1.9999-mac-arm64.dmg'))).toBe(true)
  })

  test('默认档不含 notarize dmg container 步骤', () => {
    const steps = createPackageRcSteps({ clientVersion: '0.1.9999', notarize: false })
    expect(steps.some((step) => step.label === 'notarize dmg container')).toBe(false)
  })
})

describe('打包分档：签名 / 签名+公证', () => {
  test('默认档不公证，产出 dmg + zip', () => {
    const steps = createPackageRcSteps({ clientVersion: '0.1.9999' })
    const builder = steps.find((step) => step.label.includes('package macOS'))
    expect(builder.args).toContain('dmg')
    expect(builder.args).toContain('zip')
    expect(builder.args).toContain('--config.mac.notarize=false')
  })

  test('release 档开启公证', () => {
    const steps = createPackageRcSteps({ clientVersion: '0.1.9999', notarize: true })
    const builder = steps.find((step) => step.label.includes('package macOS'))
    expect(builder.args).toContain('--config.mac.notarize=true')
  })

  test('打包后的收尾校验步骤随档位带上 --notarized（release 档才验公证与票据装订）', () => {
    const releaseSteps = createPackageRcSteps({ clientVersion: '0.1.9999', notarize: true })
    const defaultSteps = createPackageRcSteps({ clientVersion: '0.1.9999', notarize: false })
    const releaseVerify = releaseSteps.find((step) => step.label === 'verify signed artifact')
    const defaultVerify = defaultSteps.find((step) => step.label === 'verify signed artifact')
    expect(releaseVerify.args).toContain('--notarized')
    expect(defaultVerify.args).not.toContain('--notarized')
    // release 档显式传 --dmg（本次产物路径），不依赖 dist/ 里 mtime 最新去猜；默认档不校验 dmg，不需要传
    expect(releaseVerify.args).toContain('--dmg')
    expect(releaseVerify.args.some((arg) => arg.endsWith('NarraCat-0.1.9999-mac-arm64.dmg'))).toBe(true)
    expect(defaultVerify.args).not.toContain('--dmg')
    // 收尾校验必须是最后一步：在它之前，产物已经打包完成且经过边界审计
    expect(releaseSteps.at(-1).label).toBe('verify signed artifact')
  })

  test('两档都先过签名身份硬闸', () => {
    for (const notarize of [false, true]) {
      const steps = createPackageRcSteps({ clientVersion: '0.1.9999', notarize })
      const gate = steps.findIndex((step) => step.args.some((arg) => String(arg).endsWith('check-signing-identity.mjs')))
      const builder = steps.findIndex((step) => step.label.includes('package macOS'))
      expect(gate).toBeGreaterThanOrEqual(0)
      expect(gate).toBeLessThan(builder)
    }
  })

  test('公证凭证缺失时 fail-loud，绝不静默产出未公证包', () => {
    expect(findMissingNotarizeEnv({})).toEqual(['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'])
    expect(findMissingNotarizeEnv({ APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' })).toEqual([])
    // 空白串等同缺失
    expect(findMissingNotarizeEnv({ APPLE_API_KEY: '  ', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' })).toEqual([
      'APPLE_API_KEY',
    ])
    expect(() => assertNotarizeCredentials({})).toThrow(/APPLE_API_KEY/)
  })

  test('语料凭证缺失时 fail-loud，绝不静默产出不注入真人范例的正式包', () => {
    expect(findMissingCorpusEnv({})).toEqual(['NARRACAT_CORPUS_TOKEN'])
    expect(findMissingCorpusEnv({ NARRACAT_CORPUS_TOKEN: 'tok-x' })).toEqual([])
    // 空白串等同缺失
    expect(findMissingCorpusEnv({ NARRACAT_CORPUS_TOKEN: '   ' })).toEqual(['NARRACAT_CORPUS_TOKEN'])
    expect(() => assertCorpusCredentials({})).toThrow(/NARRACAT_CORPUS_TOKEN/)
    expect(() => assertCorpusCredentials({})).toThrow(/bun run package/)
    expect(() => assertCorpusCredentials({ NARRACAT_CORPUS_TOKEN: 'tok-x' })).not.toThrow()
  })

  test('.env 中的公证凭证能被读到——回归 bun 不把 .env 传给 node 子进程的死循环坑', async () => {
    // package-rc.mjs 的 CLI 入口（文件底部 main-module 判断处）用 process.loadEnvFile 自行加载
    // .env（因为 bun run → node 子进程时 .env 不会被 bun 自动注入）。process.loadEnvFile 是
    // Node 独有 API，`bun test` 本身跑在 Bun
    // 运行时里没有这个函数（会抛 TypeError），而 package-rc.mjs 实际总是经 `node` 执行——
    // 所以这里 spawn 一个真实的 node 子进程去演练真实模块的 loadEnvFiles()，而不是在本测试进程内
    // 直接调用，也不是手写复现 process.loadEnvFile 调用（那样测的是 Node API 本身，测不到
    // package-rc.mjs 的加载顺序代码）。子进程的环境变量改动不会外泄回本测试进程。
    const dir = await mkdtemp(join(tmpdir(), 'narracat-package-rc-env-'))
    await writeFile(
      join(dir, '.env'),
      ['APPLE_API_KEY=/tmp/AuthKey_TEST.p8', 'APPLE_API_KEY_ID=TESTKEYID', 'APPLE_API_ISSUER=test-issuer-id', ''].join(
        '\n',
      ),
      'utf8',
    )

    try {
      const result = await runLoadEnvFilesInSubprocess(dir)
      expect(result).toEqual({
        missing: [],
        key: '/tmp/AuthKey_TEST.p8',
        keyId: 'TESTKEYID',
        issuer: 'test-issuer-id',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('.env.local 中的公证凭证能被读到（实际项目所在）', async () => {
    // 项目实际把私密凭证放在 .env.local（Vite 生态约定），而不是 .env。
    // package-rc.mjs 应该支持从 .env.local 读取凭证。
    const dir = await mkdtemp(join(tmpdir(), 'narracat-package-rc-env-'))
    await writeFile(
      join(dir, '.env.local'),
      [
        'APPLE_API_KEY=/tmp/AuthKey_LOCAL.p8',
        'APPLE_API_KEY_ID=LOCALKEY123',
        'APPLE_API_ISSUER=local-issuer-id',
        '',
      ].join('\n'),
      'utf8',
    )

    try {
      const result = await runLoadEnvFilesInSubprocess(dir)
      expect(result).toEqual({
        missing: [],
        key: '/tmp/AuthKey_LOCAL.p8',
        keyId: 'LOCALKEY123',
        issuer: 'local-issuer-id',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('.env.local 优先于 .env——同名键时 .local 值胜出（防止顺序被改错）', async () => {
    // 关键测试：process.loadEnvFile 是「先到先得、不覆盖」语义。
    // 所以要让 .env.local 优先，必须先加载 .env.local，再加载 .env。
    // 这是反直觉的，且很容易被顺手改成正序，所以此测试是防护栏——它调用真实的 m.loadEnvFiles()，
    // 如果有人把生产代码里 ENV_FILES 的顺序改反，这个测试会变红。
    const dir = await mkdtemp(join(tmpdir(), 'narracat-package-rc-env-'))
    await writeFile(
      join(dir, '.env'),
      ['APPLE_API_KEY=/tmp/AuthKey_FROM_ENV.p8', 'APPLE_API_KEY_ID=KEYID_FROM_ENV', 'APPLE_API_ISSUER=issuer-from-env', ''].join(
        '\n',
      ),
      'utf8',
    )
    await writeFile(
      join(dir, '.env.local'),
      [
        'APPLE_API_KEY=/tmp/AuthKey_FROM_ENV_LOCAL.p8',
        'APPLE_API_KEY_ID=KEYID_FROM_ENV_LOCAL',
        'APPLE_API_ISSUER=issuer-from-env-local',
        '',
      ].join('\n'),
      'utf8',
    )

    try {
      const result = await runLoadEnvFilesInSubprocess(dir)
      // .env.local 先加载（获胜），.env 后加载（被忽视，不覆盖），所以 .env.local 的值应该赢
      expect(result).toEqual({
        missing: [],
        key: '/tmp/AuthKey_FROM_ENV_LOCAL.p8',
        keyId: 'KEYID_FROM_ENV_LOCAL',
        issuer: 'issuer-from-env-local',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('CLI 入口守卫：node scripts/package-rc.mjs 必须先加载 .env 再打包', () => {
  /**
   * package-rc.mjs 底部的 main-module 判断处先调 loadEnvFiles() 再调 runPackageRc()——这一行是
   * bun 不把 .env 传给 node 子进程（package:release 正是 bun run → node）这个死循环坑的唯一防线。
   * 但上面所有测试都只直接调用 m.loadEnvFiles(tmpDir) 测函数本身，从未证明过 CLI 入口真的会调它：
   * 把那一行删掉，整套测试套件照样全绿。本描述块就是补这个洞。
   *
   * 不能直接 spawn 仓库根的 scripts/package-rc.mjs：脚本内 repoRoot 是从自身文件所在位置
   * （import.meta.url）算出来的，与进程 cwd 无关，所以 spawn 真实路径无论 cwd 传什么，
   * 都会去加载仓库根真实的 .env.local（含真实凭证）——这正是本任务的全局约束明令禁止读取的文件。
   *
   * 解法：把 package-rc.mjs 与它唯一的相对依赖 client-build-version.mjs 原样复制（逐字节不改）到
   * 一个 mkdtemp 临时目录的 scripts/ 子目录下，spawn 这份拷贝。拷贝后它的 repoRoot 落在临时目录里，
   * 测试就完全掌控它会加载哪个 .env，而运行的仍是当前这份真实源码。
   *
   * 两组对照缺一不可：
   * ①凭证齐备但无效——如果 loadEnvFiles() 真的把凭证读进了 process.env，
   *   assertNotarizeCredentials/assertCorpusCredentials 会通过，失败会发生在凭证检查**之后**，
   *   落在 runPackageRc 里紧跟着的 resolveClientBuildVersion（`git rev-list --count HEAD`——
   *   临时目录不是 git 仓库，必然 fatal）：这一步比任何打包步骤都快得多（不会碰 stage Agent Core /
   *   prepare embedding model 等耗时步骤，甚至不会进入 步骤循环），且失败原因显然不是「凭证缺失」。
   * ②环境干净、临时目录里没有任何 .env 文件、也没有对应的 shell env——loadEnvFiles() 无凭证可加载，
   *   必须在 resolveClientBuildVersion 之前就被 assertNotarizeCredentials fail-loud 拦下。
   * 若把 CLI 入口的 loadEnvFiles() 调用删掉，①里的 .env.local 凭证永远读不到，
   * 会在还没跑到 git 检查前就先撞上①本不该出现的「凭证缺失」——测试就会变红。
   *
   * 踩坑记录：mkdtemp(tmpdir()) 在 macOS 上返回的是 `/var/folders/...`，而 `/var` 本身是指向
   * `/private/var` 的符号链接。package-rc.mjs 的 CLI 入口判断用的是
   * `import.meta.url === pathToFileURL(process.argv[1]).href`——Node 装载入口模块时会对路径
   * 取 realpath（落地为 `/private/var/folders/...`），但 `process.argv[1]` 是我们传给 node 的
   * 字面量路径（`/var/folders/...`），两者不相等，判断会静默失败，脚本什么也不干就以状态码 0 退出
   * （曾实测复现：无任何输出、status 0，`loadEnvFiles()`/`runPackageRc()` 根本没被调用）。
   * 必须先对 mkdtemp 的返回值取 `realpathSync`，让我们传给 node 的路径与 Node 自己解析出的
   * import.meta.url 一致，CLI 入口守卫才会真正触发。
   */

  const CREDENTIAL_ENV_KEYS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'NARRACAT_CORPUS_TOKEN']

  function cleanEnvWithoutCredentials() {
    const env = { ...process.env }
    for (const key of CREDENTIAL_ENV_KEYS) delete env[key]
    return env
  }

  async function buildCliFixture(dir) {
    const realScriptsDir = dirname(fileURLToPath(import.meta.url))
    const fixtureScriptsDir = join(dir, 'scripts')
    await mkdir(fixtureScriptsDir, { recursive: true })
    await copyFile(join(realScriptsDir, 'package-rc.mjs'), join(fixtureScriptsDir, 'package-rc.mjs'))
    await copyFile(
      join(realScriptsDir, 'client-build-version.mjs'),
      join(fixtureScriptsDir, 'client-build-version.mjs'),
    )
    return join(fixtureScriptsDir, 'package-rc.mjs')
  }

  function runCliExpectingFailure(cliPath, dir) {
    let stdout
    try {
      stdout = execFileSync('node', [cliPath, '--notarize'], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnvWithoutCredentials(),
      })
    } catch (error) {
      return `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    // 不在上面的 catch 里抛：那样会和真实的子进程失败混在一起返回同一种「空字符串」结果，
    // 把「CLI 不该成功却成功了」这个诊断信息吞掉，测试失败时读不出真实原因。
    throw new Error(`期望 CLI 入口失败退出，但它成功了。stdout：${stdout}`)
  }

  test('凭证齐备但无效：失败发生在凭证检查之后，不是「凭证缺失」', async () => {
    // realpathSync：见上方「踩坑记录」——mkdtemp 在 macOS 上落在 /var/folders/...（/var 是软链），
    // 不取 realpath 会让 CLI 入口的 main-module 判断静默失败。
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'narracat-package-rc-cli-')))
    try {
      const cliPath = await buildCliFixture(dir)
      await writeFile(
        join(dir, '.env.local'),
        [
          'APPLE_API_KEY=/tmp/AuthKey_FAKE.p8',
          'APPLE_API_KEY_ID=FAKEKEYID',
          'APPLE_API_ISSUER=fake-issuer-id',
          'NARRACAT_CORPUS_TOKEN=fake-corpus-token',
          '',
        ].join('\n'),
        'utf8',
      )

      const output = runCliExpectingFailure(cliPath, dir)
      expect(output).not.toMatch(/凭证缺失/)
      // 临时目录不是 git 仓库，resolveClientBuildVersion 必然倒在 git rev-list 这一步——
      // 证明流程已经越过了两道凭证闸，只是倒在了别处。
      expect(output).toMatch(/git|rev-list|not a git repository/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('环境干净：失败正是「凭证缺失」，且发生在 resolveClientBuildVersion 之前', async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'narracat-package-rc-cli-')))
    try {
      const cliPath = await buildCliFixture(dir)
      // 故意不写任何 .env / .env.local

      const output = runCliExpectingFailure(cliPath, dir)
      expect(output).toMatch(/公证凭证缺失/)
      expect(output).toMatch(/APPLE_API_KEY/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resolvePackageClientVersion — 内测包版本号覆盖', () => {
  test('未设环境变量时走 git 计数（与正式链路同源）', () => {
    const version = resolvePackageClientVersion({ env: {} })
    expect(version).toMatch(CLIENT_BUILD_VERSION_RE)
  })

  test('设了就用它——测试包要能压过线上版本，否则 electron-updater 会静默换掉它', () => {
    expect(resolvePackageClientVersion({ env: { NARRACAT_CLIENT_VERSION: '0.1.9999' } })).toBe('0.1.9999')
  })

  test('空白值视同未设，不产出空版本号', () => {
    const version = resolvePackageClientVersion({ env: { NARRACAT_CLIENT_VERSION: '   ' } })
    expect(version).toMatch(CLIENT_BUILD_VERSION_RE)
  })

  test('非法值 fail-loud，不静默打出坏版本号的包', () => {
    for (const bad of ['abc', '0.1', '0.1.2.3', 'v0.1.2']) {
      expect(() => resolvePackageClientVersion({ env: { NARRACAT_CLIENT_VERSION: bad } })).toThrow(
        /NARRACAT_CLIENT_VERSION/,
      )
    }
  })

  test('覆盖只在打包入口生效：release.mjs 不得引用它', async () => {
    const { readFile } = await import('node:fs/promises')
    const releaseSource = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'release.mjs'),
      'utf8',
    )
    expect(releaseSource).not.toContain('NARRACAT_CLIENT_VERSION')
    expect(releaseSource).not.toContain('resolvePackageClientVersion')
  })
})

describe('源 package.json 看门狗 — 打包工具改写它是静默的', () => {
  async function makeRepo(manifest = '{\n  "name": "x",\n  "scripts": {}\n}\n') {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'pkgjson-')))
    await writeFile(join(dir, 'package.json'), manifest)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
    execFileSync('git', ['add', 'package.json'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
    return dir
  }

  test('没被改写时什么都不做', async () => {
    const dir = await makeRepo()
    try {
      const before = captureSourceManifest(dir)
      expect(restoreSourceManifestIfClobbered(before, dir, () => {})).toBe('untouched')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('打包前干净、事后被截断 → 自动还原，scripts 段不会被静默删掉', async () => {
    const dir = await makeRepo()
    try {
      const before = captureSourceManifest(dir)
      await writeFile(join(dir, 'package.json'), '{"name":"x"}\n') // 模拟 electron-builder 落下的精简 metadata
      const logs = []
      expect(restoreSourceManifestIfClobbered(before, dir, (m) => logs.push(m))).toBe('restored')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toContain('scripts')
      expect(logs.join('')).toContain('package.json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('打包前就有未提交改动 → 只告警不还原（绝不吃掉作者自己的编辑）', async () => {
    const dir = await makeRepo()
    try {
      await writeFile(join(dir, 'package.json'), '{\n  "name": "x",\n  "scripts": {},\n  "mine": 1\n}\n')
      const before = captureSourceManifest(dir)
      expect(before.wasGitClean).toBe(false)
      await writeFile(join(dir, 'package.json'), '{"name":"x"}\n')
      expect(restoreSourceManifestIfClobbered(before, dir, () => {})).toBe('warned')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).not.toContain('scripts')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

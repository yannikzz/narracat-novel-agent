#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveClientVersion, resolveOverridableClientVersion } from './client-version.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const agentCorePath = join(repoRoot, 'agent-core', 'narracat')

// bun 不把 .env 传给 node 子进程，而 package:release 正是 bun run → node。
// 用 Node 22 原生 loadEnvFile 自行加载，否则公证凭证永远读不到（文案又叫用户去写 .env，死循环）。
export const ENV_FILES = ['.env.local', '.env']

// 加载顺序：.env.local 优先于 .env（Vite 生态约定，.local 是本地覆盖层）。
// 关键细节：process.loadEnvFile 是「先到先得、不覆盖」语义——后加载的文件盖不掉先加载的键。
// 所以要让 .env.local 优先，必须 [.env.local 先，.env 后]。
// 这个顺序是反直觉的，必须写在这里，防止以后有人"顺手修正"成正序而静默翻转优先级。
//
// Shell 中真实 export 的环境变量优先于文件（CI 用 env 注入凭证时不会被本地文件干扰）。
//
// 注意：本函数只应在 CLI 入口调用（本文件与 notarize-dmg.mjs 底部的 main-module 判断处），
// 不应在模块顶层无条件调用——那样每次 import 本模块都会把仓库根真实的 .env.local/.env
// 悄悄读进 process.env，污染单测里刻意注入的 stub 凭证（package-rc.test.mjs 曾因此需要
// 一段"先 delete 再重加载"的绕行代码，见该文件注释）。
export function loadEnvFiles(root = repoRoot) {
  for (const envFile of ENV_FILES) {
    try {
      process.loadEnvFile(join(root, envFile))
    } catch (error) {
      // ENOENT（文件不存在）是正常情况——默认档不需要凭证，继续找下一个文件。
      // 其他错误（如文件存在但格式解析失败）必须原样抛出：静默吞掉会让"配置写坏一行"
      // 和"根本没配置"表现成同一种症状，把人指去配一个他已经配过的东西。
      if (error && error.code === 'ENOENT') continue
      throw error
    }
  }
}

/**
 * 用当前 Node 直接跑依赖包的 JS 入口，不走 node_modules/.bin 的包装器。
 *
 * 为什么绕开 .bin：Windows 上那里放的是 electron-vite.cmd 这类批处理文件，而
 * Node 官方文档写死「.bat/.cmd 不能用 child_process.execFile 启动」——execFileSync
 * 传 .cmd 路径直接 spawnSync EINVAL（2026-08-18 Windows 战役 CI 实撞）。
 * 包入口本身是普通 .js，用 process.execPath 跑它跨平台完全一致：不需要 shell、
 * 不需要 cmd.exe 转义、路径含空格也不受影响（参数走数组，不拼命令行）。
 *
 * BIN_ENTRIES 的值取自各包 package.json 的 bin 字段，被测试钉住——升级依赖时
 * 入口路径若变了，测试会红，而不是等到打包当场炸。
 */
export const BIN_ENTRIES = {
  'electron-vite': join('electron-vite', 'bin', 'electron-vite.js'),
  'electron-builder': join('electron-builder', 'cli.js'),
}

function binStep(name, args) {
  const entry = BIN_ENTRIES[name]
  if (!entry) throw new Error(`未登记的依赖入口：${name}（请在 BIN_ENTRIES 补上它 package.json 的 bin 路径）`)
  return { command: process.execPath, args: [join(repoRoot, 'node_modules', entry), ...args] }
}

export const NOTARIZE_ENV_VARS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']

/** 公证凭证走 App Store Connect API Key（electron-builder 官方推荐，优于 Apple ID + App 专用密码）。 */
export function findMissingNotarizeEnv(env = process.env) {
  return NOTARIZE_ENV_VARS.filter((name) => !String(env[name] ?? '').trim())
}

export function assertNotarizeCredentials(env = process.env) {
  const missing = findMissingNotarizeEnv(env)
  if (missing.length === 0) return
  throw new Error(
    [
      `公证凭证缺失：${missing.join('、')}`,
      '缺凭证时 electron-builder 不会报错中断——它会静默跳过公证、照常产出未公证的包',
      '（app-builder-lib/out/macPackager.js 的 getNotarizeOptions 三项全空时返回 undefined，',
      '调用方只 log.warn("skipped macOS notarization") 就继续走完打包），此处提前拦下正是为了不让这种',
      '"看起来打包成功、实际没公证"的半成品流出去。',
      '',
      '在 .env.local 中配置（推荐；.env 亦可，两者都会被加载且 .env.local 优先，均已在 .gitignore 不会进 git）：',
      '  APPLE_API_KEY=/Users/<你>/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8',
      '  APPLE_API_KEY_ID=XXXXXXXXXX',
      '  APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      '',
      '这三项来自 App Store Connect → 用户和访问 → 集成 → App Store Connect API 新建的密钥',
      '（.p8 仅能下载一次，请一并备份到密码管理器）。',
    ].join('\n'),
  )
}

export const CORPUS_ENV_VARS = ['NARRACAT_CORPUS_TOKEN']

/**
 * 语料 token 走 electron.vite.config.ts 的 main.define 构建期烧入（__NARRACAT_CORPUS_TOKEN__），
 * 不是运行期读取——构建时没这个 env，产物就永久没有语料凭证，装完也不会报错，只是写作悄悄不注入真人范例。
 * 这类静默降质没有运行期报错可拦，只能在打包前挡。
 */
export function findMissingCorpusEnv(env = process.env) {
  return CORPUS_ENV_VARS.filter((name) => !String(env[name] ?? '').trim())
}

export function assertCorpusCredentials(env = process.env) {
  const missing = findMissingCorpusEnv(env)
  if (missing.length === 0) return
  throw new Error(
    [
      `语料服务凭证缺失：${missing.join('、')}`,
      '这不是运行期报错——electron.vite.config.ts 会在构建期把 NARRACAT_CORPUS_TOKEN 烧进产物，',
      '缺失时烧进去的是空串，App 照常启动运行，只是写作从此永远不注入真人范例，质量悄悄降一档，',
      '设置页体检卡会报「语料服务连通」红色，但没人会主动去看，等于静默发出一个残废的正式包。',
      '',
      '在 .env.local 中配置（.env.local 已在 .gitignore，不会进 git）：',
      '  NARRACAT_CORPUS_TOKEN=xxxxxxxx',
      '',
      'token 存在密码管理器 / Cloudflare Worker secret 里，找不到就问语料服务负责人重新签发。',
      '',
      '如果只是想在本机验证打包流程、不需要真人范例注入，改用 `bun run package`（默认档不检查此项）。',
    ].join('\n'),
  )
}

/** 本次打包会产出的 dmg 绝对路径，与 package.json 的 artifactName 模板
 * `NarraCat-${version}-mac-${arch}.${ext}` 保持一致（本仓只打 arm64 一个架构）。
 * clientVersion 在打包前已知，用它显式定位「这一次」的产物，而不是让下游脚本靠
 * dist/ 目录里 mtime 最新去猜——历史 dmg 一多、装订又会刷新 mtime，猜的下场是验错版本。 */
function dmgArtifactPath(clientVersion) {
  return join(repoRoot, 'dist', `NarraCat-${clientVersion}-mac-arm64.dmg`)
}

/** 本次打包产出的未压缩 .app 可执行文件。
 *
 * 刻意就地定义、不 import verify-signed-artifact 的 DEFAULT_APP_PATH：本文件被 CLI 入口测试
 * 复制到临时目录单独 spawn（见 package-rc.test.mjs 的 buildCliFixture），每多一个跨文件 import
 * 就要多复制一个文件，而 verify-signed-artifact 自己还链着 notarize-dmg——耦合成本高于收益。
 * 两者一致性改由测试钉住（package-rc.test.mjs「产物路径与 verify 侧同源」），漂移会红。 */
export function packagedAppBinaryPath(root = repoRoot) {
  return join(root, 'dist', 'mac-arm64', 'NarraCat.app', 'Contents', 'MacOS', 'NarraCat')
}

/** step.env 是**叠加**层不是替换层：子进程仍需完整继承 process.env（PATH、公证/语料凭证等）。
 * 抽成纯函数是为了能被测试直接钉住——runPackageRc 会真的 execFileSync，测不到这一层。 */
export function resolveStepEnv(step, baseEnv = process.env) {
  return step.env ? { ...baseEnv, ...step.env } : undefined
}

/**
 * mac 与 win 共有的前置步骤（准备引擎、暂存、原生模块、模型、探针、构建）。
 *
 * 边界：只放两平台都能跑的东西。mac 专属的签名闸放在 createMacSteps 最前，
 * mac 专属的产物冒烟放在 createMacSteps 最后——后者要真启动 GUI，而 Windows 出包走 CI、
 * 流水线从不启动界面，且它的 electron 二进制路径是 mac .app 布局。
 */
function createSharedPrepareSteps(platform) {
  return [
    {
      label: 'check node runtime',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'check-node-runtime.mjs')],
    },
    {
      label: 'verify NarraCat Agent Core',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'prepare-narracat-agent-core.mjs'), '--check-version', '--source', agentCorePath],
    },
    {
      label: 'prepare NarraCat Agent Core',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'prepare-narracat-agent-core.mjs'), '--if-missing', '--optional'],
    },
    {
      // --platform 必须传：stage 会把非目标平台的 onnxruntime 二进制全裁掉，
      // 漏传就在 Windows 上裁光 win32/x64 再断言 darwin 存在，打包中断（Task 4）。
      label: 'stage NarraCat Agent Core (whitelist)',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'stage-narracat-agent-core.mjs'), '--platform', platform],
    },
    {
      label: 'ensure Electron-ABI native modules',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'ensure-electron-native.mjs')],
    },
    {
      label: 'prepare embedding model',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'prepare-embedding-model.mjs')],
    },
    {
      // 第一道防线（打包前，跨平台）：拿当前 Node 跑 staged 的 embedding selftest + MCP 启动探测，
      // 验暂存树自身完整（模型在不在、mcp-server dist 全不全、原生扩展装不装得上）。
      // 这是 embedding 静默降级（#312/#316/#320）的打包期防线，且纯命令行、可进 Windows CI。
      label: 'probe staged Agent Core runtime',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'probe-staged-agent-core-runtime.mjs')],
    },
    {
      label: 'build Electron bundles',
      ...binStep('electron-vite', ['build']),
    },
  ]
}

/** Windows 档：未签名 NSIS。没有签名闸、没有公证、没有产物冒烟（见 createSharedPrepareSteps 注释）。 */
function createWindowsSteps(clientVersion) {
  return [
    ...createSharedPrepareSteps('win32'),
    {
      // 未签名档：SignPath 的硬条款是「必须已以待签名的形态发布过」，所以第一版就是要发未签名的。
      // 用户首次运行会撞 SmartScreen「Windows 已保护你的电脑」，下载页文案须交代。
      label: 'package Windows x64 NSIS 安装包（未签名）',
      ...binStep('electron-builder', [
        '--win',
        'nsis',
        '--x64',
        `--config.extraMetadata.version=${clientVersion}`,
        // 关掉 electron-builder 自带的 npmRebuild：它会拉 node-gyp 把 better-sqlite3
        // 重编成 Electron ABI，在 Windows CI 上直接 node-gyp failed to rebuild。
        // 而这次重编本来就是多余的——13.0.2 是 N-API，prebuilds/win32-x64.node
        // 单份二进制 node 与 Electron 通吃（同 ensure-electron-native.mjs 的判定）。
        // 只在 win 档关：mac 链刚过验收，那边照旧 rebuild，一个字不动。
        '--config.npmRebuild=false',
      ]),
    },
    {
      label: 'audit packaged app boundary',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'audit-packaged-app-boundary.mjs'), '--platform', 'win32'],
    },
  ]
}

function createMacSteps({ clientVersion, notarize }) {
  const dmgPath = dmgArtifactPath(clientVersion)
  return [
    // 签名身份闸放在第一步：没有 Developer ID 证书时，两档打包都跑不通（打包链本就不面向
    // 外部克隆者，见 check-signing-identity.mjs 的办证指引）。放最前面是为了让这条硬性前提
    // 在任何耗时步骤（stage Agent Core / prepare embedding model 等，实测数分钟）之前拦下，
    // 不要让人先烧掉几分钟才撞见"证书都没有"。
    {
      label: 'verify Developer ID signing identity',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'check-signing-identity.mjs')],
    },
    ...createSharedPrepareSteps('darwin'),
    {
      label: `package macOS arm64 DMG + ZIP（${notarize ? '签名 + 公证' : '仅签名'}）`,
      ...binStep('electron-builder', [
        '--mac',
        'dmg',
        'zip',
        '--arm64',
        `--config.extraMetadata.version=${clientVersion}`,
        `--config.mac.notarize=${notarize}`,
      ]),
    },
    {
      label: 'audit packaged app boundary',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'audit-packaged-app-boundary.mjs'), '--platform', 'darwin'],
    },
    {
      // 第二道防线（打包后，仅 mac 档）：复用 smoke-memory 的既有通道，但把 electron 二进制换成
      // 刚打出来的 .app——验真正要发出去的东西，且走的是**生产实际路径**：真 utilityProcess +
      // 根 node_modules 的 Electron-ABI better-sqlite3 + 引擎 core dist 动态加载 + RPC 往返。
      // 打包态由 buildMemoryWorkerEnv 以 resourcesPath 解析真实模型路径覆盖 smoke 的 dummy 目录，
      // 所以打包的 embedding 一并验到。
      //
      // 与上面的 staged 探针是互补而非重复：探针验暂存树自身（node-ABI，跨平台，能进 CI），
      // 这里验最终产物（Electron-ABI，即生产真正加载的那一份）。两者的 sqlite 根本不是同一个二进制。
      // 放在 audit boundary 之后：静态只读检查快，先让它拦；这一步要真启动 app，慢且有副作用。
      // Windows 档接入时不要照搬——它要启动 GUI，而 Windows 出包走 CI、流水线从不启动界面。
      label: 'smoke packaged app',
      command: process.execPath,
      args: [join(repoRoot, 'scripts', 'smoke-memory.mjs')],
      env: {
        NARRACAT_SMOKE_ELECTRON_BIN: packagedAppBinaryPath(),
        // 硬闸：这一步只要没真正跑到产物就必须失败。缺了它，env 万一没传到子进程，
        // smoke 会静默回落 dev 态、且输出与真产物逐字相同——正是本 PR 要修的那类假绿。
        NARRACAT_SMOKE_REQUIRE_PACKAGED: '1',
      },
    },
    ...(notarize
      ? [
          {
            // electron-builder 只签名 + 公证 .app（DmgOptions.sign 默认 false），dmg 容器本身不处理，
            // 用户先接触的是 dmg——只在 release 档做（默认档本来就不公证；这一步要上传整个 dmg 等好几分钟）。
            // 显式传 --dmg：dist/ 下可能堆着多个历史 dmg，且装订会刷新 mtime，
            // 不能让下游脚本靠"目录里 mtime 最新"去猜这一次打的是哪个。
            label: 'notarize dmg container',
            command: process.execPath,
            args: [join(repoRoot, 'scripts', 'notarize-dmg.mjs'), '--dmg', dmgPath],
          },
        ]
      : []),
    {
      label: 'verify signed artifact',
      command: process.execPath,
      args: [
        join(repoRoot, 'scripts', 'verify-signed-artifact.mjs'),
        ...(notarize ? ['--notarized', '--dmg', dmgPath] : []),
      ],
    },
  ]
}

export function createPackageRcSteps({
  clientVersion = resolveClientVersion({ root: repoRoot }),
  notarize = false,
  platform = process.platform,
} = {}) {
  if (platform === 'win32') return createWindowsSteps(clientVersion)
  if (platform === 'darwin') return createMacSteps({ clientVersion, notarize })
  throw new Error(`不支持的打包目标平台：${platform}（当前只发 darwin/arm64 与 win32/x64）`)
}

/**
 * 打包入口的客户端版本号：直接复用 SSOT（见 client-version.mjs 的
 * resolveOverridableClientVersion——版本号在打包链上有两条独立取值路径，必须同源）。
 */
export function resolvePackageClientVersion({ cwd = repoRoot, env = process.env } = {}) {
  return resolveOverridableClientVersion({ root: cwd, env })
}

/**
 * 源 package.json 被打包工具改写的看门狗。
 *
 * 实锤过一次：一轮 `bun run package` 之后仓库根 package.json 从 145 行被截断成 42 行——
 * scripts / devDependencies / build（electron-builder 配置）全没了，只剩 runtime
 * dependencies。electron-builder 为产物合成精简 metadata（`extraMetadata.version` 走的
 * 就是这条路）时会落到源目录，正常情况下事后还原，异常情况下就留在那儿。
 *
 * 危害不在打包本身（产物是好的），在于**它是静默的**：文件照常存在、`bun run package`
 * 退出码 0，下一次 `git add -A` 就把「删掉全部 scripts」当成正常改动提交进去。
 *
 * 处置分两档，取决于打包前它是否干净——打包前就有未提交改动时绝不动它（那是作者自己的
 * 编辑，自动 checkout 会吃掉），只告警。
 */
function readSourceManifest(cwd) {
  try {
    return readFileSync(join(cwd, 'package.json'), 'utf8')
  } catch {
    return null
  }
}

function isSourceManifestGitClean(cwd) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', 'package.json'], {
      cwd,
      encoding: 'utf8',
    })
    return out.trim() === ''
  } catch {
    // 非 git 环境 / git 不可用 → 当作「脏」，只告警不自动恢复（安全方向）
    return false
  }
}

export function captureSourceManifest(cwd = repoRoot) {
  return { content: readSourceManifest(cwd), wasGitClean: isSourceManifestGitClean(cwd) }
}

/** 返回 'untouched' | 'restored' | 'warned'（供测试断言分档，不吞掉行为差异） */
export function restoreSourceManifestIfClobbered(before, cwd = repoRoot, log = console.error) {
  const after = readSourceManifest(cwd)
  if (before?.content == null || after == null || after === before.content) return 'untouched'

  if (!before.wasGitClean) {
    log(
      '⚠️  打包过程改写了仓库根 package.json，但它打包前就有未提交改动，故不自动恢复。\n' +
        '   请自行核对 `git diff package.json`（打包工具通常只会留下一份精简 metadata）。',
    )
    return 'warned'
  }

  execFileSync('git', ['checkout', '--', 'package.json'], { cwd })
  log('⚠️  打包过程改写了仓库根 package.json，已自动 `git checkout` 还原（产物不受影响）。')
  return 'restored'
}

export function runPackageRc({
  cwd = repoRoot,
  stdio = 'inherit',
  notarize = false,
  platform = process.platform,
  env = process.env,
} = {}) {
  // Windows 档没有「公证」这一挡可以挂钩凭证检查，而语料 token 缺失是构建期静默降质
  //（烧进产物的是空串，App 照常启动、只是写作永远不注入真人范例）。所以 win 无条件检查。
  if (platform === 'win32') assertCorpusCredentials(env)
  if (notarize) {
    assertNotarizeCredentials(env)
    assertCorpusCredentials(env)
  }
  // 版本号走可被 NARRACAT_CLIENT_VERSION 覆盖的 SSOT（打包链上两条取值路径必须同源）。
  const clientVersion = resolvePackageClientVersion({ cwd, env })
  const manifestBefore = captureSourceManifest(cwd)
  try {
    for (const step of createPackageRcSteps({ clientVersion, notarize, platform })) {
      // resolveStepEnv 是叠加层：丢了它，smoke packaged app 拿不到 NARRACAT_SMOKE_ELECTRON_BIN，
      // 会静默回落 dev 态且输出与真产物逐字相同（PR #6 修的正是这类假绿）。
      // 命名成 stepEnv 而非 env：后者会遮蔽 runPackageRc 的 env 形参，win 的凭证检查就读不到调用方传的环境。
      const stepEnv = resolveStepEnv(step, env)
      execFileSync(step.command, step.args, { cwd, stdio, ...(stepEnv ? { env: stepEnv } : {}) })
    }
  } finally {
    // 放 finally：打包中途失败时源文件同样可能已被改写，那时更需要还原
    restoreSourceManifestIfClobbered(manifestBefore, cwd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 只在 CLI 入口加载 .env.local/.env——见 loadEnvFiles 上方注释：模块顶层无条件调用
  // 会污染 import 本模块做单测的进程。runPackageRc 内的 assertNotarizeCredentials /
  // assertCorpusCredentials 默认读 process.env，必须先加载完凭证文件再调用。
  loadEnvFiles()
  const platformIndex = process.argv.indexOf('--platform')
  if (platformIndex !== -1) {
    const value = process.argv[platformIndex + 1]
    if (!value || value.startsWith('--')) {
      throw new Error('--platform 缺少取值（用法：--platform darwin|win32）')
    }
  }
  runPackageRc({
    notarize: process.argv.includes('--notarize'),
    platform: platformIndex === -1 ? process.platform : process.argv[platformIndex + 1],
  })
}

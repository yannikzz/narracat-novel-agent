#!/usr/bin/env node
/**
 * 发版：打包（签名 + 公证）→ 人工确认闸 → 发布到 GitHub Release。
 *
 * Worker（workers/narracat-update/）按 <平台>/<文件名> 反代到 GitHub Release 资产，
 * 版本号从文件名解析——发布的五个资产文件名必须与 releaseAssetFileNames() 严格一致。
 *
 * 发布顺序是硬要求：先建 draft → 传完全部资产 → 最后才 publish（见 publishRelease 注释）。
 * 不勾 Pre-release：GitHub 的 releases/latest 不含预发布版，勾了 Worker 就找不到最新版，
 * 整条自动更新链断掉。
 *
 * 发布用 GitHub CLI（gh），凭证 = gh 的登录态，跑前用 `gh auth status` 自查。
 * 发布目标仓与本仓不同，所有 gh 调用都显式带 --repo。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  macDownloadUrl,
  macFeedUrl,
  RELEASE_REPO,
  releaseAssetFileNames,
  releaseTag,
  winDownloadUrl,
  winFeedUrl,
  winReleaseAssetFileNames,
} from './update-feed.mjs'
import { resolveClientVersion } from './client-version.mjs'
import { loadEnvFiles, runPackageRc } from './package-rc.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

export function createReleasePlan({
  clientVersion,
  distDir = join(repoRoot, 'dist'),
  winDir,
  winFromRelease = false,
}) {
  return {
    repo: RELEASE_REPO,
    tag: releaseTag(clientVersion),
    // Windows 三件产物由 CI 直接传进同一个 draft（--win-from-release）时，它们不在本地，
    // 故不进 assets（那是「要从本机上传的文件」清单）；改由 assertWinAssetsInDraft 远程核验。
    // 记在这里是为了让 releaseNotes 知道这一版含 Windows，以及给校验函数一份期望清单。
    remoteWinAssets: winFromRelease ? winReleaseAssetFileNames(clientVersion) : [],
    // 决策 8a（2026-08-16）：开源之后「内部测试」概念已不成立，对外物料不再带内测措辞。
    // 急刹车 / 软过期机制原样保留、只是不用。
    title: `NarraCat ${clientVersion}`,
    // 不勾 Pre-release：GitHub 的 releases/latest 不含预发布版，勾了本 Worker
    // 就找不到最新版，整条自动更新链断掉。
    prerelease: false,
    assets: [
      ...releaseAssetFileNames(clientVersion).map((name) => join(distDir, name)),
      // winDir 来自 `--with-win <目录>`：CI 出的三件 Windows 产物下载到本地后传进来，
      // 与 mac 五件进同一个 Release（客户端按平台各取所需）。不传则本次只发 mac。
      ...(winDir ? winReleaseAssetFileNames(clientVersion).map((name) => join(winDir, name)) : []),
    ],
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * 非交互环境提前拦死。抽成纯函数便于单测。
 * 为什么必须拦：`readline/promises` 的 `question()` 在 stdin 直接 EOF（`< /dev/null`、CI、管道）时
 * **永不 resolve**，Node 会在 stdin 关闭后以 **exit code 0** 静默退出——既不上传（安全），
 * 也不报错，看起来像「成功」。而此时签名 + 公证已经白跑好几分钟。
 */
export function assertInteractive(isTTY) {
  if (isTTY) return
  throw new Error(
    [
      '发版需要人工确认，但当前不是交互式终端。',
      '请在终端里直接运行 `bun --no-cache run release`，不要经管道/重定向/CI 调用。',
    ].join('\n'),
  )
}

export function formatConfirmation({ clientVersion, repo, tag, files }) {
  const lines = [
    '',
    '━━━━━━━━━━━━━━━━ 发版确认 ━━━━━━━━━━━━━━━━',
    `版本号：${clientVersion}`,
    `目标仓：${repo}`,
    `Tag：${tag}`,
    `更新源：${macFeedUrl()}`,
    '产物：',
    ...files.map((file) => `  · ${file.name}  ${formatBytes(file.bytes)}`),
    '',
    '上传后所有已安装用户都会自动收到此版本。',
    // tag 不存在时，gh 会基于发布仓（一个由人工定向同步的对外镜像仓）当前默认
    // 分支的最新状态创建——不是本仓当前 HEAD。资产是我们上传的文件，与 tag 指向
    // 哪个 commit 无关，故不影响用户下载与自动更新；只是 git 历史可能不准，
    // 操作者需要在确认前知道这件事。
    'tag 将基于发布仓当前默认分支创建；若镜像仓尚未同步到本次代码，tag 指向的',
    'commit 会与本次发布的代码不一致（不影响用户下载与自动更新）。',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ]
  return lines.join('\n')
}

export function assertArtifactsExist(assets) {
  const missing = assets.filter((file) => !existsSync(file))
  if (missing.length === 0) return
  throw new Error(
    [
      '以下产物不存在，无法发版：',
      ...missing.map((file) => `  · ${file}`),
      '',
      'latest-mac.yml 缺失通常意味着 package.json 的 build.publish 没配置——',
      '没有 publish 配置时 electron-builder 不生成清单，但打包依旧「成功」。',
    ].join('\n'),
  )
}

/**
 * 校验清单内容属于本次要发的版本——纯函数，便于单测直接喂字符串。
 *
 * 为什么必须做这一层：`dist/` 是累积目录，`assertArtifactsExist` 只查文件在不在。只要
 * electron-builder 这次没重写清单（`build.publish` 被误删、target 配置改动等），一份
 * **陈旧清单**会被原样传上生产——全流程 exit 0，确认闸照常打印新版本号，看起来完全正常。
 */
export function assertManifestMatchesVersion({
  manifestContent,
  clientVersion,
  assetFileName,
  // 两平台共用本函数：mac 的清单叫 latest-mac.yml、win 的叫 latest.yml。
  // 名字进错误信息，别让 Windows 的问题报成「latest-mac.yml 解析失败」指错文件。
  manifestName = 'latest-mac.yml',
}) {
  let manifest
  try {
    manifest = parseYaml(manifestContent)
  } catch (error) {
    throw new Error(
      `${manifestName} 解析失败，内容可能损坏：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const assetUrls = Array.isArray(manifest?.files) ? manifest.files.map((file) => file?.url) : []
  if (manifest?.version === clientVersion && assetUrls.includes(assetFileName)) return

  throw new Error(
    [
      `${manifestName} 与本次待发版本不符：清单里是 ${manifest?.version ?? '未知'}，本次要发 ${clientVersion}。`,
      'dist/ 是累积目录，这通常意味着 electron-builder 这次没有重新生成清单——',
      '检查 package.json 的 build.publish 是否被误删、或 target 配置改动导致跳过生成。',
      '重新完整走一遍打包（不要复用旧 dist/）再发版。',
    ].join('\n'),
  )
}

/**
 * 复用现成产物发版时的三道加严闸（`--use-existing-artifacts`）。
 *
 * 背景：公证提交成功、Apple 也判了 Accepted，但 notarytool 轮询那一步网络超时 → 整条
 * 发布链退出码 1。产物其实只差一个 `stapler staple`，重跑却要从头再打包 + 再公证一次
 * （二十分钟，再赌一次同样的网络，还多耗一次公证配额）。真实撞过一次，故留这条路。
 *
 * **但复用产物比正常流程更危险**：正常流程里产物是刚构建的，复用则可能发出一份陈旧的、
 * 或公证根本没做完的包。所以这条路的闸必须比默认路径更严，下面三条缺一不可——
 * 其中「票据是否真的装订上」这一条，默认路径里原本谁都没查过（撞上那次正是靠手工
 * `stapler validate` 才发现 dmg 是裸的）。
 */
function stapleValidated(target) {
  return spawnSync('xcrun', ['stapler', 'validate', target], { stdio: 'ignore' }).status === 0
}

export function assertArtifactsNotarized(plan, { distDir = join(repoRoot, 'dist'), validate = stapleValidated } = {}) {
  const dmg = plan.assets.find((file) => file.endsWith('.dmg'))
  const app = join(distDir, 'mac-arm64', 'NarraCat.app')
  const bare = [
    ...(validate(dmg) ? [] : [`dmg 容器：${dmg}`]),
    ...(existsSync(app) && validate(app) ? [] : [`app（zip 的内容物）：${app}`]),
  ]
  if (bare.length === 0) return
  throw new Error(
    [
      '以下产物没有装订公证票据，用户打开会被 Gatekeeper 拦下：',
      ...bare.map((line) => `  · ${line}`),
      '',
      '公证「提交成功」不等于「票据装订上了」——notarytool 轮询超时就会停在这一步。',
      '先查真实状态：xcrun notarytool info <submission-id> --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"',
      'status=Accepted 的话补装订即可：xcrun stapler staple <文件>；否则重新走完整打包。',
    ].join('\n'),
  )
}

/**
 * zip 的实际 sha512 必须与清单一致——**这是自动更新的命脉**：electron-updater 更新走的是
 * zip（清单顶层 `path`/`sha512` 指向它），对不上则用户下载后校验失败、更新静默失败。
 *
 * 注意 dmg 不做这个校验，因为它**必然**对不上：公证脚本第一步是 `codesign --force` 重签
 * dmg，发生在清单生成之后。dmg 只供人手动下载、走 Gatekeeper 而非 sha512 校验，故无碍。
 */
export function assertZipMatchesManifest(plan) {
  const manifestFile = plan.assets.find((file) => file.endsWith('latest-mac.yml'))
  const zipFile = plan.assets.find((file) => file.endsWith('.zip'))
  const manifest = parseYaml(readFileSync(manifestFile, 'utf8'))
  const expected = manifest?.sha512
  const actual = createHash('sha512').update(readFileSync(zipFile)).digest('base64')
  if (expected === actual) return
  throw new Error(
    [
      'zip 的 sha512 与 latest-mac.yml 不符——自动更新会在用户机器上校验失败。',
      `  清单：${expected ?? '未知'}`,
      `  实际：${actual}`,
      '产物与清单来自不同次打包，不能复用。请走完整打包发版。',
    ].join('\n'),
  )
}

/**
 * 产物不得早于 HEAD 提交——防的是「改完代码忘了重新打包，直接复用上一次的产物发版」。
 * 版本号校验挡不住这一类：同一个提交数下改动源码，版本号一模一样，清单也「新鲜」。
 */
/**
 * 确定**不进 App 产物**的路径。改这些不该逼人重打一次二十到四十分钟的包。
 *
 * ⚠️ 方向性判断：这是**排除清单**而不是包含清单，因为两种漏写的代价完全不对称——
 * 漏写一条排除项，最坏是多打一次包（安全）；漏写一条包含项，就会发出一份不含新代码的包
 * 且无人察觉（危险）。所以只把**确定**不进产物的放进来，拿不准的一律不加、让它触发重打。
 *
 * `scripts/` 整体不排除：里面既有发版脚本（不进产物），也有 prepare-narracat-agent-core /
 * prepare-embedding-model / package-rc 这些实打实决定产物内容的。只点名排除确知无关的几个。
 */
const NON_PRODUCT_PATHSPECS = [
  ':(exclude)docs/',
  ':(exclude).github/',
  ':(exclude).claude/',
  ':(exclude).agents/',
  ':(exclude)workers/',
  ':(exclude)*.md',
  ':(exclude).gitignore',
  ':(exclude)scripts/release.mjs',
  ':(exclude)scripts/ops-*.mjs',
  ':(exclude)*.test.mjs',
  ':(exclude)*.test.ts',
  ':(exclude)*.test.tsx',
]

/**
 * 最后一次改动「可能进产物的文件」的提交时间。
 *
 * 为什么不直接用 HEAD：闸的语义是「产物不能比它所代表的代码旧」，而 HEAD 时间只是那个语义的
 * 粗糙代理。发版前顺手改发版脚本、补文档、调 CI——这些都会推高 HEAD 却一个字节都不进产物，
 * 于是闸会逼人重打一份逐字节相同的包（2026-08-30 实撞：#62 只改了发版脚本与文档，
 * 却让一份刚验收过的 mac 包被判为「比当前提交还旧」）。
 *
 * 拿不到结果时回退 HEAD——宁可误判成需要重打，不可放过一份真的过期的产物。
 */
export function lastProductChangeIso({ cwd = repoRoot, execFile = execFileSync } = {}) {
  const read = (args) => String(execFile('git', args, { cwd, encoding: 'utf8' })).trim()
  try {
    const scoped = read(['log', '-1', '--format=%cI', '--', '.', ...NON_PRODUCT_PATHSPECS])
    if (scoped) return scoped
  } catch {
    // 落到下面的 HEAD 回退
  }
  return read(['log', '-1', '--format=%cI'])
}

export function assertArtifactsNotStale(
  plan,
  { cwd = repoRoot, distDir = join(repoRoot, 'dist'), readProductChangeIso = lastProductChangeIso } = {},
) {
  const app = join(distDir, 'mac-arm64', 'NarraCat.app')
  if (!existsSync(app)) return
  const changeIso = readProductChangeIso({ cwd })
  const changeTime = new Date(changeIso).getTime()
  const builtTime = statSync(app).mtimeMs
  if (builtTime >= changeTime) return
  throw new Error(
    [
      '产物比最后一次影响产物的代码改动还旧，复用它等于发布一份不含最新代码的包：',
      `  产物构建于：${new Date(builtTime).toISOString()}`,
      `  代码改动于：${changeIso}`,
      '（只改文档 / CI / 发版脚本不算数，那些不进产物，见 NON_PRODUCT_PATHSPECS）',
      '请走完整打包发版（去掉 --use-existing-artifacts）。',
    ].join('\n'),
  )
}

function assertManifestFreshness(plan, clientVersion) {
  const manifestFile = plan.assets.find((file) => file.endsWith('latest-mac.yml'))
  const zipFile = plan.assets.find((file) => file.endsWith('.zip'))
  const manifestContent = readFileSync(manifestFile, 'utf8')
  assertManifestMatchesVersion({ manifestContent, clientVersion, assetFileName: zipFile.split('/').pop() })

  // Windows 清单来自 CI 下载的目录，同样可能是陈旧的（下错 run、复用旧目录）——
  // 而且它比 mac 更容易出错：mac 的 dist/ 是本次打包刚写的，win 的目录是人手动下载的。
  // endsWith('latest.yml') 会同时命中 latest-mac.yml，故显式排除。
  const winManifestFile = plan.assets.find((file) => file.endsWith('latest.yml') && !file.endsWith('latest-mac.yml'))
  if (!winManifestFile) return
  const winExe = plan.assets.find((file) => file.endsWith('-win-x64.exe'))
  assertManifestMatchesVersion({
    manifestContent: readFileSync(winManifestFile, 'utf8'),
    clientVersion,
    assetFileName: winExe.split('/').pop(),
    manifestName: 'latest.yml',
  })
}

async function confirm(plan, clientVersion) {
  const files = plan.assets.map((file) => ({ name: file.split('/').pop(), bytes: statSync(file).size }))
  process.stdout.write(`${formatConfirmation({ clientVersion, repo: plan.repo, tag: plan.tag, files })}\n`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('确认上传？输入 yes 继续：')
  rl.close()
  if (answer.trim().toLowerCase() !== 'yes') throw new Error('已取消，未上传任何文件。')
}

function ghRun(args) {
  execFileSync('gh', args, { cwd: repoRoot, stdio: 'inherit' })
}

/**
 * 读线上 release 状态；tag 不存在返回 null。
 *
 * 不能复用 ghRun：那个是 stdio:'inherit'，输出直接流向终端、拿不回来。
 */
export function readReleaseState(tag, { execFile = execFileSync, repo = RELEASE_REPO } = {}) {
  try {
    const out = execFile('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(out)
  } catch {
    // tag 不存在是最常见的分支（正常发版路径），gh 会以非零退出；
    // 网络/认证故障也落这里，但那种情况后面真正 create 时一样会炸，不会静默发出去。
    return null
  }
}

/**
 * 版本号重复闸（ADR-0038 补的第二道，放在打包之前）。
 *
 * 旧机制下版本号是 `git rev-list --count HEAD`，只增不减、天然不可能重复；ADR-0038 改成人在
 * `package.json` 里定之后，「忘了 bump 就发版」成了真实可能——**而它的后果不是报错**：
 * 资产会被 `release upload --clobber` 传进一个已经发布过的 tag，线上那个版本的文件被悄悄换掉、
 * 版本号却没变，electron-updater 那边完全无感（用户永远不会重新下载），排查时也毫无线索。
 *
 * 只拦**已发布**的 release。停在 draft 的那种是上次发版中途某个资产上传失败的残留，
 * 属于另一回事，交给既有的 tagExistsRecoveryGuidance 处理（删掉重来 or 补齐资产）。
 */
export function assertVersionNotAlreadyReleased(clientVersion, { readState = readReleaseState } = {}) {
  const tag = releaseTag(clientVersion)
  const state = readState(tag)
  if (!state || state.isDraft) return

  throw new Error(
    [
      `发布中止：${RELEASE_REPO} 上已经发布过 ${tag} 了。`,
      '',
      '最常见的原因是忘了先抬版本号——版本号现在由人在 package.json 里定（ADR-0038），',
      '不再自动从提交数派生，所以不会自己往上走。',
      '',
      '要发新版本：改 package.json 的 version（修 bug 走 patch，如 0.3.1；有新能力走 minor，如 0.4.0），',
      '提交后重新跑一遍 `bun --no-cache run release`。',
      '',
      '如果你确实想替换已发布的这一版（极少见，会让已下载的用户与线上文件不一致），',
      `请先手动删掉它：gh release delete ${tag} --repo ${RELEASE_REPO} --cleanup-tag --yes`,
    ].join('\n'),
  )
}

/**
 * `gh release create` 失败时，用 `gh release view` 探测是否是「tag 已存在」这一类——
 * 不解析错误文本：上面的 run 用 stdio: 'inherit'，子进程 stderr 直接流向终端，
 * Error 对象里根本拿不到内容。命中就返回 true，探测本身失败（tag 确实不存在）
 * 就返回 false，交给调用方原样抛出原始错误。
 */
function releaseAlreadyExists(plan, run) {
  try {
    run(['release', 'view', plan.tag, '--repo', plan.repo, '--json', 'tagName'])
    return true
  } catch {
    return false
  }
}

function tagExistsRecoveryGuidance(plan) {
  return [
    `发布失败：${plan.repo} 上已存在 tag ${plan.tag}（很可能是上次发版中途某个资产上传失败，停在了 draft）。`,
    '这本身是安全的——draft release 不被匿名 API 与 releases/latest 看见，线上仍是上一版。',
    '',
    '恢复办法二选一：',
    `  1. 删掉上次的 draft 重来：gh release delete ${plan.tag} --repo ${plan.repo} --cleanup-tag --yes`,
    '     然后重新跑一遍 `bun --no-cache run release`。',
    `  2. 去 Release 页手动补齐资产后取消草稿：https://github.com/${plan.repo}/releases/tag/${plan.tag}`,
  ].join('\n')
}

/**
 * 核验 Windows 三件产物确实躺在目标 draft 里（`--win-from-release` 模式的闸）。
 *
 * 为什么必须查而不是信：CI 那一步失败时人未必看见（流水线绿不绿与产物有没有传成功是两件事，
 * 本仓有前科）。不查就 publish，等于发一个只有 mac 的 Release——而两个平台的更新清单都指向
 * `releases/latest`，Windows 那条链会当场断掉，且两端都没有报错。
 *
 * 也查大小：GitHub 上传中断会留下 0 字节的资产条目，名字齐全但下下来是空文件。
 */
export function assertWinAssetsInDraft(plan, { readAssets = readReleaseAssets } = {}) {
  const expected = plan.remoteWinAssets ?? []
  if (expected.length === 0) return

  const actual = readAssets(plan.tag)
  if (actual === null) {
    throw new Error(
      `读不到 ${plan.repo} 上 ${plan.tag} 的资产列表——无法确认 Windows 产物是否已就位，不继续发布。`,
    )
  }

  const bySize = new Map(actual.map((a) => [a.name, a.size]))
  const missing = expected.filter((name) => !bySize.has(name))
  const empty = expected.filter((name) => bySize.has(name) && !(bySize.get(name) > 0))

  if (missing.length || empty.length) {
    throw new Error(
      [
        `发布中止：${plan.tag} 的 draft 里 Windows 产物不完整。`,
        ...(missing.length ? [`  缺少：${missing.join(' / ')}`] : []),
        ...(empty.length ? [`  空文件（上传中断）：${empty.join(' / ')}`] : []),
        '',
        '这三件本应由 Windows CI 直接传进这个 draft。重新触发一次即可：',
        '  gh workflow run windows-release-build.yml --ref main',
        '',
        '照原样发下去的后果不是少一个包——两个平台的更新清单都指向 releases/latest，',
        'Windows 客户端查清单会 404，那条更新链会断到下次带 Windows 产物的发布为止。',
      ].join('\n'),
    )
  }
}

/** 读 release 的资产名与大小；tag 不存在或读不到返回 null（调用方据此 fail-loud）。 */
export function readReleaseAssets(tag, { execFile = execFileSync, repo = RELEASE_REPO } = {}) {
  try {
    const out = execFile('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(out)
    if (!Array.isArray(parsed?.assets)) return null
    return parsed.assets.map((a) => ({ name: a.name, size: a.size }))
  } catch {
    return null
  }
}

/**
 * 先建 draft、传完全部资产、最后才 publish。
 * 这是本脚本最重要的顺序纪律：draft release 不被匿名 API 与 releases/latest 看见，
 * 所以在资产全部传完之前没有任何用户能看到这个版本——不存在「清单已翻但包还没传完」
 * 的窗口期。任一步失败，release 停在 draft，线上仍是上一版，零影响。
 *
 * `run` 默认是真实的 gh 调用，测试可以注入一个记录调用的假执行器——这是本脚本
 * 风险最高的一段（真正改动线上 release），此前完全没有单测覆盖，变异实验证实
 * 删掉某条 `--repo` 测试仍然全绿。
 */
export function publishRelease(plan, { run = ghRun, draftExists = false } = {}) {
  // draftExists：CI 已经建好 draft 并把 Windows 三件放了进去（--win-from-release）。
  // 这种情况下再 create 必然撞「tag 已存在」，那条路径的恢复指引是给「上次发版中途失败」
  // 准备的，用在这里会把正常流程说成故障。改为直接往那个 draft 里补 mac 产物。
  if (!draftExists) {
    try {
      run(['release', 'create', plan.tag, '--repo', plan.repo, '--draft', '--title', plan.title, '--notes', releaseNotes(plan)])
    } catch (error) {
      // 不吞掉原始错误：release view 探测失败（真不是 tag 已存在）就原样抛出；
      // 探测命中就换成可操作的中文指引，但仍以非零退出——不静默、不假装成功。
      if (!releaseAlreadyExists(plan, run)) throw error
      throw new Error(tagExistsRecoveryGuidance(plan))
    }
  }
  for (const asset of plan.assets) {
    process.stdout.write(`↑ ${asset.split('/').pop()}\n`)
    run(['release', 'upload', plan.tag, asset, '--repo', plan.repo, '--clobber'])
  }
  run(['release', 'edit', plan.tag, '--repo', plan.repo, '--draft=false', '--latest'])
}

function releaseNotes(plan) {
  const version = plan.tag.replace(/^v/, '')
  const hasWindows =
    plan.assets.some((file) => file.endsWith('-win-x64.exe')) ||
    (plan.remoteWinAssets ?? []).some((file) => file.endsWith('-win-x64.exe'))
  return [
    `NarraCat ${version}。`,
    '',
    '已装旧版的用户会在启动后自动收到更新，重启即可生效。',
    `首次安装：macOS 下载 dmg${hasWindows ? '，Windows 下载 exe。' : '。'}`,
    ...(hasWindows
      ? [
          '',
          '⚠️ Windows 版当前尚未代码签名，首次运行会看到「Windows 已保护你的电脑」蓝色弹窗：',
          '点「更多信息」→「仍要运行」即可。签名证书正在申请中（SignPath Foundation 开源计划）。',
        ]
      : []),
  ].join('\n')
}

export async function runRelease({ winDir, winFromRelease = false, useExistingArtifacts = false } = {}) {
  // 放在打包之前：非交互环境就别浪费几分钟签名 + 公证了。
  assertInteractive(process.stdin.isTTY)

  const clientVersion = resolveClientVersion({ root: repoRoot })
  // 重复版本闸放在打包之前：撞上了就别浪费几分钟签名 + 公证（与上面 assertInteractive 同理）。
  assertVersionNotAlreadyReleased(clientVersion)
  // 本机只打 mac：Windows 包由 CI 出（SignPath 要求可验证地从源码构建），
  // 通过 --with-win <目录> 把下载好的三件产物带进本次 Release——两条路互不影响，
  // --use-existing-artifacts 跳过的只是 mac 这一次打包。
  if (useExistingArtifacts) {
    process.stdout.write('⚠️  跳过打包，复用 dist/ 现成产物（--use-existing-artifacts）\n')
  } else {
    runPackageRc({ cwd: repoRoot, notarize: true })
  }

  const plan = createReleasePlan({ clientVersion, winDir, winFromRelease })
  assertArtifactsExist(plan.assets)
  assertManifestFreshness(plan, clientVersion)
  // Windows 三件由 CI 直传时不在本地，改为远程核验它们真的躺在这个 draft 里。
  // 放在确认闸之前：撞上了就别让人对着一份不完整的清单点确认。
  assertWinAssetsInDraft(plan)
  if (useExistingArtifacts) {
    // 复用产物比刚打完的更危险，三道闸缺一不可（见各函数注释）
    assertArtifactsNotStale(plan)
    assertZipMatchesManifest(plan)
    assertArtifactsNotarized(plan)
    process.stdout.write('✓ 复用产物已通过：不早于 HEAD / zip 与清单一致 / dmg 与 app 票据均已装订\n')
  }
  await confirm(plan, clientVersion)

  // draft 已经由 CI 建好并放了 Windows 产物时不要再 create（会撞「tag 已存在」，
  // 而那条恢复指引是给上次发版中途失败准备的，用在这儿会把正常流程说成故障）。
  publishRelease(plan, { draftExists: winFromRelease })

  process.stdout.write(
    [
      '',
      `✅ ${clientVersion} 已发布。`,
      // 对外只发永久链接：它自动跟随 latest，发新版不必换，回退时也跟着回退。
      // 带版本号的那条只在需要钉死某一版时用（比如让某个用户复现问题）。
      `macOS 对外分发（永久，发新版不用换）：${macDownloadUrl()}`,
      ...(winDir ? [`Windows 对外分发（永久）：${winDownloadUrl()}`] : []),
      `本版固定地址：${macFeedUrl()}/NarraCat-${clientVersion}-mac-arm64.dmg`,
      ...(winDir ? [`             ${winFeedUrl()}/NarraCat-${clientVersion}-win-x64.exe`] : []),
      `Release 页：https://github.com/${plan.repo}/releases/tag/${plan.tag}`,
      '',
      '出问题要回退：打开上面的 Release 页 → 编辑上一个正常版本 → 勾选',
      '"Set as the latest release" → 保存。不需要传任何文件。',
      '',
    ].join('\n'),
  )
}

/**
 * 发版命令行参数解析（纯函数，便于测试——CLI 入口只负责把 process.argv 递进来）。
 *
 * **覆盖平台必须显式声明**：`--with-win <目录>` 发双平台，`--mac-only` 发单 mac，两个都不给就炸。
 *
 * 为什么不让「不给就只发 mac」当默认：那个默认在只有 mac 的时代是对的，Windows 成为正式分发
 * 平台之后就变成了一个**静默陷阱**，而且后果比「少发一个包」重得多——
 *
 * **两个平台的更新清单都指向 `releases/latest`**（见 workers/narracat-update/src/index.ts 的
 * resolveUpstreamUrl：`latest-mac.yml` 与 `latest.yml` 一律翻译成
 * `releases/latest/download/<清单名>`）。所以一个只含单平台产物的 Release 一旦成为 latest，
 * **另一个平台的清单查询直接 404，那条更新链就断了**——不是「停在上一版」，是从此收不到任何
 * 更新，直到下一次带上该平台产物的发布为止。全程无报错、无提示，两端都察觉不到。
 *
 * 命令照常跑完、发布照常成功，正是这类问题的典型形态（与 ADR-0038 治的那起同族）。发版确认
 * 界面确实会列出待传文件，但那是靠人在一堆文件名里数出少了三个，不是闸。
 *
 * ⚠️ 推论：**Windows 正式发布之后，`--mac-only` 基本不该再用**——那时它意味着主动掐断
 * Windows 用户的更新链。保留这个选项只为「Windows 尚未发布过」的当下，以及 Windows CI 出包
 * 失败又必须紧急发 mac 修复的极端情况。
 *
 * 两个都给则是矛盾指令，同样炸——不猜用户想要哪个。
 */
export function parseReleaseArgs(argv) {
  const withWinIndex = argv.indexOf('--with-win')
  const macOnly = argv.includes('--mac-only')
  const winFromRelease = argv.includes('--win-from-release')

  if (withWinIndex !== -1) {
    const value = argv[withWinIndex + 1]
    if (!value || value.startsWith('--')) {
      throw new Error('--with-win 缺少取值（用法：--with-win <存放 CI Windows 产物的目录>）')
    }
  }

  const modes = [withWinIndex !== -1 && '--with-win', winFromRelease && '--win-from-release', macOnly && '--mac-only'].filter(Boolean)
  if (modes.length > 1) {
    throw new Error(`${modes.join(' 与 ')} 互斥：一次发版只能选一种覆盖平台的方式，不要同时给。`)
  }

  if (modes.length === 0) {
    throw new Error(
      [
        '发版中止：没说这次发哪些平台。',
        '',
        '  双平台（常规）：bun --no-cache run release --win-from-release',
        '      Windows 三件产物由 CI 直接传进同一个 draft，本机不必下载。',
        '      先跑 `gh workflow run windows-release-build.yml --ref main`（约 5 分钟）。',
        '',
        '  双平台（本地有 Windows 产物时）：bun --no-cache run release --with-win <目录>',
        '      仅在产物已经在本机时用；从 CI 下载 244MB 再传回去是没必要的往返。',
        '',
        '  只发 mac（需要主动选择）：bun --no-cache run release --mac-only',
        '      ⚠️ 两个平台的更新清单都指向 releases/latest，所以这一版一旦成为 latest，',
        '      Windows 客户端查清单会 404——不是停在上一版，是整条更新链断到下次带 Windows',
        '      产物的发布为止，且两端都没有任何报错。Windows 发布过之后不要用这个选项。',
      ].join('\n'),
    )
  }

  return {
    winDir: withWinIndex === -1 ? undefined : resolve(argv[withWinIndex + 1]),
    winFromRelease,
    useExistingArtifacts: argv.includes('--use-existing-artifacts'),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 必须先加载 .env.local/.env 再跑：runPackageRc 内的 assertNotarizeCredentials /
  // assertCorpusCredentials 读的是 process.env，而 bun run → node 不会把 .env 传给子进程。
  // 漏这一步的后果是「凭证明明配好了却报缺失」，整条发布链在真机上打不通
  // （package-rc.mjs / notarize-dmg.mjs 的 CLI 入口是同款处置，见 package-rc.test.mjs 的回归测试）。
  loadEnvFiles()
  runRelease(parseReleaseArgs(process.argv)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}

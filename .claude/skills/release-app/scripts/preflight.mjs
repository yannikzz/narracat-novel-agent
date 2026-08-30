#!/usr/bin/env node
// 发版预检：把「按下发布键之前该确认的一切」一次报全，只读、不改任何东西。
//
// 为什么值得单独一个脚本：发布是不可逆的外向操作，而它的前置条件散落在四处——git 状态、
// package.json 的版本号、线上已发布的 tag、三样凭证。`release.mjs` 里确实有闸，但那些闸是
// 发版**过程中**才触发的，撞上时人已经在等一条要跑 20-40 分钟的签名 + 公证流水线了。
// 这个脚本把撞墙的时刻提前到零成本的地方，并且一次报全部问题，而不是修一个撞下一个。
//
// 所有判据都从真实契约 import，不重新实现一遍——版本号规则改了这里自动跟上（ADR-0038）。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))

function findRepoRoot(start) {
  let dir = start
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'scripts', 'client-version.mjs'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const repoRoot = findRepoRoot(scriptDir)
if (!repoRoot) {
  process.stderr.write('找不到仓库根（向上十层都没有 scripts/client-version.mjs）。\n')
  process.exit(1)
}

const { HIGHEST_SHIPPED_VERSION, isVersionGreater, readPackageVersion } = await import(
  pathToFileURL(join(repoRoot, 'scripts', 'client-version.mjs')).href
)
const { releaseTag, winReleaseAssetFileNames, RELEASE_REPO } = await import(
  pathToFileURL(join(repoRoot, 'scripts', 'update-feed.mjs')).href
)
const { CORPUS_ENV_VARS, NOTARIZE_ENV_VARS, loadEnvFiles } = await import(
  pathToFileURL(join(repoRoot, 'scripts', 'package-rc.mjs')).href
)

const checks = []
let draftExists = false
/** blocker：不解决就不该发。warning：需要人判断，不一定拦。 */
function add(level, label, detail) {
  checks.push({ level, label, detail })
}

// stderr 一律吞掉：预检要自己决定怎么措辞。放任 git 的 fatal 直喷屏幕，会在「分支还没
// push」这类完全正常的情况下糊一屏红字，把真正的检查结果淹掉。
function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

// ── 1. git 状态 ─────────────────────────────────────────────
// 发版打的是工作区当前状态。在功能分支上发、或带着未提交改动发，产物与 main 上的代码
// 对不上，事后无从复现「用户手上那一版到底是什么」。
let branch = ''
try {
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'main') add('ok', '在 main 分支上', branch)
  else add('blocker', '不在 main 分支上', `当前在 ${branch}；发版要从 main 出，先把改动合进去`)

  const dirty = git(['status', '--porcelain'])
  if (dirty) {
    const n = dirty.split('\n').length
    add('blocker', '工作区有未提交改动', `${n} 个文件；先提交或清理，否则产物与 main 对不上`)
  } else {
    add('ok', '工作区干净', '')
  }

  let remoteKnown = true
  try {
    git(['fetch', 'origin', branch, '--quiet'])
  } catch {
    // 远端没有这个分支（新分支还没 push）与「没网」在这里表现相同，靠下面探一次远端 ref 区分。
    remoteKnown = false
  }
  try {
    git(['rev-parse', '--verify', `origin/${branch}`])
  } catch {
    remoteKnown = false
  }

  if (!remoteKnown) {
    add('warning', '远端没有这个分支', `origin 上找不到 ${branch}——还没 push，或者网络不通`)
  } else {
    const ahead = git(['rev-list', '--count', `origin/${branch}..HEAD`])
    const behind = git(['rev-list', '--count', `HEAD..origin/${branch}`])
    if (ahead === '0' && behind === '0') add('ok', '与远端同步', '')
    else add('blocker', '与远端不同步', `本地领先 ${ahead} 个、落后 ${behind} 个提交`)
  }
} catch (error) {
  add('blocker', 'git 状态读取失败', String(error?.message ?? error))
}

// ── 2. 版本号 ───────────────────────────────────────────────
// ADR-0038：版本号由人在 package.json 里定。它不会自己往上走，所以「忘了抬」是真实可能，
// 而后果是资产被传进已发布的 tag、线上文件被悄悄换掉而版本号没变，自动更新那边完全无感。
let version = null
try {
  version = readPackageVersion(repoRoot)
  add('ok', `版本号 ${version}`, 'package.json（ADR-0038 的唯一真相源）')

  if (isVersionGreater(version, HIGHEST_SHIPPED_VERSION)) {
    add('ok', `高于已交付的 ${HIGHEST_SHIPPED_VERSION}`, '存量用户能收到这一版')
  } else {
    add(
      'blocker',
      `没有高过已交付的 ${HIGHEST_SHIPPED_VERSION}`,
      '装了那一版的机器会认为自己已是最新，收不到更新且无任何提示——先抬 package.json 的 version',
    )
  }
} catch (error) {
  add('blocker', '版本号读取失败', String(error?.message ?? error))
}

// ── 3. 这个版本号是不是已经发过了 ──────────────────────────
if (version) {
  const tag = releaseTag(version)
  try {
    const out = execFileSync(
      'gh',
      ['release', 'view', tag, '--repo', RELEASE_REPO, '--json', 'isDraft'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const parsed = JSON.parse(out)
    if (parsed?.isDraft) {
      // draft 存在在新流程下是**正常状态**：Windows CI 出完包会直接建这个 draft 并把三件产物
      // 放进去（--win-from-release）。只有当里面没有 Windows 产物时，才可能是上次发版中途
      // 失败的残留。下面第 5 节会查里面到底有什么，这里只作中性陈述、不预判。
      draftExists = true
      add('ok', `${tag} 有 draft`, '发布时会往这个 draft 里补 mac 产物，最后翻成正式版')
    } else {
      add('blocker', `${tag} 已经发布过了`, '多半是忘了抬版本号；照原样发会把线上那一版的文件悄悄换掉')
    }
  } catch {
    add('warning', `${tag} 还没有 draft`, 'Windows 包还没出——先跑 gh workflow run windows-release-build.yml --ref main')
  }
}

// ── 4. 凭证（只报有无，绝不打印值）────────────────────────────
// bun 不把 .env 传给 node 子进程，所以脚本自己加载——与 package-rc.mjs / release.mjs 同款处置。
try {
  loadEnvFiles(repoRoot)
} catch (error) {
  add('warning', '.env 文件解析失败', String(error?.message ?? error))
}

// 这一版对用户是什么（docs/release-notes/<版本号>.md）。缺了不拦——紧急修复可能真没什么好说的，
// 但 0.3.1 那次发出去的是一句 CI 的内部占位串，没人在任何一道闸上看见过它，所以这里必须出声。
const highlightsFile = join(repoRoot, 'docs', 'release-notes', `${version}.md`)
if (existsSync(highlightsFile) && readFileSync(highlightsFile, 'utf8').trim().length > 0) {
  add('ok', `发布说明正文已写好`, `docs/release-notes/${version}.md`)
} else {
  add(
    'warning',
    '这一版没写发布说明正文',
    `发布说明会只剩通用样板（怎么升级 / 首次安装 / Windows 未签名提示），答不了「这一版改了什么」。想写就建 docs/release-notes/${version}.md`,
  )
}

const missingNotarize = NOTARIZE_ENV_VARS.filter((key) => !String(process.env[key] ?? '').trim())
if (missingNotarize.length === 0) add('ok', 'Apple 公证凭证齐备', `${NOTARIZE_ENV_VARS.length} 项`)
else add('blocker', 'Apple 公证凭证缺失', `缺 ${missingNotarize.join(' / ')}（配在 .env.local）`)

const missingCorpus = CORPUS_ENV_VARS.filter((key) => !String(process.env[key] ?? '').trim())
if (missingCorpus.length === 0) add('ok', '语料服务 token 齐备', '')
else
  add(
    'blocker',
    '语料 token 缺失',
    `缺 ${missingCorpus.join(' / ')}——它是构建期烧进产物的，缺了 App 照常能开，只是写作永远不注入真人范例（静默降质）`,
  )

try {
  execFileSync('node', [join(repoRoot, 'scripts', 'check-signing-identity.mjs')], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  add('ok', 'Developer ID 签名身份可用', '')
} catch {
  add('blocker', '找不到 Developer ID 签名身份', '钥匙串里没有可分发身份，mac 包签不了')
}

// ── 5. Windows 产物（给了目录才查）──────────────────────────
// 两个平台的更新清单都指向 releases/latest，所以只含单平台产物的 Release 一旦成为 latest，
// 另一边的清单查询直接 404、更新链就此断掉。带齐三件是发版的硬前提，不是可选项。
const winDirArg = process.argv.indexOf('--win-dir')
if (winDirArg !== -1 && process.argv[winDirArg + 1] && version) {
  const winDir = resolve(process.argv[winDirArg + 1])
  if (!existsSync(winDir)) {
    add('blocker', 'Windows 产物目录不存在', winDir)
  } else {
    const expected = winReleaseAssetFileNames(version)
    const missing = expected.filter((name) => !existsSync(join(winDir, name)))
    if (missing.length === 0) {
      add('ok', `Windows 三件产物齐全（${version}）`, winDir)
    } else {
      add(
        'blocker',
        'Windows 产物不齐或版本号对不上',
        `缺 ${missing.join(' / ')}——若目录里是别的版本号，说明 CI 出包时 package.json 还没抬到 ${version}，要重新出包`,
      )
    }
  }
} else if (version && draftExists) {
  // 新流程（--win-from-release）的主路径：产物在 draft 里，不在本机。
  const tag = releaseTag(version)
  const expected = winReleaseAssetFileNames(version)
  try {
    const out = execFileSync(
      'gh',
      ['release', 'view', tag, '--repo', RELEASE_REPO, '--json', 'assets'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const bySize = new Map((JSON.parse(out)?.assets ?? []).map((a) => [a.name, a.size]))
    const missing = expected.filter((n) => !bySize.has(n))
    const empty = expected.filter((n) => bySize.has(n) && !(bySize.get(n) > 0))
    if (missing.length === 0 && empty.length === 0) {
      add('ok', `Windows 三件已在 draft 就位（${version}）`, 'CI 直传，本机不需要下载')
    } else {
      add(
        'blocker',
        'draft 里的 Windows 产物不完整',
        `${[...missing.map((n) => `缺 ${n}`), ...empty.map((n) => `${n} 是空文件`)].join(' / ')}——重跑 gh workflow run windows-release-build.yml --ref main`,
      )
    }
  } catch {
    add('warning', '读不到 draft 的资产列表', '发布脚本会再核验一次；网络或权限问题不影响本地其余检查')
  }
} else {
  add(
    'warning',
    '没检查 Windows 产物',
    'Windows 包还没出：先跑 gh workflow run windows-release-build.yml --ref main（CI 会直接传进 draft）。发版必须双平台——只发一边会让另一边的更新链断掉',
  )
}

// ── 输出 ────────────────────────────────────────────────────
const icon = { ok: '✓', warning: '!', blocker: '✗' }
process.stdout.write('\n发版预检\n────────────────────────────────────────\n')
for (const c of checks) {
  process.stdout.write(`${icon[c.level]} ${c.label}${c.detail ? `\n    ${c.detail}` : ''}\n`)
}

const blockers = checks.filter((c) => c.level === 'blocker')
const warnings = checks.filter((c) => c.level === 'warning')
process.stdout.write('────────────────────────────────────────\n')
if (blockers.length === 0) {
  process.stdout.write(
    warnings.length ? `可以发版（${warnings.length} 条提醒需要你确认）\n\n` : '可以发版\n\n',
  )
} else {
  process.stdout.write(`还不能发：${blockers.length} 个问题要先解决\n\n`)
}
process.exitCode = blockers.length === 0 ? 0 : 1

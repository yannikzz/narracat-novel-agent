#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

/**
 * 客户端版本号 SSOT（ADR-0038）。
 *
 * **真相源是 `package.json` 的 `version`，由人在发版时决定**——不再从 `git rev-list --count HEAD`
 * 派生（ADR-0006 的旧机制，2026-08-30 停用）。
 *
 * 为什么换：派生方案把版本号绑在「当前分支的历史有多长」上，而不是「这是第几次发布」上。
 * 后果实测过——Windows 适配分支上 CI 出的包是 `0.2.92`（分支 92 个提交），而 squash 合并后
 * 主干只有 `0.2.75`，那台已装 `0.2.92` 的机器从此收不到任何更新，且不报错、不提示。
 * 同族问题还有三个：换分支就换号、squash 让计数回落、历史重写会重置（已因此被迫把版本线
 * 从 `0.1` 抬到 `0.2` 一次）。Windows 成为第二个分发平台后还多一条：mac 本机打包（签名+公证）
 * 与 Windows CI 出包检出的提交数必然错开，两平台无法同号。
 */

/** 版本号格式正则（SSOT——校验方一律用它，不要各自手写 `^0\.3\.` 这类硬编码） */
export const CLIENT_VERSION_RE = /^\d+\.\d+\.\d+$/

/**
 * 已交付到用户手上的最高版本。**新版本号必须严格大于它**，否则 electron-updater 认为
 * 用户已是最新，那批机器就此掉队（静默，无任何提示）。
 *
 * 当前值 `0.3.0` = 2026-08-30 发布的首个双平台版本（mac + Windows 各自的更新链均已实测 200）。
 *
 * **发版之后要做两件事，缺一不可**（2026-08-30 发 0.3.0 时才发现这是一对）：
 *   ① 把这个常量抬到刚发出去的版本——它是那道「手滑把版本改小 / 忘了 bump」的闸的唯一依据
 *   ② 同时把 `package.json` 的 version 抬到下一个开发版本（如 `0.3.1`）
 * 只做①会让 `client-version.test.mjs` 当场变红：断言是 package.json 的 version **严格大于**
 * 本常量，而刚发完时两者相等。这不是断言写歪了——严格大于正是「忘了 bump 就发版」的拦截力
 * 所在，改成 `>=` 等于把闸拆了。两件一起做，仓库就始终停在「下一版待发」的状态上。
 */
export const HIGHEST_SHIPPED_VERSION = '0.3.0'

/** semver 三段比较：a > b。只处理 `x.y.z`，本仓不发预发布版（feed 只认 releases/latest）。 */
export function isVersionGreater(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i]
  }
  return false
}

export function readPackageVersion(root = repoRoot, { readFile = readFileSync } = {}) {
  const manifestPath = join(root, 'package.json')
  let manifest

  try {
    manifest = JSON.parse(readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`读不到或解析不了 ${manifestPath}：${error?.message ?? error}`)
  }

  const version = manifest?.version
  if (typeof version !== 'string' || !CLIENT_VERSION_RE.test(version)) {
    throw new Error(
      `package.json 的 version 必须是 x.y.z 三段数字版本号，实际是：${JSON.stringify(version)}`,
    )
  }

  return version
}

/**
 * 无覆盖版本解析。留给 release.mjs 正式发布与 ops-check——免得环境变量残留把正式版本号打歪。
 */
export function resolveClientVersion({ root = repoRoot, readVersion = readPackageVersion } = {}) {
  return readVersion(root)
}

export const CLIENT_VERSION_OVERRIDE_ENV = 'NARRACAT_CLIENT_VERSION'

/**
 * 带覆盖的版本解析（打包链上所有取版本号的地方都必须经这里）。
 *
 * 为什么保留覆盖（与 ADR-0038 的换源正交，机制原样不动）：本地临时测试包有时需要压过线上正式版，
 * 否则 electron-updater 配的 autoDownload + autoInstallOnAppQuit 会静默把测试包换成线上版本，
 * 真机验收因此测到老引擎且日志里毫无痕迹（真实踩过，#48 验收第二轮整份日志作废）。
 *
 * 为什么必须是 SSOT：版本号在打包链上有**两条**独立取值路径——
 *   ① electron-builder `--config.extraMetadata.version` → Info.plist / asar package.json
 *      （app.getVersion()，自动更新比较用的就是它）
 *   ② electron.vite.config.ts 构建期 define `__NARRACAT_CLIENT_VERSION__`
 *      （经本文件的 CLI 入口取值）→ 设置页「关于」展示用的就是它
 * 只覆盖 ① 的话，包不会被自动更新换掉，但设置页显示的仍是 manifest 版本——两个数字对不上，
 * 用户没法确认自己在跑哪个版本（真实踩过：装了 0.1.9999 的包，设置页显示 0.1.64）。
 */
export function resolveOverridableClientVersion({
  root = repoRoot,
  env = process.env,
  readVersion = readPackageVersion,
} = {}) {
  const override = String(env[CLIENT_VERSION_OVERRIDE_ENV] ?? '').trim()
  if (!override) return resolveClientVersion({ root, readVersion })
  if (!CLIENT_VERSION_RE.test(override)) {
    throw new Error(
      `${CLIENT_VERSION_OVERRIDE_ENV} 必须是 x.y.z 三段数字版本号，实际收到：${override}`,
    )
  }
  return override
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // CLI 入口唯一的调用方是 electron.vite.config.ts（构建期 define 取值），故走带覆盖的那支；
  // release.mjs / ops-check.mjs 用的是 import 的 resolveClientVersion，不受影响。
  process.stdout.write(`${resolveOverridableClientVersion({ root: process.cwd() })}\n`)
}

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertArtifactsNotStale,
  assertWinAssetsInDraft,
  lastProductChangeIso,
  assertArtifactsNotarized,
  assertInteractive,
  assertVersionNotAlreadyReleased,
  assertZipMatchesManifest,
  assertManifestMatchesVersion,
  createReleasePlan,
  formatConfirmation,
  parseReleaseArgs,
  publishRelease,
  readVersionHighlights,
  readReleaseAssets,
  readReleaseState,
} from './release.mjs'
import { releaseAssetFileNames } from './update-feed.mjs'

describe('createReleasePlan', () => {
  const plan = createReleasePlan({ clientVersion: '0.1.1880' })

  test('tag 与目标仓正确', () => {
    expect(plan.tag).toBe('v0.1.1880')
    expect(plan.repo).toBe('yannikzz/narracat-novel-agent')
  })

  test('五个资产齐全且清单排在最后', () => {
    expect(plan.assets.map((file) => file.split('/').pop())).toEqual([
      'NarraCat-0.1.1880-mac-arm64.zip',
      'NarraCat-0.1.1880-mac-arm64.zip.blockmap',
      'NarraCat-0.1.1880-mac-arm64.dmg',
      'NarraCat-0.1.1880-mac-arm64.dmg.blockmap',
      'latest-mac.yml',
    ])
  })

  // 不勾 Pre-release：releases/latest 不含预发布版，勾了 Worker 就找不到最新版。
  test('标题不带内测字样（决策 8a：开源之后「内部测试」概念已不成立），且不是预发布', () => {
    expect(plan.title).toBe('NarraCat 0.1.1880')
    expect(plan.title).not.toContain('内测')
    expect(plan.prerelease).toBe(false)
  })
})

describe('Windows 发版通道（Windows 战役 2026-08-16）', () => {
  test('不传 winDir 时资产只有 mac 五件（不会凭空要求 Windows 产物）', () => {
    const plan = createReleasePlan({ clientVersion: '0.1.1880', distDir: '/d' })
    expect(plan.assets).toHaveLength(5)
  })

  test('传 winDir 时 mac 五件 + win 三件一起发', () => {
    const plan = createReleasePlan({ clientVersion: '0.1.1880', distDir: '/d', winDir: '/w' })
    expect(plan.assets).toEqual([
      '/d/NarraCat-0.1.1880-mac-arm64.zip',
      '/d/NarraCat-0.1.1880-mac-arm64.zip.blockmap',
      '/d/NarraCat-0.1.1880-mac-arm64.dmg',
      '/d/NarraCat-0.1.1880-mac-arm64.dmg.blockmap',
      '/d/latest-mac.yml',
      '/w/NarraCat-0.1.1880-win-x64.exe',
      '/w/NarraCat-0.1.1880-win-x64.exe.blockmap',
      '/w/latest.yml',
    ])
  })

  // Windows 清单来自 CI 下载的目录，同样可能陈旧（下错 run、复用旧目录）。
  test('Windows 清单陈旧同样拦下（latest.yml 与本次版本不符）', () => {
    expect(() =>
      assertManifestMatchesVersion({
        manifestContent: 'version: 0.1.1879\nfiles:\n  - url: NarraCat-0.1.1879-win-x64.exe\n',
        clientVersion: '0.1.1880',
        assetFileName: 'NarraCat-0.1.1880-win-x64.exe',
      }),
    ).toThrow(/与本次待发版本不符/)
  })
})

describe('assertManifestMatchesVersion', () => {
  const zipFileName = 'NarraCat-0.1.1880-mac-arm64.zip'
  const validManifest = [
    'version: 0.1.1880',
    'files:',
    `  - url: ${zipFileName}`,
    '    sha512: abc123',
    '    size: 1024',
    `path: ${zipFileName}`,
    'sha512: abc123',
    "releaseDate: '2026-08-11T00:00:00.000Z'",
    '',
  ].join('\n')

  test('版本号与 zip 文件名都对得上时放行', () => {
    expect(() =>
      assertManifestMatchesVersion({ manifestContent: validManifest, clientVersion: '0.1.1880', assetFileName: zipFileName }),
    ).not.toThrow()
  })

  // I3 的核心场景：dist/ 是累积目录，electron-builder 这次没重新生成清单，
  // 一份陈旧清单会被原样推上生产——全流程 exit 0，确认闸照常打印新版本号。
  test('清单版本号与本次待发版本不符时拒绝', () => {
    expect(() =>
      assertManifestMatchesVersion({ manifestContent: validManifest, clientVersion: '0.1.1881', assetFileName: zipFileName }),
    ).toThrow('与本次待发版本不符')
  })

  test('清单 files 里找不到本次 zip 文件名时拒绝', () => {
    expect(() =>
      assertManifestMatchesVersion({
        manifestContent: validManifest,
        clientVersion: '0.1.1880',
        assetFileName: 'NarraCat-0.1.1881-mac-arm64.zip',
      }),
    ).toThrow('与本次待发版本不符')
  })

  test('清单内容损坏时给出可读错误而不是原始解析异常', () => {
    expect(() =>
      assertManifestMatchesVersion({ manifestContent: '::: not yaml :::', clientVersion: '0.1.1880', assetFileName: zipFileName }),
    ).toThrow('latest-mac.yml 解析失败')
  })
})

describe('formatConfirmation', () => {
  test('列出版本号、目标仓、tag 与每个文件的大小', () => {
    const text = formatConfirmation({
      clientVersion: '0.1.1880',
      repo: 'yannikzz/narracat-novel-agent',
      tag: 'v0.1.1880',
      files: [
        { name: 'NarraCat-0.1.1880-mac-arm64.zip', bytes: 288_358_400 },
        { name: 'latest-mac.yml', bytes: 512 },
      ],
    })
    expect(text).toContain('0.1.1880')
    expect(text).toContain('yannikzz/narracat-novel-agent')
    expect(text).toContain('v0.1.1880')
    expect(text).toContain('275.0 MB')
    expect(text).toContain('0.5 KB')
  })

  // I6：发布仓是人工定向同步的镜像仓，tag 不存在时 gh 会基于它当前默认分支创建，
  // 未必已同步到本次代码——不影响用户下载（资产是我们上传的文件），但操作者应
  // 在敲 yes 前知道 git 历史可能对不上。
  test('提醒 tag 基于发布仓默认分支创建、可能与本次代码不一致', () => {
    const text = formatConfirmation({
      clientVersion: '0.1.1880',
      repo: 'yannikzz/narracat-novel-agent',
      tag: 'v0.1.1880',
      files: [],
    })
    expect(text).toContain('默认分支')
    expect(text).toContain('不影响用户下载与自动更新')
  })
})

describe('publishRelease', () => {
  const plan = createReleasePlan({ clientVersion: '0.1.1880' })

  function record() {
    const calls = []
    publishRelease(plan, { run: (args) => calls.push(args) })
    return calls
  }

  // 本脚本风险最高的一段（真正改动线上 release），此前完全没有单测覆盖——
  // 变异实验证实删掉某条 upload 的 --repo，10 pass 0 fail 仍然全绿。
  test('调用顺序是 create → 逐个 upload → edit', () => {
    const calls = record()
    expect(calls.length).toBe(1 + plan.assets.length + 1)
    expect(calls[0][0]).toBe('release')
    expect(calls[0][1]).toBe('create')
    for (let i = 0; i < plan.assets.length; i++) {
      expect(calls[1 + i][1]).toBe('upload')
    }
    expect(calls.at(-1)[1]).toBe('edit')
  })

  test('create 带 --draft，edit 带 --draft=false 与 --latest', () => {
    const calls = record()
    expect(calls[0]).toContain('--draft')
    expect(calls.at(-1)).toContain('--draft=false')
    expect(calls.at(-1)).toContain('--latest')
  })

  test('每一条命令都带 --repo 且值是发布仓', () => {
    const calls = record()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      const repoIndex = call.indexOf('--repo')
      expect(repoIndex).toBeGreaterThan(-1)
      expect(call[repoIndex + 1]).toBe(plan.repo)
    }
  })

  test('upload 带 --clobber', () => {
    const calls = record()
    const uploadCalls = calls.filter((call) => call[1] === 'upload')
    expect(uploadCalls.length).toBe(plan.assets.length)
    for (const call of uploadCalls) {
      expect(call).toContain('--clobber')
    }
  })

  test('资产数量是 5，且上传顺序与 releaseAssetFileNames 一致', () => {
    const calls = record()
    const uploadedFileNames = calls.filter((call) => call[1] === 'upload').map((call) => call[3].split('/').pop())
    expect(uploadedFileNames.length).toBe(5)
    expect(uploadedFileNames).toEqual(releaseAssetFileNames('0.1.1880'))
  })

  test('任何一条命令都不含 --prerelease', () => {
    const calls = record()
    for (const call of calls) {
      expect(call).not.toContain('--prerelease')
    }
  })
})

describe('publishRelease 中途失败后重跑撞 tag 已存在', () => {
  const plan = createReleasePlan({ clientVersion: '0.1.1880' })

  test('create 失败且 tag 确实已存在：抛出可操作的中文恢复指引，仍非零退出（抛错）', () => {
    const calls = []
    const run = (args) => {
      calls.push(args)
      if (args[1] === 'create') throw new Error('gh: HTTP 422 already_exists')
      // release view 探测：不抛错即视为「命中，tag 已存在」
    }
    expect(() => publishRelease(plan, { run })).toThrow('已存在 tag')

    let message = ''
    try {
      publishRelease(plan, { run: (args) => run(args) })
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('gh release delete')
    expect(message).toContain(plan.repo)
    expect(message).toContain(plan.tag)

    // 探测本身也要显式带 --repo，且不会继续 upload/edit（release 停在 draft，零影响）。
    const viewCall = calls.find((call) => call[1] === 'view')
    expect(viewCall).toBeDefined()
    expect(viewCall).toContain('--repo')
    expect(calls.some((call) => call[1] === 'upload')).toBe(false)
    expect(calls.some((call) => call[1] === 'edit')).toBe(false)
  })

  test('create 失败但 tag 其实不存在（别的原因）：原样抛出原始错误，不被误判', () => {
    const run = (args) => {
      if (args[1] === 'create') throw new Error('gh: 认证失败，请先 gh auth login')
      if (args[1] === 'view') throw new Error('release not found')
    }
    expect(() => publishRelease(plan, { run })).toThrow('认证失败')
  })
})

describe('assertInteractive', () => {
  // 无 TTY 时 readline 的 question() 永不 resolve，Node 会以 exit 0 静默退出——
  // 不上传（安全），但签名+公证已白跑几分钟且看起来像「成功」。故提前拦死。
  test('非交互终端拒绝发版', () => {
    expect(() => assertInteractive(false)).toThrow('人工确认')
  })

  test('交互终端放行', () => {
    expect(() => assertInteractive(true)).not.toThrow()
  })
})

describe('复用现成产物的三道加严闸（--use-existing-artifacts）', () => {
  const VERSION = '0.2.64'

  async function makeDist({ zipBody = 'ZIPDATA', manifestSha } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'reuse-'))
    const distDir = join(dir, 'dist')
    await mkdir(join(distDir, 'mac-arm64', 'NarraCat.app'), { recursive: true })
    const zipName = `NarraCat-${VERSION}-mac-arm64.zip`
    await writeFile(join(distDir, zipName), zipBody)
    await writeFile(join(distDir, `NarraCat-${VERSION}-mac-arm64.dmg`), 'DMG')
    const sha = manifestSha ?? createHash('sha512').update(zipBody).digest('base64')
    await writeFile(
      join(distDir, 'latest-mac.yml'),
      `version: ${VERSION}\nfiles:\n  - url: ${zipName}\n    sha512: ${sha}\npath: ${zipName}\nsha512: ${sha}\n`,
    )
    return { dir, distDir, plan: createReleasePlan({ clientVersion: VERSION, distDir }) }
  }

  test('票据闸：dmg 或 app 没装订就必须拒绝——「公证提交成功」不等于「票据装订上了」', async () => {
    const { dir, distDir, plan } = await makeDist()
    try {
      // 全部验过 → 放行
      expect(() =>
        assertArtifactsNotarized(plan, { distDir, validate: () => true }),
      ).not.toThrow()
      // 任何一个没票据 → 拒绝（真机撞过的正是 dmg 裸着这一种）
      expect(() =>
        assertArtifactsNotarized(plan, { distDir, validate: (t) => !t.endsWith('.dmg') }),
      ).toThrow(/没有装订公证票据/)
      expect(() =>
        assertArtifactsNotarized(plan, { distDir, validate: (t) => t.endsWith('.dmg') }),
      ).toThrow(/没有装订公证票据/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('zip 闸：sha512 对不上就必须拒绝——这是自动更新的命脉', async () => {
    const good = await makeDist()
    try {
      expect(() => assertZipMatchesManifest(good.plan)).not.toThrow()
    } finally {
      await rm(good.dir, { recursive: true, force: true })
    }

    const bad = await makeDist({ manifestSha: 'AAAA-来自另一次打包的清单' })
    try {
      expect(() => assertZipMatchesManifest(bad.plan)).toThrow(/自动更新会在用户机器上校验失败/)
    } finally {
      await rm(bad.dir, { recursive: true, force: true })
    }
  })

  test('陈旧闸：产物早于最后一次产物代码改动就必须拒绝——防「改完代码忘了重新打包」', async () => {
    const { dir, distDir, plan } = await makeDist()
    try {
      // 刚建出来的产物晚于 HEAD → 放行
      expect(() => assertArtifactsNotStale(plan, { distDir })).not.toThrow()
      // 把产物时间推回 2020 年 → 拒绝
      const app = join(distDir, 'mac-arm64', 'NarraCat.app')
      await utimes(app, new Date('2020-01-01'), new Date('2020-01-01'))
      expect(() => assertArtifactsNotStale(plan, { distDir })).toThrow(/不含最新代码/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('版本号重复闸（ADR-0038 补的第二道）', () => {
  // 派生时代版本号只增不减、天然不可能重复；改成人在 package.json 里定之后，「忘了 bump 就发版」
  // 成了真实可能，而它**不报错**——资产会被 --clobber 传进已发布的 tag，线上文件被悄悄换掉、
  // 版本号没变，electron-updater 完全无感。这一组就是那道闸。

  test('tag 不存在：放行（正常发版路径）', () => {
    expect(() =>
      assertVersionNotAlreadyReleased('0.3.0', { readState: () => null }),
    ).not.toThrow()
  })

  test('tag 存在但停在 draft：放行，交给既有的恢复引导', () => {
    // draft 是上次发版中途某个资产上传失败的残留，与「忘了 bump」是两回事：
    // draft 不被匿名 API 与 releases/latest 看见，线上仍是上一版，重跑是安全的。
    expect(() =>
      assertVersionNotAlreadyReleased('0.3.0', { readState: () => ({ isDraft: true }) }),
    ).not.toThrow()
  })

  test('tag 已发布：fail-loud，并指出多半是忘了抬版本号', () => {
    let error
    try {
      assertVersionNotAlreadyReleased('0.3.0', { readState: () => ({ isDraft: false }) })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('v0.3.0')
    expect(error.message).toContain('package.json')
    // 报错必须给出下一步怎么办，否则撞上的人只能来读源码
    expect(error.message).toContain('0.3.1')
    expect(error.message).toContain('release delete')
  })

  test('传给闸的是 tag 而不是裸版本号（少一个 v 就查错对象、恒放行）', () => {
    const seen = []
    assertVersionNotAlreadyReleased('0.3.0', {
      readState: (tag) => {
        seen.push(tag)
        return null
      },
    })

    expect(seen).toEqual(['v0.3.0'])
  })

  test('readReleaseState：gh 报错（tag 不存在）时返回 null，不把发版流程炸掉', () => {
    expect(
      readReleaseState('v9.9.9', {
        execFile: () => {
          throw new Error('release not found')
        },
      }),
    ).toBeNull()
  })

  test('readReleaseState：正常返回时解析出 isDraft', () => {
    expect(
      readReleaseState('v0.3.0', { execFile: () => JSON.stringify({ isDraft: true }) }),
    ).toEqual({ isDraft: true })
  })
})

describe('发版覆盖平台必须显式声明', () => {
  // 「不给参数就只发 mac」这个默认在只有 mac 的时代是对的；Windows 成为正式分发平台后
  // 它变成静默陷阱——命令照常成功，只是这一版没有 Windows 包，Windows 用户静默跳过、
  // 收不到更新也不知道为什么。失败的表现不是报错，是安静地少做一件事。

  test('什么都不给：炸，并把两条正确用法都写出来', () => {
    let error
    try {
      parseReleaseArgs(['node', 'release.mjs'])
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('--with-win')
    expect(error.message).toContain('--mac-only')
    // 只说「不许」没用，必须告诉人怎么拿到 Windows 产物
    expect(error.message).toContain('windows-release-build.yml')
    // 选了只发 mac 的真实代价要当场说清楚：不是「停在上一版」，是更新链断掉
    expect(error.message).toContain('releases/latest')
    expect(error.message).toContain('404')
  })

  test('--mac-only：放行，winDir 为空（这是主动选择，不是默认）', () => {
    expect(parseReleaseArgs(['node', 'release.mjs', '--mac-only'])).toEqual({
      winDir: undefined,
      winFromRelease: false,
      useExistingArtifacts: false,
    })
  })

  test('--with-win <目录>：放行，目录解析成绝对路径', () => {
    const parsed = parseReleaseArgs(['node', 'release.mjs', '--with-win', '/tmp/win-artifacts'])

    expect(parsed.winDir).toBe('/tmp/win-artifacts')
    expect(parsed.useExistingArtifacts).toBe(false)
  })

  test('两个都给：矛盾指令，炸而不是猜', () => {
    expect(() =>
      parseReleaseArgs(['node', 'release.mjs', '--mac-only', '--with-win', '/tmp/win']),
    ).toThrow('互斥')
  })

  test('--with-win 缺值仍然炸——后面跟另一个 flag 不算取值', () => {
    // 静默退化成「只发 mac」正是本组要杜绝的
    expect(() =>
      parseReleaseArgs(['node', 'release.mjs', '--with-win', '--use-existing-artifacts']),
    ).toThrow('--with-win 缺少取值')
    expect(() => parseReleaseArgs(['node', 'release.mjs', '--with-win'])).toThrow(
      '--with-win 缺少取值',
    )
  })

  test('--use-existing-artifacts 与覆盖平台正交', () => {
    expect(
      parseReleaseArgs(['node', 'release.mjs', '--mac-only', '--use-existing-artifacts']),
    ).toEqual({ winDir: undefined, winFromRelease: false, useExistingArtifacts: true })
  })
})

describe('CI 直传 draft（--win-from-release）', () => {
  // 2026-08-30：产物 244MB、国内实测下载约 23KB/s（3 小时），「下载再上传」那条路把发版卡死。
  // 改由 CI 在 GitHub 内网直传 draft。人工确认闸一步没少——draft 不被 releases/latest 看见。

  const plan = () => createReleasePlan({ clientVersion: '0.3.0', winFromRelease: true })

  test('winFromRelease 时 Windows 产物不进本地上传清单，但记进 remoteWinAssets', () => {
    const p = plan()

    expect(p.assets.some((a) => a.includes('win-x64'))).toBe(false)
    expect(p.assets.length).toBeGreaterThan(0) // mac 五件仍在
    expect(p.remoteWinAssets).toEqual([
      'NarraCat-0.3.0-win-x64.exe',
      'NarraCat-0.3.0-win-x64.exe.blockmap',
      'latest.yml',
    ])
  })

  test('release notes 仍要认出这一版含 Windows（否则少掉 SmartScreen 提示）', () => {
    // notes 的 hasWindows 原本只看本地 assets；直传后那里没有 win 文件了，
    // 漏改的话 Windows 用户拿到的说明里不会提「未签名会弹蓝屏警告」。
    const confirmation = formatConfirmation({
      clientVersion: '0.3.0',
      repo: 'x/y',
      tag: 'v0.3.0',
      files: [],
    })
    expect(typeof confirmation).toBe('string')

    const p = plan()
    expect(p.remoteWinAssets.some((f) => f.endsWith('-win-x64.exe'))).toBe(true)
  })

  test('三件齐全且非空：放行', () => {
    expect(() =>
      assertWinAssetsInDraft(plan(), {
        readAssets: () => [
          { name: 'NarraCat-0.3.0-win-x64.exe', size: 256337009 },
          { name: 'NarraCat-0.3.0-win-x64.exe.blockmap', size: 270336 },
          { name: 'latest.yml', size: 352 },
        ],
      }),
    ).not.toThrow()
  })

  test('缺件：fail-loud，并说清后果与重跑办法', () => {
    let error
    try {
      assertWinAssetsInDraft(plan(), {
        readAssets: () => [{ name: 'NarraCat-0.3.0-win-x64.exe', size: 256337009 }],
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('blockmap')
    expect(error.message).toContain('latest.yml')
    expect(error.message).toContain('windows-release-build.yml')
    // 后果必须写明：不是「少一个包」，是另一条更新链会断
    expect(error.message).toContain('404')
  })

  test('0 字节资产：上传中断留下的空壳，同样拦下', () => {
    // 名字齐全、下下来是空文件——只查名字的话这种会溜过去。
    expect(() =>
      assertWinAssetsInDraft(plan(), {
        readAssets: () => [
          { name: 'NarraCat-0.3.0-win-x64.exe', size: 0 },
          { name: 'NarraCat-0.3.0-win-x64.exe.blockmap', size: 270336 },
          { name: 'latest.yml', size: 352 },
        ],
      }),
    ).toThrow('空文件')
  })

  test('读不到资产列表：不猜，直接中止', () => {
    expect(() => assertWinAssetsInDraft(plan(), { readAssets: () => null })).toThrow('读不到')
  })

  test('非 winFromRelease 时本函数不做任何事（不误伤 --with-win / --mac-only）', () => {
    const macOnly = createReleasePlan({ clientVersion: '0.3.0' })
    let called = false
    assertWinAssetsInDraft(macOnly, {
      readAssets: () => {
        called = true
        return []
      },
    })
    expect(called).toBe(false)
  })

  test('draftExists 时不再 create——CI 已经建好了，再建会撞「tag 已存在」', () => {
    const calls = []
    publishRelease(plan(), { run: (args) => calls.push(args[1]), draftExists: true })

    expect(calls).not.toContain('create')
    expect(calls).toContain('upload')
    expect(calls).toContain('edit')
  })

  /**
   * 0.3.1 的真实事故：走 --win-from-release 时跳过 create，而 notes 只挂在 create 上，
   * 于是 CI 建 draft 时写的内部占位串「草稿：等待 mac 产物…」被当成发布说明发给了所有用户，
   * 连「Windows 未签名会撞 SmartScreen」那段该告诉用户的话都一起丢了。
   * 上一条测试只看了动词序列（没 create、有 upload、有 edit）——它证明了「不重复建」，
   * 却没人问「那谁来写发布说明」。这两条补的就是那个缺口。
   */
  test('draftExists 时发布说明仍然由脚本定稿，不留 CI 的占位串', () => {
    const calls = []
    publishRelease(plan(), { run: (args) => calls.push(args), draftExists: true })

    const edit = calls.at(-1)
    expect(edit[1]).toBe('edit')
    const notes = edit[edit.indexOf('--notes') + 1]
    expect(notes).toContain('NarraCat')
    expect(notes).not.toContain('草稿')
    expect(notes).not.toContain('等待 mac 产物')
  })

  test('写了每版正文时，它排在发布说明最前面（用户先看到「这版改了什么」）', () => {
    const calls = []
    publishRelease(
      { ...plan(), highlights: '这一版加了匿名使用统计。' },
      { run: (args) => calls.push(args), draftExists: true },
    )

    const edit = calls.at(-1)
    const notes = edit[edit.indexOf('--notes') + 1]
    expect(notes).toContain('这一版加了匿名使用统计。')
    // 排在「怎么升级」之前：用户打开 Release 页最先想知道的是这版改了什么。
    expect(notes.indexOf('这一版加了匿名使用统计。')).toBeLessThan(notes.indexOf('自动收到更新'))
  })

  test('没写每版正文时退回通用样板，不留空标题', () => {
    const calls = []
    publishRelease({ ...plan(), highlights: null }, { run: (args) => calls.push(args), draftExists: true })

    const edit = calls.at(-1)
    const notes = edit[edit.indexOf('--notes') + 1]
    expect(notes).toContain('自动收到更新')
    expect(notes).not.toContain('\n\n\n')
  })

  test('带 Windows 产物时，未签名提示必须出现在发布说明里', () => {
    const calls = []
    publishRelease(plan(), { run: (args) => calls.push(args), draftExists: true })

    const edit = calls.at(-1)
    const notes = edit[edit.indexOf('--notes') + 1]
    expect(notes).toContain('尚未代码签名')
  })

  test('draftExists 为假时仍然照常 create（老路径不受影响）', () => {
    const calls = []
    publishRelease(createReleasePlan({ clientVersion: '0.3.0', winDir: '/tmp/w' }), {
      run: (args) => calls.push(args[1]),
    })

    expect(calls[0]).toBe('create')
  })

  test('readVersionHighlights：文件不存在返回 null，不抛', () => {
    expect(
      readVersionHighlights('9.9.9', {
        read: () => {
          throw new Error('ENOENT')
        },
      }),
    ).toBeNull()
  })

  test('readVersionHighlights：文件只有空白也算没写', () => {
    expect(readVersionHighlights('9.9.9', { read: () => '   \n\n  ' })).toBeNull()
  })

  test('formatConfirmation 把真正会发出去的发布说明打出来——最后一道人工闸要看得见', () => {
    const text = formatConfirmation({
      clientVersion: '0.3.2',
      repo: 'x/y',
      tag: 'v0.3.2',
      files: [{ name: 'a.dmg', bytes: 1 }],
      notes: 'NarraCat 0.3.2。\n这一版改了什么。',
    })
    expect(text).toContain('这一版改了什么。')
    expect(text).toContain('用户在 Release 页会读到这段')
  })

  test('readReleaseAssets：读不到时返回 null 而不是抛', () => {
    expect(
      readReleaseAssets('v9.9.9', {
        execFile: () => {
          throw new Error('not found')
        },
      }),
    ).toBeNull()
    expect(
      readReleaseAssets('v0.3.0', {
        execFile: () => JSON.stringify({ assets: [{ name: 'a.exe', size: 5 }] }),
      }),
    ).toEqual([{ name: 'a.exe', size: 5 }])
  })
})

describe('stale 闸比的是「最后一次影响产物的改动」而非 HEAD', () => {
  // 2026-08-30 实撞：#62 只改了发版脚本与文档，却把一份刚验收过的 mac 包判成「比当前提交还旧」，
  // 逼人重打一份逐字节相同的包（20-40 分钟，大部分在等 Apple 公证）。
  // 闸的语义一直是「产物不能比它所代表的代码旧」，HEAD 时间只是那个语义的粗糙代理。

  const { mkdtempSync, mkdirSync, utimesSync } = require('node:fs')
  const { tmpdir } = require('node:os')

  function fakeDist(builtAtMs) {
    const dir = mkdtempSync(join(tmpdir(), 'narracat-stale-'))
    const app = join(dir, 'mac-arm64', 'NarraCat.app')
    mkdirSync(app, { recursive: true })
    utimesSync(app, new Date(builtAtMs), new Date(builtAtMs))
    return dir
  }

  const plan = () => createReleasePlan({ clientVersion: '0.3.0' })

  test('产物晚于最后一次产物改动：放行', () => {
    const distDir = fakeDist(Date.parse('2026-08-30T20:34:00+08:00'))
    expect(() =>
      assertArtifactsNotStale(plan(), {
        distDir,
        readProductChangeIso: () => '2026-08-30T17:32:28+08:00',
      }),
    ).not.toThrow()
  })

  test('产物早于最后一次产物改动：仍然拦（闸没被改松）', () => {
    const distDir = fakeDist(Date.parse('2026-08-30T16:00:00+08:00'))
    expect(() =>
      assertArtifactsNotStale(plan(), {
        distDir,
        readProductChangeIso: () => '2026-08-30T17:32:28+08:00',
      }),
    ).toThrow('不含最新代码')
  })

  test('核心场景：只改文档/发版脚本之后，产物不该被判过期', () => {
    // 产物 20:34 打的；之后 21:18 合了一个只动发版脚本与文档的提交。
    // 旧实现拿 HEAD(21:18) 比 → 误拦；新实现拿最后一次产物改动(17:32) 比 → 放行。
    const distDir = fakeDist(Date.parse('2026-08-30T20:34:00+08:00'))
    expect(() =>
      assertArtifactsNotStale(plan(), {
        distDir,
        readProductChangeIso: () => '2026-08-30T17:32:28+08:00',
      }),
    ).not.toThrow()
  })

  test('产物不存在时直接放行（没东西可复用，交给打包流程）', () => {
    expect(() =>
      assertArtifactsNotStale(plan(), {
        distDir: join(tmpdir(), 'narracat-does-not-exist-' + Date.now()),
        readProductChangeIso: () => '2999-01-01T00:00:00+08:00',
      }),
    ).not.toThrow()
  })

  test('排除清单确实把文档/CI/发版脚本/测试排掉了，且没排掉产物代码', () => {
    let captured = null
    lastProductChangeIso({
      execFile: (_cmd, args) => {
        captured = args
        return '2026-08-30T17:32:28+08:00'
      },
    })

    const spec = captured.join(' ')
    // 确定不进产物的
    for (const excluded of ['docs/', '.github/', '.claude/', 'workers/', '*.md', 'scripts/release.mjs', '*.test.mjs']) {
      expect(spec).toContain(`:(exclude)${excluded}`)
    }
    // 决定产物内容的绝不能出现在排除清单里——漏一条就会发出不含新代码的包
    for (const mustNotExclude of ['electron/', 'src/', 'shared/', 'agent-core/', 'resources/', 'package.json', 'electron.vite.config.ts', 'scripts/package-rc.mjs', 'scripts/prepare-']) {
      expect(spec).not.toContain(`:(exclude)${mustNotExclude}`)
    }
  })

  test('拿不到范围内的结果时回退 HEAD——宁可误判重打，不可放过真过期的产物', () => {
    const calls = []
    const iso = lastProductChangeIso({
      execFile: (_cmd, args) => {
        calls.push(args)
        return calls.length === 1 ? '' : '2026-08-30T21:18:32+08:00'
      },
    })

    expect(iso).toBe('2026-08-30T21:18:32+08:00')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(['log', '-1', '--format=%cI']) // 第二次是不带 pathspec 的 HEAD
  })
})

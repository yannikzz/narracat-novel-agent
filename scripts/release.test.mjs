import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertArtifactsNotStale,
  assertArtifactsNotarized,
  assertInteractive,
  assertVersionNotAlreadyReleased,
  assertZipMatchesManifest,
  assertManifestMatchesVersion,
  createReleasePlan,
  formatConfirmation,
  parseReleaseArgs,
  publishRelease,
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

  test('陈旧闸：产物早于 HEAD 提交就必须拒绝——防「改完代码忘了重新打包」', async () => {
    const { dir, distDir, plan } = await makeDist()
    try {
      // 刚建出来的产物晚于 HEAD → 放行
      expect(() => assertArtifactsNotStale(plan, { distDir })).not.toThrow()
      // 把产物时间推回 2020 年 → 拒绝
      const app = join(distDir, 'mac-arm64', 'NarraCat.app')
      await utimes(app, new Date('2020-01-01'), new Date('2020-01-01'))
      expect(() => assertArtifactsNotStale(plan, { distDir })).toThrow(/产物比当前提交还旧/)
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
    ).toEqual({ winDir: undefined, useExistingArtifacts: true })
  })
})

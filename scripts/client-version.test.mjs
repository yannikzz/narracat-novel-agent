import { describe, expect, test } from 'bun:test'

import {
  CLIENT_VERSION_OVERRIDE_ENV,
  CLIENT_VERSION_RE,
  HIGHEST_SHIPPED_VERSION,
  isVersionGreater,
  readPackageVersion,
  resolveClientVersion,
  resolveOverridableClientVersion,
} from './client-version.mjs'

const stubVersion = () => '0.3.0'

describe('客户端版本号 SSOT — 读 package.json（ADR-0038）', () => {
  test('从 manifest 读出 version', () => {
    const version = readPackageVersion('/repo', {
      readFile: () => JSON.stringify({ name: 'narracat', version: '0.3.7' }),
    })

    expect(version).toBe('0.3.7')
  })

  test('manifest 读不到 / 不是 JSON 时 fail-loud，不静默回落', () => {
    expect(() =>
      readPackageVersion('/repo', {
        readFile: () => {
          throw new Error('ENOENT')
        },
      }),
    ).toThrow('package.json')

    expect(() => readPackageVersion('/repo', { readFile: () => '{ 不是 JSON' })).toThrow(
      'package.json',
    )
  })

  test('version 不是三段 semver 时 fail-loud——打歪的版本号会一路烧进产物', () => {
    for (const bad of [undefined, '', '0.3', '0.3.0.1', 'v0.3.0', '0.3.0-beta.1', 42]) {
      expect(() =>
        readPackageVersion('/repo', { readFile: () => JSON.stringify({ version: bad }) }),
      ).toThrow('x.y.z')
    }
  })

  test('resolveClientVersion 走可注入的读取器', () => {
    expect(resolveClientVersion({ readVersion: stubVersion })).toBe('0.3.0')
  })
})

describe('resolveOverridableClientVersion — 覆盖机制（ADR-0038 保留不动）', () => {
  test('未设覆盖时与 resolveClientVersion 同值', () => {
    expect(resolveOverridableClientVersion({ env: {}, readVersion: stubVersion })).toBe(
      resolveClientVersion({ readVersion: stubVersion }),
    )
  })

  test('设了就用它——测试包要能压过线上版本，否则会被 electron-updater 静默换掉', () => {
    expect(
      resolveOverridableClientVersion({
        env: { [CLIENT_VERSION_OVERRIDE_ENV]: '0.9.9999' },
        readVersion: stubVersion,
      }),
    ).toBe('0.9.9999')
  })

  test('空白值视同未设', () => {
    expect(
      resolveOverridableClientVersion({
        env: { [CLIENT_VERSION_OVERRIDE_ENV]: '  ' },
        readVersion: stubVersion,
      }),
    ).toBe('0.3.0')
  })

  test('非法值 fail-loud，不静默打出坏版本号', () => {
    for (const bad of ['abc', '0.1', '0.1.2.3', 'v0.1.2']) {
      expect(() =>
        resolveOverridableClientVersion({
          env: { [CLIENT_VERSION_OVERRIDE_ENV]: bad },
          readVersion: stubVersion,
        }),
      ).toThrow(new RegExp(CLIENT_VERSION_OVERRIDE_ENV))
    }
  })

  test('正式发布链路不吃这个环境变量：release.mjs 只引用无覆盖的那支', async () => {
    const { readFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'release.mjs'), 'utf8')
    expect(src).not.toContain(CLIENT_VERSION_OVERRIDE_ENV)
    expect(src).not.toContain('resolveOverridableClientVersion')
  })
})

describe('版本线不变量 — 必须压过已交付到用户手上的最高版本', () => {
  // 派生方案（ADR-0006）唯一的真好处是「永不重复、永不忘记」；改成人来定之后这两件事都可能
  // 出错。这一组就是补上的那道闸——手滑把版本改小、或发完版忘了往上抬，测试立刻红。
  //
  // 为什么是 0.2.92 而不是线上最新的 0.2.65：0.2.92 是 Windows 适配分支 CI 出的包，
  // 已经装在产品主人的真机上。electron-updater 只认「feed 版本 > 已安装版本」，漏掉这台
  // 就是这台永久收不到更新（正是 ADR-0038 要治的那起事故）。取两者中的大者。
  test('package.json 的 version 严格大于已交付的最高版本', () => {
    const current = resolveClientVersion({})

    expect(CLIENT_VERSION_RE.test(current)).toBe(true)
    expect(isVersionGreater(current, HIGHEST_SHIPPED_VERSION)).toBe(true)
  })

  test('比较函数本身可信：同值不算大于，低版本必须失守（证明断言真有牙）', () => {
    expect(isVersionGreater('0.3.0', '0.2.92')).toBe(true)
    expect(isVersionGreater('0.2.92', '0.2.92')).toBe(false)
    expect(isVersionGreater('0.2.75', HIGHEST_SHIPPED_VERSION)).toBe(false)
    // 合并后主干那个 0.2.75 正是事故现场：它低于已交付的 0.2.92，发出去没人收得到。
    expect(isVersionGreater('0.2.100', '0.2.92')).toBe(true)
    expect(isVersionGreater('1.0.0', '0.9.9')).toBe(true)
  })
})

import { describe, expect, test } from 'bun:test'

import {
  CLIENT_VERSION_OVERRIDE_ENV,
  CLIENT_VERSION_RE,
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

describe('isVersionGreater — 发布闸「新版本必须高于线上 latest」的比较函数', () => {
  // 「线上 latest 是几」由 release.mjs 在发版时直接问 GitHub（见那边的 assertVersionAboveLatestRelease），
  // 仓库里不再手抄一份常量。这里只钉比较函数本身可信：同值不算大于，低版本必须失守。
  test('同值不算大于，低版本必须失守（证明闸真有牙）', () => {
    expect(isVersionGreater('0.3.0', '0.2.92')).toBe(true)
    expect(isVersionGreater('0.2.92', '0.2.92')).toBe(false)
    // 0.2.75 vs 0.2.92 正是 ADR-0038 的事故现场：合并后主干的号低于已交付真机的号，发出去没人收得到。
    expect(isVersionGreater('0.2.75', '0.2.92')).toBe(false)
    expect(isVersionGreater('0.2.100', '0.2.92')).toBe(true)
    expect(isVersionGreater('1.0.0', '0.9.9')).toBe(true)
  })
})

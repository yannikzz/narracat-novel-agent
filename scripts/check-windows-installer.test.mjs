/**
 * Windows 安装器脚本守卫（ADR-0046：App 永不删除非自有文件）。
 *
 * NSIS 在 macOS 上跑不起来，这里只守住「接线没断、原则没被顺手改回去」：
 * - package.json 的 nsis.include 指向存在的脚本；
 * - 脚本提供 customRemoveFiles（替换 electron-builder 默认的整目录 RMDir /r）与过渡救援两段；
 * - 脚本里绝不能出现对整个 $INSTDIR 的递归删除——那正是把作者小说一起删掉的那一行。
 * 真机验证（旧版装好 → 小说根目录设在安装目录 → 升级）仍是发布前置条件，本测试不替代它。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const repoRoot = join(import.meta.dir, '..')
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
const includePath = packageJson.build?.nsis?.include
const script = includePath ? readFileSync(join(repoRoot, includePath), 'utf-8') : ''

describe('Windows installer customization (ADR-0046)', () => {
  test('package.json wires the custom NSIS include and the file exists', () => {
    expect(includePath).toBe('build/installer.nsh')
    expect(existsSync(join(repoRoot, includePath))).toBe(true)
  })

  test('the uninstaller only removes app-owned files and never RMDir /r the whole install dir', () => {
    expect(script).toContain('!macro customRemoveFiles')
    // 白名单删除 + 非递归删空目录
    expect(script).toContain('RMDir /r /REBOOTOK "${ROOT}\\resources"')
    expect(script).toContain('RMDir "${ROOT}"')
    // 任何对整个安装目录的递归删除都是回归：不管写成哪种引号形式
    expect(script).not.toMatch(/RMDir\s+\/r(\s+\/REBOOTOK)?\s+"?\$INSTDIR"?\s*$/m)
    expect(script).not.toMatch(/RMDir\s+\/r(\s+\/REBOOTOK)?\s+"?\$\{ROOT\}"?\s*$/m)
  })

  test('the installer rescues foreign entries before the old uninstaller runs and restores them afterwards', () => {
    // 隐藏 Section 先于 "install" Section 执行（本文件被包含在 installer.nsi 之前）
    expect(script).toContain('Section "-narracatRescueUserFiles"')
    expect(script).toContain('Call narracatRescueForeignEntries')
    expect(script).toContain('!macro customInstall')
    expect(script).toContain('Call narracatRestoreForeignEntries')
    // 安装失败也放回
    expect(script).toContain('Function .onInstFailed')
    // 养护目录必须是同级目录（子目录会被旧卸载器一起删）
    expect(script).toContain('StrCpy $narracatKeepDir "$narracatOldInstallDir-user-files"')
    // 救援走注册表里的旧安装位置，而不是本次选的 $INSTDIR
    expect(script).toContain('ReadRegStr $narracatOldInstallDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation')
  })

  test('the rescue predicate and the delete list name the same app-owned entries', () => {
    for (const entry of ['resources', 'locales', 'swiftshader', 'vk_swiftshader_icd.json']) {
      expect(script).toContain(`StrCmp $R1 "${entry}" owned`)
      expect(script).toContain(`"\${ROOT}\\${entry}"`)
    }
    for (const ext of ['.exe', '.dll', '.pak', '.bin', '.dat']) {
      expect(script).toContain(`StrCmp $R3 "${ext}" owned`)
      expect(script).toContain(`"\${ROOT}\\*${ext}"`)
    }
    expect(script).toContain('StrCmp $R3 "LICENSE" owned')
    expect(script).toContain('"${ROOT}\\LICENSE*"')
  })
})

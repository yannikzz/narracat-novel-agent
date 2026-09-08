/**
 * Windows 安装器脚本守卫（ADR-0046：App 永不删除非自有文件）。
 *
 * NSIS 在 macOS 上跑不起来，这里守的是能静态判定的三件事：
 * 1. 接线没断：package.json 的 nsis.include 指向存在的脚本，脚本提供 customRemoveFiles 与救援两段。
 * 2. 原则没被改回去：脚本里绝不能出现对整个安装目录的递归删除——那正是把作者小说一起删掉的那一行。
 * 3. 编译期陷阱：本脚本被拼在 installer.nsi 之前，文件作用域（Section / Function）里出现的 `${X}` 只能是
 *    electron-builder 用 -D 传入的 define 或本文件自己 !define 的名字；引用 common.nsh / multiUser.nsh
 *    里才定义的名字，makensis -WX 下直接报错，若不报错则救援静默不执行（更危险）。
 * 另外从脚本里**解析**出删除白名单与救援谓词两份清单，断言集合相等——救援侧漏列会把 App 文件当作者
 * 文件搬走且放不回去，两边必须逐条对应。
 * 真机验证（旧版装好 → 小说根目录设在安装目录 → 升级）仍是发版前置条件，本测试不替代它。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const repoRoot = join(import.meta.dir, '..')
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
const includePath = packageJson.build?.nsis?.include
const script = includePath ? readFileSync(join(repoRoot, includePath), 'utf-8') : ''

/** electron-builder NsisTarget.js 以 -D 传给 makensis 的 define（文件作用域可安全引用）。 */
const BUILDER_DEFINES = new Set([
  'APP_ID',
  'APP_GUID',
  'UNINSTALL_APP_KEY',
  'PRODUCT_NAME',
  'PRODUCT_FILENAME',
  'APP_FILENAME',
  'APP_DESCRIPTION',
  'VERSION',
  'PROJECT_DIR',
  'BUILD_RESOURCES_DIR',
  'APP_PACKAGE_NAME',
  'BUILD_UNINSTALLER',
])

/** 去掉 `!macro … !macroend` 段后剩下的文件作用域文本（宏体在插入点才展开，不受编译顺序影响）。 */
function fileScopeText(source) {
  return source.replace(/^!macro\b[\s\S]*?^!macroend\s*$/gm, '')
}

function macroBody(source, name) {
  const match = source.match(new RegExp(`^!macro ${name}\\b[^\\n]*\\n([\\s\\S]*?)^!macroend`, 'm'))
  return match?.[1] ?? ''
}

function functionBody(source, name) {
  const match = source.match(new RegExp(`^Function ${name}\\s*\\n([\\s\\S]*?)^FunctionEnd`, 'm'))
  return match?.[1] ?? ''
}

/** 删除白名单：从 narracatDeleteAppOwnedEntries 宏体里解析出「相对 ROOT 的条目模式」。 */
function parseDeleteAllowlist(source) {
  const body = macroBody(source, 'narracatDeleteAppOwnedEntries')
  return new Set(
    [...body.matchAll(/^\s*(?:RMDir \/r \/REBOOTOK|Delete \/REBOOTOK) "\$\{ROOT\}\\([^"]+)"/gm)].map((m) => m[1]),
  )
}

/** 救援谓词：从 narracatIsAppOwnedEntry 函数体里解析出等价的条目模式。 */
function parseRescueAllowlist(source) {
  const body = functionBody(source, 'narracatIsAppOwnedEntry')
  const patterns = new Set()
  for (const [, name] of body.matchAll(/StrCmp \$R1 "([^"]+)" owned/g)) patterns.add(name)
  // 前缀比较：StrCpy $R3 $R1 N + StrCmp $R3 "PREFIX" owned → PREFIX*
  for (const [, prefix] of body.matchAll(/StrCpy \$R3 \$R1 \d+\s*\n\s*StrCmp \$R3 "([^"]+)" owned/g)) patterns.add(`${prefix}*`)
  // 后缀比较：StrCpy $R3 $R1 "" -N 之后连续的 StrCmp $R3 ".ext" owned → *.ext
  const suffixSection = body.split(/StrCpy \$R3 \$R1 "" -\d+/)[1] ?? ''
  for (const [, ext] of suffixSection.matchAll(/StrCmp \$R3 "(\.[a-z0-9]+)" owned/g)) patterns.add(`*${ext}`)
  return patterns
}

describe('Windows installer customization (ADR-0046)', () => {
  test('package.json wires the custom NSIS include and the file exists', () => {
    expect(includePath).toBe('build/installer.nsh')
    expect(existsSync(join(repoRoot, includePath))).toBe(true)
  })

  test('the uninstaller only removes app-owned files and never RMDir /r the whole install dir', () => {
    expect(script).toContain('!macro customRemoveFiles')
    expect(macroBody(script, 'customRemoveFiles')).toContain('!insertmacro narracatDeleteAppOwnedEntries "$INSTDIR"')
    // 白名单删除 + 非递归删空目录
    expect(macroBody(script, 'narracatDeleteAppOwnedEntries')).toMatch(/^\s*RMDir "\$\{ROOT\}"\s*$/m)
    // 任何对整个安装目录的递归删除都是回归：去掉行尾注释后逐行检查
    for (const rawLine of script.split('\n')) {
      const line = rawLine.replace(/;.*$/, '').trim()
      expect(line).not.toMatch(/^RMDir\s+\/r\b.*"?\$(INSTDIR|\{ROOT\}|narracatOldInstallDir|narracatKeepDir)"?\s*$/)
    }
  })

  test('the installer rescues foreign entries before the old uninstaller runs and restores them on every exit path', () => {
    // 隐藏 Section 先于 "install" Section 执行（本文件被包含在 installer.nsi 之前）
    expect(script).toContain('Section "-narracatRescueUserFiles"')
    expect(script).toContain('Call narracatRescueForeignEntries')
    expect(macroBody(script, 'customInstall')).toContain('Call narracatRestoreForeignEntries')
    // 安装失败、旧卸载器失败（electron-builder 默认 Quit 而非 Abort）两条退出路径都放回
    expect(functionBody(script, '.onInstFailed')).toContain('Call narracatRestoreForeignEntries')
    expect(macroBody(script, 'narracatUninstallResultCheck')).toContain('Call narracatRestoreForeignEntries')
    expect(script).toContain('!macro customUnInstallCheck')
    expect(script).toContain('!macro customUnInstallCheckCurrentUser')
    // 救援 fail loud：搬不动就 Abort，不能静默跳过让旧卸载器把它删掉
    expect(functionBody(script, 'narracatRescueForeignEntries')).toMatch(/^\s*Abort\b/m)
    // 养护目录必须是同级目录（子目录会被旧卸载器一起删）
    expect(script).toContain('StrCpy $narracatKeepDir "$narracatOldInstallDir-user-files"')
    // 救援走注册表里的旧安装位置，而不是本次选的 $INSTDIR
    expect(script).toContain('ReadRegStr $narracatOldInstallDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation')
  })

  test('file-scope code only references defines that exist at this compile point', () => {
    const localDefines = new Set([...script.matchAll(/^!define(?: \/ifndef)? ([A-Z_]+)\b/gm)].map((m) => m[1]))
    const referenced = new Set([...fileScopeText(script).matchAll(/\$\{([A-Za-z_]+)\}/g)].map((m) => m[1]))
    const unknown = [...referenced].filter((name) => !BUILDER_DEFINES.has(name) && !localDefines.has(name))
    // 例如 APP_EXECUTABLE_FILENAME / INSTALL_REGISTRY_KEY 在 common.nsh / multiUser.nsh 才定义，
    // 此处引用会让 Windows 出包失败或救援静默不执行。
    expect(unknown).toEqual([])
    expect(localDefines.has('INSTALL_REGISTRY_KEY')).toBe(true)
    expect(localDefines.has('NARRACAT_APP_EXE')).toBe(true)
  })

  test('the rescue predicate and the delete list name exactly the same app-owned entries', () => {
    const deleteList = parseDeleteAllowlist(script)
    const rescueList = parseRescueAllowlist(script)
    expect(deleteList.size).toBeGreaterThan(5)
    expect([...deleteList].sort()).toEqual([...rescueList].sort())
    for (const required of ['resources', 'locales', '*.exe', '*.dll', 'LICENSE*', 'vk_swiftshader_icd.json']) {
      expect(deleteList.has(required)).toBe(true)
    }
  })
})

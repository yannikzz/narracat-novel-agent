; NarraCat Windows 安装器 / 卸载器定制（ADR-0046：App 永不删除非自有文件）。
;
; electron-builder 默认的卸载器在更新与卸载时对整个安装目录执行 `RMDir /r $INSTDIR`
; （app-builder-lib/templates/nsis/uninstaller.nsh），作者放进安装目录的小说会被一起删掉、
; 且不进回收站。本文件做两件事：
;
;   1. customRemoveFiles —— 卸载/更新只按固定白名单删 Electron 应用自己的文件，最后非递归
;      删空目录。白名单漏列只会残留文件，不会误删数据（失败方向安全）。
;   2. 过渡救援 —— 新安装器会先调用「旧版本」的卸载器清场，修好的卸载器保护不了 0.4.0 → 新版
;      这一跳。故在旧卸载器执行之前（本文件里的隐藏 Section 先于 "install" Section 运行），把
;      旧安装目录下所有非白名单条目 Rename 到同盘的 `<安装目录>-user-files`，装完在 customInstall
;      里 Rename 回来。同盘 Rename 是原子操作、不复制数据。任何一项搬不动就中止安装并告知作者
;      （fail loud）：宁可升级失败，也不能让升级悄悄吃掉一本书。
;
; 编译顺序（改动前必读）：本文件被 electron-builder 拼在 installer.nsi **之前**（NsisTarget.js
; computeCommonInstallerScriptHeader），因此 common.nsh / multiUser.nsh 里定义的
; APP_EXECUTABLE_FILENAME、INSTALL_REGISTRY_KEY 等在 Section / Function 里**尚不可用**（`${}` 在
; 文件作用域当场展开，makensis -WX 下未定义即报错；宏体里的引用则在 !insertmacro 时才展开，不受
; 影响）。文件作用域只能用 -D 传入的 define（APP_GUID / PRODUCT_FILENAME / APP_FILENAME / VERSION…）
; 或本文件自己定义的名字。scripts/check-windows-installer.test.mjs 机械守这条。
;
; 白名单（两处共用同一份判定，改一处必须同步另一处，守卫测试会比对）：
;   目录  resources / locales / swiftshader
;   文件  *.exe / *.dll / *.pak / *.bin / *.dat / vk_swiftshader_icd.json / LICENSE*
;
; 本脚本无法在 macOS 上执行验证：改动后必须由 Windows CI 产物 + 真机跑一遍
; 「旧版装好 → 小说根目录设在安装目录 → 升级」的完整流程。

; ---------------------------------------------------------------------------
; 卸载器：只删 App 自有文件（安装器与卸载器两个上下文都能插入的纯指令宏）
; ---------------------------------------------------------------------------
!macro narracatDeleteAppOwnedEntries ROOT
  RMDir /r /REBOOTOK "${ROOT}\resources"
  RMDir /r /REBOOTOK "${ROOT}\locales"
  RMDir /r /REBOOTOK "${ROOT}\swiftshader"
  Delete /REBOOTOK "${ROOT}\*.exe"
  Delete /REBOOTOK "${ROOT}\*.dll"
  Delete /REBOOTOK "${ROOT}\*.pak"
  Delete /REBOOTOK "${ROOT}\*.bin"
  Delete /REBOOTOK "${ROOT}\*.dat"
  Delete /REBOOTOK "${ROOT}\vk_swiftshader_icd.json"
  Delete /REBOOTOK "${ROOT}\LICENSE*"
  ; 非递归：目录里还有作者的东西就原样留下
  RMDir "${ROOT}"
!macroend

!macro customRemoveFiles
  ; 先离开 $INSTDIR，否则当前目录占用会让 RMDir 失败
  SetOutPath $TEMP
  !insertmacro narracatDeleteAppOwnedEntries "$INSTDIR"
!macroend

; ---------------------------------------------------------------------------
; 安装器：过渡救援（旧卸载器之前救出、装完放回）
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER

; 与 multiUser.nsh 逐字一致（那边是 /ifndef，先定义不冲突）；APP_EXECUTABLE_FILENAME 在 common.nsh
; 是无 /ifndef 的 !define，不能抢先同名定义，故自起一个名字。
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define NARRACAT_APP_EXE "${PRODUCT_FILENAME}.exe"

Var narracatOldInstallDir
Var narracatKeepDir
Var narracatRescued

; 判定 $R1（条目名）是否 App 自有；结果写 $R2（"1" 自有 / "0" 非自有）。
; 与 narracatDeleteAppOwnedEntries 的白名单逐条对应（NSIS StrCmp 不区分大小写，与文件系统一致）。
Function narracatIsAppOwnedEntry
  StrCpy $R2 "0"
  StrCmp $R1 "resources" owned
  StrCmp $R1 "locales" owned
  StrCmp $R1 "swiftshader" owned
  StrCmp $R1 "vk_swiftshader_icd.json" owned
  StrCpy $R3 $R1 7
  StrCmp $R3 "LICENSE" owned
  StrCpy $R3 $R1 "" -4
  StrCmp $R3 ".exe" owned
  StrCmp $R3 ".dll" owned
  StrCmp $R3 ".pak" owned
  StrCmp $R3 ".bin" owned
  StrCmp $R3 ".dat" owned
  Return
  owned:
    StrCpy $R2 "1"
FunctionEnd

; 把 $narracatOldInstallDir 下的非自有条目搬到 $narracatKeepDir。
; 每成功搬走一项就重新枚举（枚举中改目录会漏项）。任何一项搬不动（被占用 / 云同步锁定 / 同名冲突）
; 立即 Abort：留在原地的条目几秒后就会被旧卸载器删掉，静默跳过等于静默丢数据。Abort 会触发
; .onInstFailed 把已搬走的放回。
Function narracatRescueForeignEntries
  ClearErrors
  restart:
    FindFirst $R0 $R1 "$narracatOldInstallDir\*.*"
  scan:
    StrCmp $R1 "" finished
    StrCmp $R1 "." next
    StrCmp $R1 ".." next
    Call narracatIsAppOwnedEntry
    StrCmp $R2 "1" next
    ClearErrors
    CreateDirectory "$narracatKeepDir"
    Rename "$narracatOldInstallDir\$R1" "$narracatKeepDir\$R1"
    IfErrors rescueFailed
    StrCpy $narracatRescued "1"
    FindClose $R0
    Goto restart
  next:
    FindNext $R0 $R1
    Goto scan
  rescueFailed:
    FindClose $R0
    MessageBox MB_OK|MB_ICONEXCLAMATION "NarraCat 安装目录里有它自己以外的文件（$R1），升级前需要先把它们挪到安全位置，但现在挪不动。$\r$\n$\r$\n请先关闭 NarraCat 以及正在使用该文件夹的程序（编辑器、云同步、资源管理器窗口），然后重新运行安装。这次安装已中止，你的文件原样未动。" /SD IDOK
    Abort "NarraCat 无法保护安装目录里的用户文件：$R1"
  finished:
    FindClose $R0
FunctionEnd

; 把 $narracatKeepDir 里的条目搬回 $narracatOldInstallDir；养护目录空了就删掉它。
Function narracatRestoreForeignEntries
  StrCmp $narracatRescued "1" 0 done
  StrCpy $narracatRescued "0"
  CreateDirectory "$narracatOldInstallDir"
  restart:
    FindFirst $R0 $R1 "$narracatKeepDir\*.*"
  scan:
    StrCmp $R1 "" finished
    StrCmp $R1 "." next
    StrCmp $R1 ".." next
    ClearErrors
    Rename "$narracatKeepDir\$R1" "$narracatOldInstallDir\$R1"
    IfErrors next
    FindClose $R0
    Goto restart
  next:
    FindNext $R0 $R1
    Goto scan
  finished:
    FindClose $R0
    RMDir "$narracatKeepDir"
  done:
FunctionEnd

; 隐藏 Section：本文件被包含在 installer.nsi 之前，故本 Section 先于 "install" Section
; （即先于其中的 uninstallOldVersion）执行；又晚于目录选择页，作者取消安装时不会有东西被搬走。
Section "-narracatRescueUserFiles"
  StrCpy $narracatRescued "0"
  StrCpy $narracatOldInstallDir ""
  ; 旧卸载器清的是注册表里的旧安装位置，不是本次选的 $INSTDIR
  ReadRegStr $narracatOldInstallDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $narracatOldInstallDir "" skip
  ; 去掉尾部反斜杠，养护目录必须是同级目录而不是子目录（子目录会被旧卸载器一起删）
  StrCpy $R3 $narracatOldInstallDir "" -1
  StrCmp $R3 "\" 0 +2
    StrCpy $narracatOldInstallDir $narracatOldInstallDir -1
  ; 盘符根目录（如 "D:"）不做救援：那是把整块盘搬家
  StrLen $R3 $narracatOldInstallDir
  IntCmp $R3 2 skip skip
  ; UNC 路径（\\server\share）加 "-user-files" 不是合法同级目录，不做救援
  StrCpy $R3 $narracatOldInstallDir 2
  StrCmp $R3 "\\" skip
  IfFileExists "$narracatOldInstallDir\${NARRACAT_APP_EXE}" 0 skip
  StrCpy $narracatKeepDir "$narracatOldInstallDir-user-files"
  Call narracatRescueForeignEntries
  skip:
SectionEnd

!macro customInstall
  Call narracatRestoreForeignEntries
!macroend

; 旧卸载器执行失败时 electron-builder 默认直接 Quit（不是 Abort，.onInstFailed 不会触发）：
; 接管这个检查点，先把救出的文件放回原位再退出，不让作者的小说卡在养护目录里。
!macro narracatUninstallResultCheck
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return
  ${if} $R0 != 0
    Call narracatRestoreForeignEntries
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro narracatUninstallResultCheck
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro narracatUninstallResultCheck
!macroend

; 安装中途失败也把东西放回去，不让作者的文件卡在养护目录里
Function .onInstFailed
  Call narracatRestoreForeignEntries
FunctionEnd

!endif

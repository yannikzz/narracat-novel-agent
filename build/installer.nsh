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
;      里 Rename 回来。同盘 Rename 是原子操作、不复制数据。放回失败时留在原地，App 侧的
;      「找不到了」状态会提示作者去哪找。
;
; 白名单（两处共用同一份判定，改一处必须同步另一处）：
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

Var narracatOldInstallDir
Var narracatKeepDir
Var narracatRescued

; 判定 $R1（条目名）是否 App 自有；结果写 $R2（"1" 自有 / "0" 非自有）。
; 与 narracatDeleteAppOwnedEntries 的白名单逐条对应。
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
; 每成功搬走一项就重新枚举（枚举中改目录会漏项）；搬失败的项跳过继续，故必然终止。
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
    IfErrors next
    StrCpy $narracatRescued "1"
    FindClose $R0
    Goto restart
  next:
    FindNext $R0 $R1
    Goto scan
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
  IfFileExists "$narracatOldInstallDir\${APP_EXECUTABLE_FILENAME}" 0 skip
  StrCpy $narracatKeepDir "$narracatOldInstallDir-user-files"
  Call narracatRescueForeignEntries
  skip:
SectionEnd

!macro customInstall
  Call narracatRestoreForeignEntries
!macroend

; 安装中途失败也把东西放回去，不让作者的文件卡在养护目录里
Function .onInstFailed
  Call narracatRestoreForeignEntries
FunctionEnd

!endif

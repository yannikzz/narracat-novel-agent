# ADR 0046: App 永不删除非自有文件——更新/卸载只清 App 自有文件，交付物必须有上界

## Status

Accepted（2026-09-08；编号从 0046 起，0042–0045 已被并行的底座重构分支占用）

## Context

一位 Windows 用户在 0.4.0 首次启动 8 分钟后，小说项目 `D:\NarraCat\novel-…` 的
`.narracat/config.yaml` 与 `state.yaml` 双双缺失。取证链：

- App 装在 `D:\NarraCat`（electron-builder 辅助安装器在用户选的路径不含产品名时会自动追加
  `\NarraCat`，选 `D:\` 就落成这个目录），作者随后把小说根目录也设在这里——不是乱放，是两个系统
  偏爱同一个名字。
- electron-builder 的 NSIS 更新流程：新安装器先以 `--updated` 调**旧版**卸载器
  （`installUtil.nsh:206`），旧卸载器在 `isUpdated` 分支执行 `RMDir /r $INSTDIR`
  （`uninstaller.nsh:164-187`）——整个安装目录连同作者放进去的一切一起删，不进回收站。
- 我们 `autoDownload` + `autoInstallOnAppQuit` 全开：v0.4.0 于 09-07 08:50Z 发布，作者退出即静默
  升级，没有任何提醒窗口。

同一份日志还暴露两条同源的结构性问题：

- `/plan` 的 outline-architect 在 1.5 小时内 6 次 `stopReason=length`。卷级提交是「整组替换」语义，
  大部头必须一次交完所有卷，单轮输出没有上界；截断后主会话拿到 ⚠️ 只会同参重派。
- 书架把路径当成残缺项目的 id，Agent 线程身份跟着变成路径，`threadKey` 拒绝含分隔符的 id 报
  「参数非法」；且目录整个不在了仍被描述成「文件不完整」，还因为父目录等于根目录而不可移除。

## Decision

### 1. 原则：App 永不删除不是自己创建的文件

小说根目录由作者完全支配，可以在磁盘上任何位置，**包括与安装目录重叠**。App 不阻止、不迁移；
它只保证自己的更新与卸载不碰任何非 App 自有文件（术语见 `CONTEXT.md`「App-owned file」）。

**否决的替代方案**：设置页拒绝把根目录设进安装目录 + 更新前拦截。它只防住我们想到的这一种重叠，
已经重叠的用户要先迁移，而且把「别把东西放我这」的责任推给作者——更新程序销毁用户数据是产品的
错，不是作者的。

### 2. 机制：卸载器按固定白名单只删 App 自有文件

`build/installer.nsh` 经 `nsis.include` 接入，用 `customRemoveFiles` 替换 electron-builder 默认的
`RMDir /r $INSTDIR`：逐项删除 Electron 应用的标准布局（`resources/`、`locales/`、`*.dll`、`*.exe`、
`*.pak`、`*.bin`、`*.dat`、`LICENSE*` 等），最后**非递归**删空目录。失败方向安全：白名单漏列只会残留
几个文件，不会误删数据。

**否决的替代方案**：构建期生成安装清单、卸载器读清单逐条删。更精确，但 NSIS 读文件循环繁琐、多一层
构建链要维护，而 Electron 布局多年稳定，收益不抵成本。

### 3. 过渡：新安装器在旧卸载器之前救出、装完放回

修好的卸载器只随新版本落地，**0.4.0 → 下一版这一跳仍由 0.4.0 的旧卸载器清场**。安装器的
`customInit` 在 `uninstallOldVersion` 之前执行且已知旧安装目录，故：`customInit` 把旧安装目录下所有
非白名单条目 Rename 到同盘的养护目录，`customInstall` 再 Rename 回来。同盘 Rename 是原子操作、
不复制数据；放回失败则留在养护目录，由 App 的「找不到了」状态提示作者去哪找。救援与卸载器共用
同一份白名单。

### 4. 书架：Missing 与 Invalid 是两种状态，都没有身份

目录不存在 = **Missing Novel project**，卡片如实说文件夹不在了，并允许移除（「重扫会加回来」的
限制理由在目录不存在时不成立）。目录在但缺契约文件 = **Invalid Novel project**。二者都不再用路径
充当 id；Agent 线程身份只由小说 id 派生；没有身份的项目不进 Workbench、不发任何内容/状态/Agent
请求。数据丢失必须可见，不能静默消失。

### 5. 引擎：交付物必须有上界；截断即停，选择权交给作者

- `novel_submit_outline` 新增 `scope="volume"`：按卷号 upsert，不删任何卷；架构师一卷一交，单轮产出
  与书的体量解耦，与模型、协议、输出上限无关。原有 `full` / `volumes` 的整组替换语义保留给整体重排。
- 子 agent 被 `length` 截断时（anthropic 协议上原有的就地关思考重跑仍先做一次），**立即结束 run**，
  任务卡与 run 终态给出三选一（抬输出上限 / 换模型 / 拆小任务），不再让主会话自行决定重派——本次
  日志证明它只会同参重派，多给一次机会只是多烧 10 分钟。

## Consequences

- Windows 安装目录里可能残留少量旧版文件（白名单漏列时），可接受。
- NSIS 脚本在 macOS 上无法执行验证，只能靠 Windows CI 产物 + 真机跑一遍「0.4.0 装好 → 根目录设在
  安装目录 → 升级」的完整流程；这一步是发布前置条件。
- 卷级提交契约变化需要 mcp-server 重新 build 并 bump 引擎版本；`plan.md` 与 outline-architect 的
  提交指令同步改为逐卷。

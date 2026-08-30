---
name: release-app
description: Cut and publish a new NarraCat-app version — bump the version number, build the Windows x64 package in CI, package + sign + notarize the macOS build locally, and publish both platforms into one GitHub Release. Use this whenever the user wants to ship a new version, asks what version is live, or wants to know whether a release is ready to go — 发新版 / 发版 / 发布新包 / 打包发出去 / 上线新版本 / 给用户推更新 / 出个正式版 / 现在线上是哪一版. Also use it for anything that goes wrong before, during, or after a release: notarization or signing looks stuck or failed, the release build fails to produce a shippable package, users report they are not receiving updates, the update feed looks broken, or a bad version needs rolling back — 公证卡住 / 签名失败 / 出包失败 / 用户收不到更新 / 更新链断了 / 退回上一版. This covers the release pipeline itself, not everyday CI, build or test failures. Releasing is irreversible and must always cover both platforms, so route any release-shaped request through this skill rather than improvising the commands.
---

# 发版：mac + Windows 双平台

发一个新版本 = 抬版本号 → CI 出 Windows 包 → 本机打 mac 包并签名公证 → 两个平台的产物进**同一个** GitHub Release。

**这件事不可逆**：Release 一旦发布，所有装了 App 的用户都会自动收到。所以下面每一步的顺序和闸都不是形式主义，撞到闸就停下来问人，不要绕过去。

## 唯一一条不能违反的规则：必须双平台

更新代理（`workers/narracat-update`）把**两个平台的更新清单都**翻译成 `releases/latest/download/<清单名>`：

```
/mac-arm64/latest-mac.yml  →  releases/latest/download/latest-mac.yml
/win-x64/latest.yml        →  releases/latest/download/latest.yml
```

所以一个**只含单平台产物**的 Release 一旦成为 `latest`，另一个平台的清单查询直接 404 —— 那条更新链就此断掉，直到下一次带上该平台产物的发布为止。不是"用户停在上一版"，是**从此收不到任何更新，两端都没有报错**。

`release.mjs` 已经加了闸（必须显式给 `--with-win` 或 `--mac-only`），但闸拦得住命令、拦不住判断：`--mac-only` 只在 Windows 从未发布过、或 Windows CI 出不了包而 mac 有紧急修复要发时才用。**Windows 正式发布之后，用它就等于主动掐断 Windows 用户的更新链。**

## 两个平台为什么不能在同一个地方打

| 平台 | 在哪打 | 为什么只能在那儿 |
|---|---|---|
| macOS arm64 | 本机 | 签名要读本机钥匙串里的 Developer ID 证书，之后还要跑 Apple 公证 |
| Windows x64 | GitHub CI | mac 交叉编译不出能用的 Windows 包（keytar / better-sqlite3 是 mac 原生二进制）；且 SignPath 的免费签名硬要求"可验证地从源码构建" |

版本号一致不靠人盯：两边都读同一个 `package.json`（ADR-0038）。

---

## 步骤 0：预检

先跑这个，它把该确认的一切一次报全（只读，不改任何东西）：

```bash
node .claude/skills/release-app/scripts/preflight.mjs
```

Windows 产物在本机时（`--with-win` 那条老路）再跑一次带目录核对：

```bash
node .claude/skills/release-app/scripts/preflight.mjs --win-dir <目录>
```

走 `--win-from-release`（常规路径）时不需要这一步 —— 产物在 GitHub 上，由发布脚本远程核验。

它检查：在不在 main、工作区干不干净、与远端同步没、版本号是否合法且高于已交付的最高版、这个 tag 是不是已经发过、三样凭证齐不齐、签名身份在不在、Windows 三件产物齐不齐且版本号对不对得上。

有 `✗` 就先解决再往下走 —— 这些问题在后面每一步都会重新撞上，只是那时候人已经等了半小时。把结果用大白话转述给用户，不要只甩脚本输出。

## 步骤 1：定版本号

版本号由人决定，不会自己往上走（ADR-0038）。改 `package.json` 的 `version` 一处即可，其余全部从它派生。

| 这次发的是 | 怎么走 |
|---|---|
| 修 bug、小改进 | patch：`0.3.0` → `0.3.1` |
| 有用户能感知的新能力 | minor：`0.3.0` → `0.4.0` |
| 正式公开发布 | `1.0.0`（留给那一刻，不要提前用掉） |

**改完要走 PR 合进 main**，不要直接推 main（有分支保护，直推不会被拒、只会留一条绕过记录）。

发版前值得先问用户一句：**这一版对用户来说是什么？** 这既决定 patch 还是 minor，也是 Release notes 的内容。可以用 `git log --oneline v<上一版>..main` 看这一版实际包含什么，用大白话总结给用户确认 —— 用户关心的是"能感觉到什么变化"，不是提交列表。

## 步骤 2：CI 出 Windows 包（会自动传进 draft）

```bash
gh workflow run windows-release-build.yml --ref main
gh run watch <run-id> --exit-status    # 约 5 分钟
```

CI 出完包会**直接把三件产物传进 `v<版本>` 的 draft Release**，本机不需要下载任何东西。

draft 不被匿名 API 与 `releases/latest` 看见，所以**传上去 ≠ 发出去** —— 人工确认闸仍在步骤 3。

> 为什么不是「下载 artifact 再上传」：产物 244MB，而国内实测下载约 23KB/s（要 3 小时），
> 那条路等于把发版卡死。CI 在 GitHub 内网里传是秒级的。artifact 仍然保留，供调试与留档。

CI 拒绝往**已发布**的 Release 里传东西（那会把线上文件悄悄换掉而版本号不变）。撞上这个报错说明版本号忘了抬。

⚠️ **CI 全绿不构成任何功能保证** —— 这条流水线从不启动界面，而已知的 Windows 崩溃全在渲染层。CI 只证明"包能打出来"。

## 步骤 3：打 mac 包并发布双平台

```bash
bun --no-cache run release --win-from-release
```

`--win-from-release` = Windows 三件已由 CI 就位在 draft 里。发布前会远程核验它们真的在、且不是 0 字节的空壳（上传中断会留下名字齐全的空文件）；缺任何一件都会中止并告诉你重跑哪条命令。

产物已经在本机时（少见）用 `--with-win <目录>` 那条老路，行为不变。

这一条命令会：打 mac 包 → 签名 → 公证 → 建 draft Release → 传两个平台的全部产物 → 最后才 publish。**20-40 分钟**，其中大部分是公证在等 Apple。

顺序纪律：先建 draft、传完全部资产、最后才 publish。draft 不被匿名 API 与 `releases/latest` 看见，所以在资产全部传完之前没有任何用户能看到这个版本 —— 任一步失败，Release 停在 draft，线上仍是上一版，零影响。

中途会有一个确认界面列出待传的全部文件。**这是最后一道人工闸**，让用户过目再确认。

## 步骤 4：发完之后（不要跳过）

**把 `scripts/client-version.mjs` 里的 `HIGHEST_SHIPPED_VERSION` 抬到刚发出去的版本。**

它是"版本号别改小、别忘了抬"那道测试闸的唯一依据。不抬的话闸就形同虚设 —— 下一次发版时它比的还是老版本，改小了也不会红。同样走 PR 合进 main。

然后验证线上真的通了：

```bash
curl -sS -o /dev/null -w "mac %{http_code}\n" https://update.narracat.com/mac-arm64/latest-mac.yml
curl -sS -o /dev/null -w "win %{http_code}\n" https://update.narracat.com/win-x64/latest.yml
```

两个都应该是 200。**任何一个是 404，就说明那个平台的更新链断了** —— 多半是这次的 Release 少传了那个平台的产物。

---

## 会撞上的几件事

**公证轮询超时 ≠ 公证失败。** 脚本等不到不代表 Apple 没批。先查：

```bash
xcrun notarytool info <submission-id> --key ... --key-id ... --issuer ...
```

状态是 `Accepted` 的话，公证早就过了，只差把票据钉上去：`xcrun stapler staple <path>`。这能省掉重新公证的二十多分钟 —— 别急着重跑整条流水线。

**dmg 的 sha512 与清单里的值对不上是正常的**，不是要修的 bug。electron-builder 的清单记的是 zip 的哈希，dmg 是另外打的。

**三样凭证缺一不可**（签名证书 / 公证凭证 / 语料 token），发版档在第一步就断言。其中语料 token 最阴 —— 缺了 App 照常能开、照常能写，只是永远不注入真人范例，**静默降质**，没人会发现。

**bun 不把 `.env` 传给 node 子进程**（`package:release` 正是 bun run → node），所以脚本自己加载 `.env.local` / `.env`。凭证明明配好了却报缺失，先往这个方向查。

**发版是给所有用户推送**，所以 mac 包发出去之前值得本机装一下走一遍（能打开、能新建项目、能写一章）。CI 和单测都证明不了这件事。

**Windows 首个 beta 是未签名的**，用户必然撞 SmartScreen 蓝屏警告（点"更多信息"→"仍要运行"）。这是 SignPath Foundation 免费签名的硬条款要求的必经步骤 —— 必须先以未签名形态发布过才能申请 —— 不是疏忽，发之前跟用户说清楚。

## 出事了要回退

不需要传任何文件，也不需要发新版本：打开 Release 页 → 编辑上一个正常版本 → 勾选 "Set as the latest release" → 保存。

更新代理认的就是 GitHub 的 `latest` 标记，所以这个动作立刻让所有客户端回到上一版。

## 完成判据

说"发好了"之前，这几条都要成立：

- Release 页上这个 tag 存在、不是 draft、被标记为 latest
- 两个平台的产物都在资产列表里（mac 五件 + Windows 三件）
- 上面两条 `curl` 都返回 200
- `HIGHEST_SHIPPED_VERSION` 已抬到这一版并合进 main

前三条任何一条不成立，都要如实告诉用户哪里没成，而不是报告"发布成功"。

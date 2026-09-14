# narracat-update Worker（开源路线图 ④）

更新源加速代理。把 `update.narracat.com/<平台>/<文件名>` 转发到 GitHub Releases
（`yannikzz/narracat-novel-agent`，已 public），让国内用户下载更稳。
**无密钥**——发布仓资产匿名可下载，本 Worker 不需要任何 secret。

## 对外分发用哪个链接

发给人（公众号、群公告、落地页这类发出去就改不动的地方）用**永久链接**：

```
https://update.narracat.com/mac-arm64/latest.dmg
```

**发新版后这条链接不用改**，自动跟随 GitHub 上标为 latest 的那个 release；
回退时它也跟着回到旧版。用户存到本地的文件名仍带版本号
（`NarraCat-0.1.1925-mac-arm64.dmg`，靠 `content-disposition` 补的），
方便内测反馈时说清装的是哪一版。

代价是每次请求多一趟上游往返（先读清单定版本），且这条地址**不可缓存**——
缓存了回退开关就失效。要绝对最快的下载，才用带版本号的地址（长缓存）。

别名是白名单精确匹配（`DOWNLOAD_ALIASES`）。`latest.zip` 这类没登记的一律 404：
`.zip` 是给 electron-updater 自动更新用的，不该发给人。Windows 战役落位时在
那张表里加一行，顺带确认那时的产物扩展名。

## 多区间 Range：Windows 差量更新靠它（`src/multi-range.ts`）

electron-updater 的差量更新会发**一个多区间 Range 请求**（`bytes=0-99, 200-299, …`）
把变化的字节块一次取回。GitHub Releases 的资产实际存在 Azure Blob 上，而 **Azure 只支持
单区间，多区间一律回 501**——差量因此每次都失败、回落全量下载。本 Worker 把这块上游缺失的
能力补上：拆成单区间取回，再拼成标准 `multipart/byteranges` 还给客户端。

**客户端零改动**：差量逻辑 electron-updater 本来就有，存量用户不必升级即可受益。

实测（0.4.0 → 0.4.1，用两版真实 blockmap 算，并对 238 段逐字节比对全部一致）：

| | 下载量 | 按 23 KB/s |
|---|---|---|
| 之前（全量） | 244.6 MB | 约 3 小时 |
| 现在（差量） | 11.8 MB | 约 8 分钟 |

两个数字是**实测**出来的，不是查文档：Cloudflare 免费版每次调用 **50 个子请求**，
且**重定向单独算一个**（`github.com` 会 302 跳 Azure，所以 `redirect: 'follow'` 的请求吃
2 个额度）。拿到跳转后的签名地址复用才能把额度用满。碎片多于预算时按「在最大的几个间隙处
切开」合并，细节见 `src/multi-range.ts` 顶部。

拼不出来时（预算不够、碎片太散、上游不配合）一律**不接管**，原样把请求转给上游，客户端拿到
501 后回落全量——与本功能上线前的行为一致。宁可不接管，也不能交出拼错的字节：这些字节会被
直接写进安装包。

## 首次部署

```bash
cd workers/narracat-update
bunx --bun wrangler deploy   # 会自动创建 update.narracat.com 的自定义域与 DNS 记录
```

部署后验证：

```bash
curl -sI https://update.narracat.com/mac-arm64/latest-mac.yml
# 应为 200
```

## 回退怎么做

出了坏版本，**不需要传任何文件、不需要命令行**：

1. 打开 GitHub 网页 → 发布仓（`yannikzz/narracat-novel-agent`）→ Releases
2. 编辑上一个正常的 release → 勾选 "Set as the latest release" → 保存
3. 随后 `curl https://update.narracat.com/mac-arm64/latest-mac.yml` 应立刻返回旧版本号

备选：把出问题的 release 直接改成 draft（同样会从 `releases/latest` 消失）。

## 发版为什么不能勾 Pre-release

`releases/latest`（本 Worker 唯一依赖的地址）不包含标了 Pre-release 的版本。
勾了它，这个 Worker 就找不到最新版，整条自动更新链断掉。「内测版」三个字写在
release 标题里表达即可，不要勾这个选项。

## 降级方案

Cloudflare 服务条款限制用 CDN 大量传输非网页内容。内测规模风险低，但如果收到
Cloudflare 的提醒邮件，把 `src/index.ts` 里 `proxy()` 的转发换成
`Response.redirect(upstream, 302)` 即可——用户改为直连 GitHub，失去加速但功能
不受影响（永久链接仍然有效，只是 302 之后 `content-disposition` 失效，
存到本地的文件名会退回 `latest.dmg`）。

**但这一步会连带关掉 Windows 差量更新**：302 之后客户端直连 Azure，多区间请求又回到 501，
每次更新重新变成全量下载 244 MB（上一节）。降级是「加速换合规」，不是无代价的——真要走这步，
先想清楚是否只对 mac 降级（Windows 包大得多，差量对它更要紧）。

## 本地验证

```bash
bunx --bun wrangler dev
curl -sI http://127.0.0.1:8787/mac-arm64/latest-mac.yml
```

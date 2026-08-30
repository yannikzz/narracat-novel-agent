---
name: release-guard
description: View or change NarraCat-app's internal-test release gate / remote kill switch (the release-guard Cloudflare Worker in workers/release-guard). Use when the user wants to check the gate's current status (is it blocking users right now?), set or clear the internal-test deadline, trigger or release the emergency brake (kill switch), raise the minimum allowed version, or edit the block-screen notice. 触发词：内测开关 / 急刹车 / 看后台配置 / 改截止日 / 下线版本 / 释放门控 / release guard.
---

# 内测释放门控（release-guard）

控制内测包的「软过期 + 远程急刹车」。一个已部署的 Cloudflare Worker 返回一段 JSON，App 启动时拉取后决定要不要把用户挡在外面。**改这个 Worker、不动 App、不发新包**，约 10s 全员生效。

- 线上配置真相：Worker（`workers/release-guard/src/index.ts` 是它的源码）
- App 调用地址：写在 `electron/main/release-guard-runtime.ts` 的 `RELEASE_GUARD_URL`
- 纯判定逻辑：`electron/main/release-guard.ts`（单测 `release-guard.test.ts`）

## 1. 查看状态（默认动作）

先跑状态脚本，把结果原样转述给用户（它会显示线上当前配置、现在拦不拦人、以及本地有没有改了没部署）：

```bash
node .claude/skills/release-guard/scripts/status.mjs
```

脚本自定位仓库根，任意 cwd 可跑、只读不改。读完用一两句话总结「现在是放行还是拦人、有没有截止日」。

## 2. 调整配置

只改 `workers/release-guard/src/index.ts` 里的 `RELEASE_GATE` 这一个对象，然后部署、再复验。

| 想干嘛 | 改 `RELEASE_GATE` | 效果 |
|---|---|---|
| 定内测截止日 | `deadline: "2026-09-30T00:00:00Z"`（ISO 8601，建议带 Z/时区） | 过期后所有版本启动被拦 |
| 取消截止日 | `deadline: ""` | 不再按日期拦 |
| 🚨 紧急下线坏版本 | `kill: true` | 立即拦所有版本 |
| 解除急刹车 | `kill: false` | 恢复（再按 deadline/minVersion 判） |
| 逼旧版升级 | `minVersion: "0.1.320"`（semver） | 低于此版本被拦 |
| 改拦截页文案 | `notice: "……"` | 用户看到的提示语 |

部署（已 `wrangler login` 过；若 token 过期会提示重登）：

```bash
cd workers/release-guard && bunx wrangler deploy
```

**部署后必须复验**：再跑一次第 1 步的 status 脚本，确认线上确实变了、判定符合预期。改完务必把 `RELEASE_GATE` 和线上对上（status 脚本会报「改了没部署」的漂移）。

## 安全须知

- `kill: true` 或过期的 `deadline` 会拦**所有**装了内测包的用户，最坏 ~60s 缓存后全员生效——确认是想要的再部署。
- App 端拉取失败时 **fail-open（放行）**，不因断网误伤正常用户；唯一断网也拦的是 App 构建期烤死的「构建后 90 天」硬过期，那条与本 Worker 无关、改不了（要改得重新打包）。
- 这是公开只读端点，不收/不存任何用户数据，不带密钥。

## 完成判据

调整类操作，在说"已生效"前必须：部署成功 + status 脚本复验线上配置已更新 + 解读判定正确。仅查看则无需部署。

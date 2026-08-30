# narracat-telemetry Worker（ADR-0039）

匿名使用统计的反向代理。App 只认识 `telemetry.narracat.com`，PostHog 的域名与写入 Key 都只存在于这里。

## 为什么要这一层

| 目的 | 说明 |
|---|---|
| 中国可达性 | `eu.i.posthog.com` 在国内没有保障；`*.narracat.com` 这条 CF 链路已在中国用户真机上跑通（0.3.0 更新链接通那次）。 |
| Key 不进客户端 | PostHog 写入 Key 是 Worker secret。仓库里没有、安装包里也没有；换供应商或轮换 Key 都不必发新版。 |
| 服务端再执行一次红线 | 按事件字典白名单逐字段裁剪。客户端已经裁过一次，这里是第二道——**万一有人改了客户端，正文也进不了 PostHog**。 |

## 它接受什么

`POST /`，body 形如：

```json
{
  "batch": [
    {
      "event": "feature_used",
      "distinct_id": "<uuid>",
      "timestamp": "2026-08-30T10:00:00.000Z",
      "properties": { "module": "write-chapter", "schema_version": 1 }
    }
  ]
}
```

裁剪规则（`src/index.ts` 的 `ALLOWED`）**必须与 `shared/types/telemetry.ts` 的
`TELEMETRY_ALLOWED_PROP_KEYS` 保持一致**。两处刻意各写一份而不是共享代码：Worker 与 App
分开部署，不能假设线上跑的客户端就是当前这份源码——服务端要能独立地对着字典拦住意外字段。

不合格的单条直接丢弃；整批不合格返回 400（客户端见 4xx 会丢弃该批，不再重试）；
上游 5xx 回传 502（客户端保留队列下次补发）。

## 响应码约定

| 码 | 含义 | 客户端行为 |
|---|---|---|
| 204 | 收下了（含 Key 未配置时的"假成功"） | 清空队列 |
| 400 | 这批载荷不合字典 | 丢弃这批，不重试 |
| 405 | 非 POST | — |
| 502 | 上游 PostHog 5xx | 保留队列，下次补发 |

## 首次部署

```bash
cd workers/narracat-telemetry
bunx wrangler login
bunx wrangler secret put POSTHOG_API_KEY   # PostHog 项目的 Project API Key（只写不读）
bunx wrangler deploy
```

然后在 Cloudflare 面板给这个 Worker 绑上自定义域 `telemetry.narracat.com`
（域名硬编码在 `electron/main/telemetry/telemetry-runtime.ts` 的 `TELEMETRY_URL`）。

## 本地联调

开发态默认**不发**任何事件（见 `transportEnabled()`：未打包且没设环境变量就不发），
避免开发者自己的点击污染"功能使用度"。要联调时显式打开：

```bash
NARRACAT_TELEMETRY_URL=http://127.0.0.1:8787 bun --no-cache run dev
# 另一个终端
cd workers/narracat-telemetry && bunx wrangler dev
```

## 换供应商

改 `POSTHOG_HOST` 与转发逻辑，`wrangler deploy` 即可，**客户端不用动、不用发版**——
这是把域名握在自己手里的主要收益。

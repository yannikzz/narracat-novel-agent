# 安全政策

NarraCat 在本地存储你的小说与 API Key（系统凭据库：macOS 钥匙串 / Windows 凭据管理器），我们严肃对待任何安全问题。

## 报告漏洞

请**不要**通过公开 issue 报告安全漏洞。请使用 GitHub 私密渠道：
仓库 **Security** 标签页 → **Report a vulnerability**（Security Advisory）。

我们会在 7 天内响应，修复发布前请勿公开披露细节。

## 范围

- API Key 的存储与传输
- 小说内容的本地读写边界（不应有任何未经声明的网络上传）
- Electron 主进程/渲染进程的权限隔离

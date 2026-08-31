<div align="center">
  
<img width="2400" height="876" alt="image" src="https://github.com/user-attachments/assets/a02ae0ab-5a3a-4339-8a2b-2e6599853345" />

# NarraCat 🐈‍⬛

**面向中国网文作者的 AI 共创桌面应用**

*NarraCat is an AI-powered desktop writing studio for Chinese web-novel authors — plan, draft, and manage million-word serials with an agentic creative engine that keeps long-range plot memory.*

[![CI](https://github.com/yannikzz/narracat-novel-agent/actions/workflows/app-ci.yml/badge.svg)](https://github.com/yannikzz/narracat-novel-agent/actions)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/yannikzz/narracat-novel-agent)](https://github.com/yannikzz/narracat-novel-agent/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](https://github.com/yannikzz/narracat-novel-agent/releases)

*在人类文明中，故事一直来自人的记忆、情感与想象。<br>
从口述，到书写，再到数字时代，技术不断改变表达方式，但创造故事的，<br>
始终是人。<br>
在智能时代，创作不必再被时间与执行成本限制。<br>
NarraCat 让智能先理解你的所想，再协助构建世界观、推进剧情结构、生成章节
内容。<br>
你决定故事的意义与方向，智能负责让故事持续生长。<br>
我们不试图替代创作者，我们只希望——<br>
让更多故事，有机会被完成。*

</div>

<img width="1920" height="1130" alt="小说工作区" src="https://github.com/user-attachments/assets/08e74a47-d7be-40f9-9d13-1a2ef467c6e5" />
<img width="1920" height="1130" alt="小说大纲" src="https://github.com/user-attachments/assets/5453ab19-84c5-4dc8-886a-35d4ac48ea73" />
<img width="1920" height="1130" alt="和小说角色唠个嗑" src="https://github.com/user-attachments/assets/5c2cac53-a400-44bb-b1bd-fd2f49334780" />
<img width="3840" height="2260" alt="小说记忆图谱" src="https://github.com/user-attachments/assets/de4031c5-e25c-4f03-9f08-46d2582007d6" />


<!-- screenshots:end -->

## 三步开始写

1. **下载安装**：到 [Releases](https://github.com/yannikzz/narracat-novel-agent/releases) 下载对应系统的安装包
   - **Windows**（Windows 10 / 11，64 位）：下载 `NarraCat-x.y.z-win-x64.exe`。首次运行会弹出蓝色的「Windows 已保护你的电脑」——点**「更多信息」→「仍要运行」**即可。安装包**尚未代码签名**，所以会有这道提示；签名证书正在申请中（SignPath Foundation 开源计划）
   - **macOS**（Apple Silicon，暂无 Intel 版）：下载 `NarraCat-x.y.z-mac-arm64.dmg`。已签名并通过 Apple 公证，双击即开
2. **配置模型**：NarraCat 采用 BYOK（自带 API Key）。推荐 DeepSeek，几分钟即可申请，费用与配置见 [FAQ](./docs/faq.md)
3. **开一本书**：新建小说 → 立项卡定题材与金手指 → 让 Agent 铺大纲、写第一章

## 它能做什么

- 📖 **超长篇底座**：立项 → 大纲 → 章纲 → 成稿的全流程产品化，角色/伏笔/世界观结构化管理
- 🧠 **长程记忆**：内置 NovelMemory 记忆库，写到第 100 章仍记得第 3 章埋的钩子
- ✍️ **创作引擎全开源**：写作 prompt 工程（agents/skills/commands）就在 `agent-core/` 里，欢迎研究与改进
- 🧩 **能力包**：手写卡、从书学写法、作家向导，把你的写作偏好装进引擎
- 💬 **角色聊天**：和你笔下的角色唠个嗑，TA 记得自己的经历

## 隐私

稿件永远留在你自己的机器上，API Key 存系统凭据库（macOS 钥匙串 / Windows 凭据管理器）。

App 会收集一点**匿名使用统计**（哪个功能被打开过、写章节的成败与耗时区间、在用哪个模型渠道），
用来判断哪些功能真的有人用。**小说正文、标题、大纲、人物设定、任何你输入的文字与 Key 都不在其中，
一个字都不传。** 首次启动 / 升级后会明确告知一次，确认之前不发送任何数据；设置页可随时关闭。

事件全清单、字段逐条对照与自查方式见 [FAQ](./docs/faq.md#narracat-会收集我的数据吗)，
决策背景见 [ADR-0039](./docs/adr/0039-anonymous-telemetry-informed-opt-out.md)。

## AI 生成内容声明

- 你用 NarraCat 生成的内容，权利与责任归你
- 各网文平台对 AI 辅助创作有各自政策，投稿前请自行确认目标平台规则

## 参与

- Bug/功能建议/使用求助 → [Issues](https://github.com/yannikzz/narracat-novel-agent/issues)（**请勿粘贴小说正文与 API Key**）
- 参与开发 → [CONTRIBUTING.md](./CONTRIBUTING.md) · 架构导览 → [ARCHITECTURE.md](./ARCHITECTURE.md)
- 安全问题 → [SECURITY.md](./SECURITY.md)

## License

[AGPL-3.0](./LICENSE) — 你可以自由使用、修改、分发；基于本项目的分发或网络服务须以同等条款开源。

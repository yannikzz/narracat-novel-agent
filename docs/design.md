# Narracat Design System

本文档定义 Narracat 的视觉语言、设计 token、交互状态和组件使用规范。所有 UI 开发以此为准；实现层必须通过 token、组件变体和检查清单承接规范，禁止把视觉风格散落成一次性 class。

---

## 1. 设计哲学

三条核心原则：

1. **浮动工作台，而不是平铺后台。** 产品的第一视觉信号是 `zinc` canvas 上的一张白色 floating workspace card。Header 与 sidebar 透明地坐在 canvas 上，主工作区作为最亮、最稳定的操作平面浮起。
2. **单色建立气质，语义色只传递状态。** 界面主体只使用 zinc 中性色与半透明黑；颜色不用于装饰。`success`、`warning`、`destructive` 等语义色保留，但只用于状态点、错误边框、小型 badge 等有限场景。
3. **视觉可以更有峰值，规则必须更严格。** 新规范允许更大的圆角、更强的标题/数字字重、更明确的深度层级；但每个峰值都有使用边界，必须通过 token、组件变体和检查清单约束。

### 1.1 产品界面表达纪律

NarraCat 桌面端是创作工作台，不是说明书。界面表达必须简约、大气、克制：

- 不在界面内赘述功能。能通过结构、标题、状态和上下文表达的内容，不用说明文字重复解释。
- 菜单项和导航项只显示必要标题，不带辅助说明。辅助说明只出现在空状态、表单帮助、错误、不可恢复操作、确认提示中。
- 工具型操作优先纯 icon 按钮，例如首页、设置、刷新、折叠、搜索。
- 纯 icon 按钮必须提供 tooltip 或 `aria-label`。
- 正常和已完成状态默认不重复标注；只有承担扫描、流程进度或差异识别时，使用低权重状态点或 badge。
- 空文档引导态固定为中心图标或轻量插图、标题、正文和一个主按钮，仍遵循 Lucide、单色和非装饰性规则。

---

## 2. 颜色体系

基于 OKLCh / CSS 变量定义，Tailwind class 必须通过设计 token 表达。允许使用 `black/[0.02]` 到 `black/[0.10]` 这类半透明黑作为 hairline / hover / active 的底层变量，但生产代码应优先映射到 token（如 `border`、`hover`、`active`、`glass-border`），避免散落任意值。

### 2.1 中性色阶梯

界面 95% 的面积由单色中性色构成。灰度等级即空间层级：

| 角色 | Light Token | Dark Token | 用途 |
|------|-------------|------------|------|
| Canvas 背景 | `background` = `#F4F4F5` | `background` = `oklch(0.18 0.005 285.823)` | 页面最外层底色，永远不是纯白/纯黑 |
| 主工作区 | `workspace` / `card` = `#FFFFFF` | `workspace` / `card` = `oklch(0.21 0.006 285.885)` | floating workspace card、主内容容器 |
| 玻璃卡片 | `glass` = `white/70` + blur | `glass` = `white/6` + blur | 内部统计卡、note/card、浮动输入 |
| 侧向玻璃层 | `glass-aside` = `white/20` + `backdrop-blur-2xl` | `glass-aside` = `white/8` + blur | 右侧 workspace panel、辅助上下文面板 |
| Hairline 边框 | `border` = `black/[0.07]` | `border` = `white/[0.10]` | 卡片边框、分割线、header rule |
| 强边框 | `border-strong` = `black/[0.12]` | `border-strong` = `white/[0.16]` | resizer、aside 左边界、active 分隔 |
| Hover 背景 | `hover` = `black/[0.02-0.04]` | `hover` = `white/[0.06-0.08]` | 列表项、ghost button、icon button |
| Active 背景 | `active` = `black/[0.05]` | `active` = `white/[0.10]` | tab、sidebar selected、toggle selected |
| 主要文字 | `foreground` = `zinc-900` | `foreground` = `zinc-50` | 标题、正文、active icon |
| 正文文字 | `body-foreground` = `zinc-700` | `body-foreground` = `zinc-200` | 长文本、AI 输出、说明正文 |
| 次要文字 | `muted-foreground` = `zinc-500` | `muted-foreground` = `zinc-400` | 描述、元数据、inactive tab |
| Hint / Icon | `hint-foreground` = `zinc-400` | `hint-foreground` = `zinc-500` | placeholder、默认图标、eyebrow |
| 主操作 | `primary` = `zinc-900` | `primary` = `zinc-50` | 每屏唯一 CTA、submit、关键确认 |

**规则：** 同一屏幕内，文字颜色最多使用 4 个层级：`foreground` / `body-foreground` / `muted-foreground` / `hint-foreground`。语义色不计入文字层级，但只能用于状态含义。

**Workspace 内部背景约束：**

- `background` 只用于 app canvas、route root、auth/onboarding 的最外层页面底色；不要在 floating workspace card 内部用 `bg-background` 做模块背景。
- workspace 内部的默认内容区应该是透明的，让白色 `workspace` 平面自己承担主体层级。分隔优先使用间距、hairline、tab underline、`hover` / `active` 状态。
- `card` / `workspace` 用于真正独立扫描的白色内容块；`glass` 只用于少量浮动层、note、统计卡、输入 dock，不是所有内部 section 的默认背景。
- 在右侧详情页、设置页、资源页这类 dense workbench 中，禁止为了“分组”给每个内部 section 都加背景框。能用标题、留白、细分割线表达结构时，不再增加卡片容器。
- “透明”不等于“无边界”。当一个页面内存在多个同级容器时，必须选择一种结构分隔：左右 panes 用 `border-r` / `border-l`，上下 sections 用 `border-b`，设置/权限这类表单组用白底 `card` + 外轮廓 + `divide-y`。禁止用灰底背景来表达分组。

### 2.2 语义色

颜色只用于传递含义，不做装饰。语义色是系统信号，不是品牌色：

| Token | 含义 | 使用场景 |
|-------|------|----------|
| `brand` | 产品标识 | Logo、小面积品牌标记、低频品牌引导；不映射到 `primary` / `active` / 状态色 |
| `destructive` | 危险/错误 | 删除按钮、表单错误、危险操作确认 |
| `success` | 成功 | 在线、完成、健康状态点 |
| `warning` | 警告 | 注意状态、到期提醒、需要人工介入 |
| `info` | 信息 | 低风险提示、小面积链接/标记 |
| `priority` | 优先级 | 高优先级标签；优先使用字重/边框，少用大面积颜色 |

**规则：**
- 语义色主要用于 `size-2` 状态点、badge 文本、icon、边框或 `bg-*/10` 以内的浅底。禁止把完整卡片、整行列表或大按钮染成语义色。
- 每屏同时出现的语义色不宜超过 2 种。若需要红黄绿蓝同时出现，先改信息架构：分组、过滤或折叠。
- IconTile、统计卡、导航图标默认全部单色化；即使 API 有 `tone="blue"` 这类语义 prop，视觉也应折叠到 `bg-zinc-50 text-zinc-500` 或对应 token。

### 2.2.1 品牌色

NarraCat 主品牌色为 `#04C853`。它是产品身份色，不是成功状态色，也不是主操作色。

实现层必须提供独立 brand token：

```css
--brand: #04C853;
--brand-foreground: #03130A;
--brand-soft: color-mix(in oklch, var(--brand) 10%, transparent);
--brand-border: color-mix(in oklch, var(--brand) 24%, transparent);
```

**允许：**
- About、启动页、首次引导、空 Library 的低频品牌细节。
- Logo 容器的极轻边框或低透明背景。
- 品牌插图周边的轻量 `brand-soft` / `brand-border`。

**禁止：**
- 把 `brand` 映射为 `primary`、`active`、`success`、`warning` 或 `info`。
- 用品牌绿做普通正文、正文链接、tab active、sidebar active 或 Agent running。
- 用品牌绿染整张卡片、整行列表或工作台背景。

`#04C853` 不适合作为白底普通文字色。需要在品牌色背景上放字时，使用 `brand-foreground`，并保持这种情况低频出现。

### 2.2.2 文本框选色

文本框选是阅读和编辑反馈，不是导航选中态。它必须使用独立 `text-selection` token，默认为浅蓝色；文字仍使用 `foreground`，保证中文长文本在浅色和暗色模式下都可读。

**规则：**
- 全局 `::selection`、输入框和 textarea 的框选背景统一使用 `text-selection`。
- 禁止复用 `active` / `hover` 作为文本框选色；它们只表达组件 hover、selected 或 active 状态。
- 禁止在组件里散写 `selection:bg-blue-*` 或任意蓝色 class；如果需要调整框选视觉，只改 `text-selection` token。
- `text-selection` 只用于浏览器文本框选，不用于 badge、按钮、sidebar active、tab active 或大面积背景。
- 框选后的浮动操作按钮使用 `shadow-selection-toolbar`，这是近距离实体阴影；不要复用更大更散的 `shadow-floating`。

### 2.3 暗色模式

暗色模式不是 light 模式反转。它保留同样的空间层级：

- Canvas 使用深灰 `oklch(0.18 0.005 285.823)`，不是纯黑。
- Floating workspace card 比 canvas 略亮，保持“主工作区浮起”的关系。
- Light 模式的 `black/[0.04]` hairline 在 dark 模式映射为 `white/[0.10]`，不要使用纯白边框。
- 语义色在 dark 模式下适当提亮，但面积限制不变。
- 所有 UI 变更必须同时验证 light/dark，特别是 glass 层和 hairline 的对比度。

---

## 3. 字体规范

### 3.1 字体家族

| 角色 | 字体 | 用途 |
|------|------|------|
| 正文/UI | MiSans (`--font-sans`) | 桌面端所有界面文字的默认字体；通过项目内 `MiSansVF.woff2` 注册，fallback 到 Inter / 系统 CJK 字体（PingFang SC / Microsoft YaHei / Noto Sans CJK SC） |
| 代码/数据 | Geist Mono (`--font-mono`) | 代码块、ID、时间戳、等宽数据 |
| 标题 | `--font-heading`（= `--font-sans`） | 页面标题、区块标题、空状态标题 |

字体栈和 `@font-face` 在 `src/styles/globals.css` 中声明，字体授权说明保存在 `src/assets/fonts/misans/` 并在设置页「关于」中注明。不要为了“高级感”额外引入 serif 或 display 字体；产品气质来自结构、圆角、深度和灰度层级。

### 3.2 字号纪律

**整个项目使用 5 个受控字号层级 + 1 个特殊字号：**

| Tailwind Class | 大小 | 角色 | 使用场景 |
|----------------|------|------|----------|
| `text-3xl` / `text-[2.5rem]` | 30-40px | Hero 峰值 | 空状态 hero、极少数启动页/首屏标题 |
| `text-2xl` / `text-4xl` | 24-36px | 数据峰值 | StatCard 关键数字、仪表盘核心指标 |
| `text-lg` | 18px | 页面标题 | PageHeader 标题、主要 view 标题 |
| `text-base` (16px) | 正文重点 | 编辑器正文、重要空状态说明、阅读内容 |
| `text-sm` (14px) | 默认 | 按钮、菜单项、列表项、表单、普通正文 |
| `text-xs` (12px) | 辅助 | badge、时间戳、状态栏、eyebrow、元数据 |
| `text-[0.8rem]` | 过渡 | 仅限 sm 按钮 | shadcn button size="sm" 专用 |

**规则：**
- `text-lg` 以上必须有明确角色：页面标题、关键指标、空状态 hero。普通卡片标题、列表项、弹层内容不得随意升级。
- 任意像素字号只允许在已定义的产品峰值中出现（如 hero `text-[2.5rem]`、agent body `text-[15px]`），新增前必须写进规范或组件变体。
- 在同一个区块里混用超过 3 个字号通常说明结构有问题。优先用字重、颜色层级、间距解决。

### 3.2.1 字号角色契约（typography role contract）

字号纪律给出**层级**；这里把产品里反复出现的**语义位置**钉到稳定**角色**，避免在页面里凭感觉写 `text-xs` / `text-sm`，也避免主内容空态被误当成元数据。实现层在 `src/design-system/typography.ts` 导出对应常量，Workbench / Agent / Library / Settings 复用同一套角色，不新增一次性字号。

| 角色 | 常量 | 字号 | 用途 |
|------|------|------|------|
| primary empty title | `EMPTY_PRIMARY_TITLE_CLASS` | `text-lg` | Workbench 主内容区「内容缺失」空态标题（未选对象、文件/正文/大纲未生成） |
| primary empty body | `EMPTY_PRIMARY_BODY_CLASS` | `text-sm leading-6` | 主空态说明正文 |
| compact empty title | `EMPTY_COMPACT_TITLE_CLASS` | `text-sm` | loading / 次级密集空态标题（「正在读取…」） |
| compact empty body | `EMPTY_COMPACT_BODY_CLASS` | `text-xs` | loading / 次级密集空态说明 |
| metadata | `METADATA_TEXT_CLASS` | `text-xs` | badge、时间戳、状态栏、eyebrow |
| Agent body | `AGENT_BODY_CLASS` | `text-[15px]` | Agent 对话正文 |
| Agent question title | `AGENT_QUESTION_TITLE_CLASS` | `text-sm` | AskUserQuestion 提问标题 |
| Agent question options | `AGENT_QUESTION_OPTION_CLASS` | `text-sm` | 选项标题与说明 |
| Agent question input | `AGENT_QUESTION_INPUT_CLASS` | `text-sm` | 自定义回答输入 |

**规则：**
- Workbench 主内容区「内容缺失」空态使用 primary 角色：标题 `text-lg`、说明 `text-sm leading-6`，让它读起来是主内容状态，而不是元数据。
- loading、次级和密集面板继续使用 compact / metadata 角色（`text-xs` 级别），不要为了一致把它们也放大。
- Agent 对话正文不得低于 `text-[15px]`；AskUserQuestion 的选项和自定义输入不得低于 `text-sm`。
- 新增空态、Agent 文本或提问卡片时，引用 `typography.ts` 常量，不要回到硬写字号；需要新角色时先在本表登记再导出常量。

### 3.2.2 Typography 漂移治理与视觉验收

字号角色契约要长期成立，必须有防漂移的默认约束和最小验收路径。新功能先选 typography role，再写组件 class。

**自动治理（`check:design`）：**
- 校验本节与 §3.2.1 的规范文本、`src/design-system/typography.ts` 的角色常量导出，以及代表组件确实引用 contract：`WorkbenchEmptyState` / `WorkbenchEmptyGuide`（空态）、`MarkdownRenderer`（对话正文）、`AgentQuestionCard`（提问卡片）。
- 禁止在生产代码新增脱离 scale 的任意字号（`text-[13px]` / `text-[17px]` 等夹在受控层级之间的值）。已登记的特殊字号——hero `text-[2.5rem]`、agent body `text-[15px]`、sm 按钮 `text-[0.8rem]`——和 badge 微缩字号 `text-[11px]` / `text-[10px]` 属既有约定，不在禁列。

**人工视觉验收路径（最小集）：**

新功能若触及下列任一 surface，提交前用 `bun --no-cache run dev` 起真实 Electron 窗口（Workbench / Agent 面板等调用 `window.electron` 的页面不能只用浏览器验证）或截图，走查关键视口做 smoke：

| 场景 | 覆盖点 | 模式 | 面板宽度 |
|------|--------|------|----------|
| Workbench 主空态 | primary empty title/body 不像元数据 | light + dark | 默认 |
| Reference works source-ready（待分析页） | hero 与主空态共享角色，不再 `text-2xl` | light + dark | 默认 |
| Agent 普通长输出 | 对话正文为 `text-[15px]`，长 token 不撑宽 | light + dark | 窄 320 / 默认 / 宽 640 |
| AskUserQuestion 卡片（running） | 选项与输入 ≥ `text-sm`，插图不遮挡 | light + dark | 窄 320 / 默认 / 宽 640 |

自动测试已覆盖长 token 换行与 contract 引用；上表场景的暗色对比与实际视觉层级需人工确认，属未自动化风险。

**剩余可接受债务（不需无差别放大）：**
- metadata、badge、时间戳、eyebrow、tab、Agent 过程行等 compact 文字保持 `text-xs` / `text-[11px]` / `text-[10px]`，这是信息密度需要，不是漂移。
- Library 书籍封面的展示型大字（`text-[44px]` / `text-[26px]` / `text-[24px]` / `text-[16px]`）属封面视觉设计，留待 Library 视觉迭代统一，不在本轮 typography 迁移范围。
- 历史组件里零散未触达的 `text-xs` 不要求一次性重写；重构该 surface 时再迁到 contract。

### 3.3 字重

使用四个受控字重：

| 字重 | 用途 |
|------|------|
| `font-normal` (400) | 正文、长描述、AI 输出 |
| `font-medium` (500) | 按钮、标签、列表项、普通导航 |
| `font-semibold` (600) | 页面标题、active tab、重要卡片标题 |
| `font-bold` (700) | 关键数字、hero、极少数强调标题 |

**禁止** `font-extrabold` 常态化。若需要 800，必须是单一特殊场景（如文档阅读器 H1）并在组件文档中说明。默认不要给中文大段文字使用负字距；`tracking-tight` 只用于英文主标题、数字、tab 等短文本，uppercase eyebrow 使用 `tracking-widest`。

---

## 4. 间距体系

基于 Tailwind 的 4px 基础网格。间距传递信息，也构成 floating workspace 的识别度。

### 4.1 间距语义

| 间距 | Tailwind | 含义 |
|------|----------|------|
| 4px | `gap-1` / `p-1` | **紧密关联** — icon 与文字、微型按钮内部 |
| 6px | `gap-1.5` / `p-1.5` | **组件内部** — tab、toolbar、紧凑列表 |
| 8px | `gap-2` / `p-2` | **同组不同项** — 表单字段、普通按钮 |
| 10px | `gap-2.5` / `p-2.5` | **舒适行高** — sidebar row、chip、list row |
| 12px | `gap-3` / `p-3` | **小节内** — card 内部、popover 内部 |
| 16px | `gap-4` / `p-4` | **组间分隔** — 小区块之间 |
| 20px | `gap-5` / `p-5` | **面板头部** — WorkspacePanel header、紧凑页面边距 |
| 24px | `gap-6` / `p-6` | **卡片内容** — GlassCard、modal、表单组 |
| 32px | `gap-8` / `p-8` | **页面内容** — ViewShell body、宽松 dashboard |

**规则：** 主工作区采用 floating card 时，外层 gutter 默认为 `mt-1.5 mr-3 mb-3`；页面内容区优先使用 `p-6` 或 `p-8`。Header / titlebar / panel header 必须有垂直呼吸感：单行 header 高度不低于 `h-12`，带标题+副标题或右侧 actions 的 titlebar 使用 `h-14` 到 `h-16`，上下留白不低于 10px，避免文字和按钮贴近上下 hairline。如果需要分割线，先确认能否通过间距和 hairline 透明度解决。

### 4.2 容器策略（按优先级排序）

当需要在视觉上分隔两个区域时：

1. **空间层级** — canvas vs floating workspace card（首选，用于 app shell）
2. **仅间距** — 增大两个区域的间距
3. **结构线** — `border` token；左右 panes 用单侧边框，上下 sections 用 `border-b`
4. **Grouped container** — `bg-card border border-border divide-y divide-border`，用于设置项、权限组、表单组、表格状列表
5. **Glass surface** — `bg-white/70 backdrop-blur-xl border-border`
6. **完整卡片** — 大圆角 + hairline + padding（用于真正可独立扫描的内容块）

用最轻的工具完成分隔，但主 app shell 必须优先体现 floating workspace card，而不是平铺满屏。

### 4.3 Workbench 宽度与滚动条

Workbench 使用固定 px 侧栏 + 流式内容区，不使用百分比作为可拖动宽度的产品规则。Sidebar 和 Agent 是工具轨道，宽度必须稳定；中间内容区吃剩余空间。当前约束为：Sidebar `200-360px`、默认 `260px`；Agent `320-640px`、默认 `460px`；内容区优先保留不低于 `480px`；拖拽手柄统一 `6px`，并把 Workbench 右侧 `12px` gutter 纳入宽度计算。拖动任一手柄时，先保证内容区最小阅读宽度，再限制对应侧栏的最大值。拖动过程中只更新 grid style，松手后再提交 React state 和持久化宽度，避免每个 pointermove 触发 Workbench 内容区和 Agent 区重渲染。

所有原生滚动条必须匹配 sidebar 的 ScrollArea 语言：透明轨道、`10px` 视觉占位、圆形 `border` token thumb，hover 切换到 `border-strong`。不要在内容区、Agent 区或弹出层里单独定义更深、更宽或彩色滚动条。

### 4.4 平台顶栏让位（mac 红绿灯 / Windows caption）

窗口是无边框的（`titleBarStyle: 'hidden'`），但两个平台的系统窗口按钮仍由系统绘制在我们的 UI **之上**：mac 的红绿灯在左上角，Windows 的最小化/最大化/关闭在右上角。它们不参与我们的布局，只会盖住我们的内容——所以顶部区域必须主动让位。

这是**全局布局契约**：任何新页面、新浮层只要有元素贴近窗口顶边，都要按本节处理。

#### 让位量只有一个来源

平台由 `<html data-platform>` 决定（`src/main.tsx` 从 preload 的 `window.electron.platform` 取，主进程平台为准）。三个 CSS 变量是**唯一的让位量来源**，页面一律不许自己硬编码像素：

| 变量 | darwin | win32 | 其他 | 含义 |
|------|--------|-------|------|------|
| `--titlebar-inset-left` | `112px` | `0` | `0` | 左上角红绿灯占位宽 |
| `--titlebar-inset-right` | `0` | `150px`（回退值） | `0` | 右上角 caption 按钮占位宽 |
| `--titlebar-gutter-top` | `0` | `56px` | `0` | caption 带高度，等于 `window.ts` 的 `TITLE_BAR_HEIGHT` |

`--titlebar-inset-right` 的 `150px` 只是 100% 缩放下的**回退值**。真实值由 `main.tsx` 用 Window Controls Overlay API（`navigator.windowControlsOverlay.getTitlebarAreaRect()`）在运行时实测后写成内联变量覆盖——125% / 150% 缩放下 caption 实际更宽，硬编码必漏。不要因为看到 `150px` 就以为它是常量。

#### 两套策略，新页面按页面结构选

| 页面结构 | 策略 | 代表页 | 做法 |
|---|---|---|---|
| 有**通栏 header** | **水平让位** | 书架（`AppShell`） | header 左右 padding 分别消费 `inset-left` / `inset-right`。系统按钮落在通栏 header 上不构成混排 |
| 无通栏 header，canvas 上直接浮起卡片 | **上下分区** | 工作台、设置页 | 卡片容器顶部 padding 消费 `gutter-top`，卡片从 caption 带**下方**开始，系统按钮悬在 canvas gutter 上；左侧栏保持通顶 |

两套并存不是历史包袱：上下分区解决的是「系统按钮压在卡片白底上、与卡片自身的图标按钮读成一团」，而通栏 header 本来就没有这个问题。**选错的代价是 Windows 上按钮打架，而 mac 上看不出来**——所以选择依据是页面结构，不是个人偏好。

#### 消费写法（照抄，不要自创）

```
左：pl-[max(1rem,calc(var(--titlebar-inset-left)+1rem))]
右：pr-[max(1rem,calc(var(--titlebar-inset-right)+0.75rem))]
顶：pt-[max(0.75rem,var(--titlebar-gutter-top))]
```

三条规则，缺一条就会出 bug：

1. **兼作视觉间距的 padding 必须 `max()` 保底。** 非 mac / 非 win 平台变量是 `0`，若这一侧 padding 同时承担内容与窗口边缘的正常间距，裸写 `pl-[var(--titlebar-inset-left)]` 会让它直接归零——布局在这些平台上塌掉，而开发机上永远复现不了。
   *例外：纯让位型 padding 可以裸写。* 当某侧 padding 的**唯一职责**就是给系统按钮腾地方、不承担任何视觉间距时（`justify-end` 的左栏头部曾是典型：内容右对齐，左侧本就该是空的），归零正是期望行为。判断依据是**这侧 padding 去掉后设计上是否还需要间距**，不是「有没有写 max()」。
   **该例外目前全仓无实例**（2026-08-30）：原先援引的 `SettingsLayout.tsx` 与 `WorkbenchPrimarySidebar.tsx` 两处左栏头部，因下文「win32 顶栏左端的品牌标识」不再是空的，已改为 `pl-[max(0.75rem,var(--titlebar-inset-left))]`。例外规则本身保留——将来出现真正空着的左栏头部仍适用。
2. **呼吸位不可省。** 系统按钮与我们的图标之间只隔一条让位线时会被读成同一组按钮。左右各留 `1rem` / `0.75rem`。
3. **已经在 caption 带下方的元素不要二次让位。** 上下分区之后，卡片内部的头部（Agent 面板头、聊天卡头）已经整体位于系统按钮下方，再消费 `inset-right` 会把按钮无故推离卡片右缘上百像素。

**例外是全屏覆盖态**：`fixed inset-0` 的浮层（如记忆星图全屏）会盖住整个窗口、包括 caption 带，必须重新让位。

#### 让出去的地方必须还能拖窗口

窗口无边框，**「能不能拖动窗口 / 双击能不能最大化」完全由页面自己声明 `-webkit-app-region: drag` 决定**，系统不会因为那里是标题栏高度就自动给。

这条最容易漏在**上下分区**策略上：`pt-[max(…,var(--titlebar-gutter-top))]` 让出来的那条带在 DOM 里只是父容器的 padding，**padding 不带 drag 属性**——顶栏于是成了拖不动、双击也无反应的死区。上下分区的每个消费点都必须补拖拽层：

```tsx
<main className="relative pt-[max(0.75rem,var(--titlebar-gutter-top))]">
  {/* …内容… */}
  <TitlebarDragGutter />   {/* 放最后一个子节点：同 z-auto 时后置节点在上 */}
</main>
```

`TitlebarDragGutter`（`src/components/TitlebarDragGutter.tsx`）贴容器顶边、高度取 `var(--titlebar-gutter-top)`，非 win32 平台高度归零、等同不存在。**`titlebar-windows-chrome.test.ts` 扫全部生产源码强制这条**：凡把 `--titlebar-gutter-top` 用作顶部 padding 又没挂拖拽层的文件，测试会红并点名。

水平让位策略（通栏 header）不受此限——header 本体已经声明 drag，其中的交互件反声明 `no-drag` 即可。**全屏覆盖层同理需要自带 drag**（首启五幕顶条即为一例，否则整个首启期间窗口拖不动）。

同样只在 Windows 上暴露：mac 的 `--titlebar-gutter-top` 为 `0`、卡片通顶、卡片自身的 h-14 header 就是 drag 区，本机开发永远看不见这个洞。

#### win32 顶栏左端的品牌标识

mac 的左上角归红绿灯，Windows 那个位置系统不占——按 Windows 桌面软件惯例应放 **logo + 应用名**，空着会显得像半成品。故 win32 顶栏左端统一挂 `BrandLockup`：

- **图书馆**（通栏 header）：品牌 mac 居中（`navCenter`）、win32 靠左（`navStart`）。
- **工作台 / 设置**（上下分区）：左栏 headbar 左端，`size="sm"`。

平台差异一律收在样式层，不写 JS 分支——`globals.css` 定义了 `@custom-variant win32 (&:is([data-platform="win32"] *))`，两份品牌都渲染、由 `win32:inline-flex` / `win32:hidden` 选显示哪一份，组件树两平台同构。**这条变体的定义有守卫钉住**：Tailwind 对未定义变体不报错、直接不生成规则，删掉它的后果是品牌永远 `hidden`，且只在 Windows 上表现为「左上角还是空的」。

品牌不是交互件，落在 `no-drag` 槽里时要单独还原 `[-webkit-app-region:drag]`，否则左上角又多一块死区。左栏可被拖到 200px，品牌须 `min-w-0` + 文字 truncate 让位给右侧图标组——挤到极限只裁品牌名，不挤坏按钮。

#### 与间距 scale 的关系

本节是 §10 / §11「间距使用 Tailwind 内置 scale、不写任意值」的**明确例外**——让位量是运行时决定的平台值，scale 无法表达。例外仅限本节这三个变量的消费，不构成在别处写任意间距的理由。

#### 已知耦合点

`--titlebar-gutter-top` 的 `56px` 必须与 `electron/main/window.ts` 的 `TITLE_BAR_HEIGHT` 保持一致。这是跨文件硬编码，改任一侧都要改另一侧，否则 Windows 上卡片与 caption 带错位，且没有任何测试会红。

---

## 5. 交互状态

这是设计一致性的核心。每种状态必须在所有组件中表现一致。

### 5.1 状态层级概览

```
默认 (rest) → hover → pressed → selected/active → focused → disabled
```

### 5.2 Hover 状态

Hover 是“我注意到你了”，视觉变化应该轻微、即时、单色：

| 元素类型 | Hover 效果 | Token |
|----------|-----------|-------|
| 列表项/菜单项 | 半透明黑背景 | `hover:bg-hover`（light=`black/[0.03-0.04]`） |
| Ghost 按钮 | 半透明黑背景 + 文字变深 | `hover:bg-hover hover:text-foreground` |
| 次要按钮 | 半透明黑背景 | `hover:bg-black/[0.02]` |
| 主按钮 | 黑色略浅，文字保持 `primary-foreground` | `hover:bg-zinc-800 hover:text-primary-foreground` |
| 文字链接 | 文字变深或下划线出现 | `hover:text-foreground` / `hover:underline` |
| Tab 标签 | 半透明黑背景 + 文字变深 | `hover:bg-black/[0.02] hover:text-foreground` |
| 图标按钮 | 半透明黑背景 | `hover:bg-black/[0.04]` |
| 危险按钮 | 只在危险色透明底上加深 | `hover:bg-destructive/20` |

**规则：**
- hover 不改变布局尺寸，不新增重阴影。
- hover 背景永远比 selected/active 更淡。
- 所有 hover 使用 `transition-all duration-200` 或 `transition-colors duration-200`。

### 5.3 Active / Selected 状态

Active 是“我已经被选中了”，视觉比 hover 更重：

| 元素类型 | Active 效果 | Token |
|----------|------------|-------|
| Sidebar 菜单项 | 半透明黑背景 + 文字变深 + font-semibold | `data-active:bg-active data-active:text-foreground data-active:font-semibold` |
| Tab | rounded chip 背景 + 文字变深 + font-semibold | `data-[state=active]:bg-active data-[state=active]:text-foreground` |
| 列表选中行 | 半透明黑背景 + 左侧状态标记 | `bg-active` + marker |
| Toggle（开） | 黑色 CTA 或 active 背景 | `data-[state=on]:bg-primary data-[state=on]:text-primary-foreground` |

**关键区分：** Hover = `black/[0.02-0.04]`，Active = `black/[0.05]` + `font-semibold` + `text-foreground`。Active 始终比 hover 多一个视觉维度。

### 5.3.1 Active 不被 Hover 覆盖

这是最容易出 bug 的地方：用户 hover 到一个已选中的项目上，hover 样式覆盖了 active 样式，导致选中态“闪回”普通 hover 态。

**原则：Active 状态在任何时候都必须保持可辨识——包括被 hover 时。**

实现方式：

**方式一：Active 使用 hover 不涉及的维度**

如果 hover 只改背景，那 active 用字重 + 文字颜色来区分：

```tsx
// ✅ hover 只管背景，active 靠字重和颜色
hover:bg-hover
data-active:font-semibold data-active:text-foreground
```

**方式二：Active + Hover 组合样式**

当 active 也用了背景色时，需要显式定义 “active 且 hover”：

```tsx
// ✅ 显式处理 active+hover 复合态
cn(
  "hover:bg-hover",
  "data-active:bg-active data-active:text-foreground data-active:font-semibold",
  "data-active:hover:bg-active"
)
```

```tsx
// ❌ 反例：hover 覆盖 active
cn(
  "hover:bg-black/[0.03]",
  "data-active:bg-black/[0.05]",
  // 没有处理复合态 → hover 到 active 项时背景降级
)
```

**方式三：CSS 选择器优先级**

利用 `:not()` 让 hover 只作用于非 active 的元素：

```tsx
data-active:bg-active data-active:text-foreground
not-data-active:hover:bg-hover
```

**检查方法：** 写完任何带 hover + active 状态的组件后，必须手动验证——先点击选中一项，然后鼠标移到该项上再移开，确认视觉不会闪烁或降级。

### 5.4 Pressed 状态

物理反馈感使用轻微 scale，而不是 1px 下移：

| 元素类型 | Pressed 效果 |
|----------|--------------|
| Icon-only CTA / send button | `active:scale-[0.92]` |
| Header tab / compact toolbar button | `active:scale-[0.95]` |
| 标准按钮 | `active:scale-[0.97]` |
| 大列表行 / sidebar row | `active:scale-[0.98]` |

所有 pressed 状态必须配合 `transition-all duration-200`。Icon-only primary action（send、submit、continue）如果宽高相等，必须使用 `rounded-full` 做正圆，不使用 rounded square。禁止 `scale-105` 这类放大反馈。

### 5.5 Focus 状态

Focus 为键盘导航服务。所有可交互元素统一使用：

```tsx
focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50
```

- 使用 `focus-visible`，避免鼠标点击时出现 focus ring。
- ring 颜色使用 `ring` token，中性、低干扰，不跟随语义色，危险场景除外。

### 5.6 Disabled 状态

```tsx
disabled:pointer-events-none disabled:opacity-50
```

简单统一。不需要为每个组件定制 disabled 样式。禁用项不参与 hover / pressed。

### 5.7 Error / Invalid 状态

```tsx
aria-invalid:border-destructive aria-invalid:ring-destructive/20
```

- 使用 `aria-invalid` 属性触发，与表单校验库自然对接。
- 只改变边框和 ring，不大面积染红背景。
- 错误信息用内联文字展示；toast / alert banner 只用于重要系统错误。

### 5.8 复合浮层状态

当同一个 trigger 同时承载 Tooltip 和 Dropdown / Popover / Menu 时，不能让每个浮层各自管理 open 状态。Tooltip 会响应 hover 和 focus，菜单关闭后焦点通常会回到 trigger，如果不协调状态，容易出现菜单已关闭但 tooltip 仍残留的问题。

**规则：**

- 复合 trigger 的浮层状态由上层组合组件协调，而不是只依赖 Tooltip 的默认 hover / focus 行为。
- Dropdown / Popover 打开时必须关闭 tooltip；通过 outside click、Escape 或 menu item 关闭时，也必须同步关闭 tooltip。
- 菜单关闭后的 focus return 不能立刻重新打开 tooltip。需要短暂抑制 focus 触发，直到 blur 或新的 pointer enter 重新建立用户意图。
- 抑制只用于防止残留，不应永久禁用 tooltip。菜单关闭后下一次真实 hover 仍应正常显示 tooltip。
- 这类交互必须验证两个方向：关闭菜单后没有残留 tooltip；再次 hover trigger 后 tooltip 仍可正常出现。

---

## 6. 图标规范

### 6.1 图标库

统一使用 **Lucide React**（`lucide-react`）。

禁止混用其他图标库（Heroicons、Phosphor 等），也禁止自制 SVG 图标（除非 Lucide 确实没有合适的）。

### 6.2 图标尺寸

图标尺寸与组件尺寸绑定：

| 组件尺寸 | 图标尺寸 | 示例 |
|----------|---------|------|
| xs（h-6） | `size-3` (12px) | 紧凑按钮、badge 内图标 |
| sm（h-7） | `size-3.5` (14px) | 小按钮、紧凑列表 |
| default（h-8） | `size-4` (16px) | 标准按钮、菜单项、表格操作 |
| lg（h-9 / h-10） | `size-4` / `size-[18px]` | 大按钮、floating input submit |
| hero / empty | `size-6` 到 `size-8` | 空状态中心图标、非装饰性引导 |

**规则：**
- 独立装饰性图标最大 `size-8` (32px)，除非是明确的空状态中心符号。
- 所有图标默认继承父元素文字颜色。需要弱化时用 `hint-foreground` 或 `muted-foreground`。
- 图标与文字的间距：`gap-1`（xs）/ `gap-1.5`（sm/default）/ `gap-2`（宽松排列）。

### 6.3 图标颜色

- **导航/操作图标：** `text-muted-foreground`，hover 时变为 `text-foreground`
- **状态图标：** 使用对应语义色（如 `text-success`、`text-destructive`），仅限状态语义
- **Active 状态图标：** `text-foreground`
- **IconTile：** 默认单色 `bg-zinc-50 text-zinc-500` 或对应 token；不要按功能染成蓝/紫/绿/橙

---

### 6.4 工作台二级 Tab

小说详情页中间内容区的文档 tabbar 是二级导航，不使用标准按钮尺寸：

- Tab item 使用 `h-7 px-2.5 text-xs`，只承载文档标题和必要状态点。
- Active 态保留 `bg-active font-semibold text-foreground`，不要通过增大字号或高度强调。
- Tabbar 容器高度控制在 `h-9` 到 `h-10`，避免挤占正文阅读区域。

---

### 6.5 Logo 与品牌插图

品牌资产通过专用原语进入产品，不在页面里散写 `img`、尺寸和色彩规则。

推荐实现模块：

```text
src/components/brand/
  BrandMark.tsx
  BrandLockup.tsx
  BrandIllustration.tsx
  brand-illustrations.ts
```

当前 Logo 资产位于 `src/assets/brand/narracat-mark.webp`。Logo 通过 `BrandMark` 以原始图片直接展示，不额外包裹装饰容器，也不按背景色做反相、染色或 token remap；浅色和暗色模式使用同一张 `narracat-mark.webp`。Workbench chrome 使用 24-32px 标记，Library / Settings 顶栏使用 32px 标记，About / 启动页使用 48-56px 标记。Logo 不进入项目卡片、Markdown 阅读区、Agent 消息、按钮 icon、状态 badge、章节或 artifact 卡片。

品牌插图位于 `src/assets/illustrations/narracat/`，只用于高价值引导空态：空 Library、首次创建小说、Workbench 未选择项目、Agent 新会话、重要文档缺失且有主 CTA 的 `WorkbenchEmptyGuide`。加载、错误、普通 artifact 缺失和密集工作区轻提示继续使用 Lucide 小图标。

**Agent 提问卡片例外：** Agent 提问卡片是 Conversation stream 中需要作者行动的高优先级互动决策卡，不按普通 Agent 消息处理。待回答状态允许使用低对比浅绿色到白色渐变背景，并可放置 40-56px 的装饰性猫咪插图；插图必须通过 `BrandIllustration` registry 的专用 purpose 进入组件。完成态应回到更中性的卡片表现，避免历史对话中多张品牌卡片干扰阅读。该例外不允许放 Logo，不允许使用高饱和整卡品牌绿，也不允许让插图遮挡问题、选项或提交动作。

品牌插图按任务阶段 purpose 绑定，页面代码不得直接绑定具体文件名。第一版 purpose：

```ts
type BrandIllustrationPurpose =
  | 'empty-library'
  | 'create-novel'
  | 'agent-ready'
  | 'setup-needed'
  | 'reference-works-needed'
  | 'reference-works-ready'
  | 'outline-needed'
  | 'draft-needed'
  | 'review-needed'
  | 'checkpoint'
  | 'project-missing'
  | 'agent-question'
  | 'about'
```

尺寸规则：Agent 侧栏空态 72-96px，Workbench 内容空态 96-128px，Library 空项目 128-160px，首次引导 / 启动页 180-220px。插图默认装饰性，使用 `alt=""` 和 `aria-hidden="true"`；语义由空态标题和正文承担。

单个场景不能同时堆满 Logo、插图、tagline、长文和 CTA。Workbench 文档缺失只使用插图、任务标题和 CTA；About 可以使用 Logo/lockup、tagline、secondary line 和低权重品牌故事。

---

## 7. 圆角规范

基于更柔和的 floating workbench 语言，圆角 scale 明确分层。整体圆角比 ASCI 参考降低约 2px，保留 floating 感但避免过度“泡泡化”：

| Token | 值 | 用途 |
|-------|-----|------|
| `rounded-sm` | 4px | 微型 toolbar button、tag 矩形 |
| `rounded-md` | 6px | 默认按钮、搜索输入、view toggle |
| `rounded-lg` / `rounded-[8px]` | 8px | Header tab、reader tab、小 avatar |
| `rounded-[10px]` | 10px | sidebar row、suggestion chip、普通 list row |
| `rounded-xl` / `rounded-[12px]` | 12px | 宽松列表项、secondary action |
| `rounded-[14px]` | 14px | dropdown、SkillCard、popover 内容 |
| `rounded-[16px]` | 16px | chat bubble、空状态 icon tile |
| `rounded-[18px]` | 18px | floating workspace card、基础 GlassCard |
| `rounded-[22px]` | 22px | modal、FloatingInput full、GlassCard md |
| `rounded-[26px]` | 26px | NoteCard、compact input shell |
| `rounded-[30px]` | 30px | hero/stat 大卡片 |
| `rounded-full` | 999px | avatar、pill badge、状态点、等宽高 icon-only submit/send |

**规则：**
- 普通矩形最大 30px，不使用过大的 capsule 圆角。
- 任意圆角值必须进入本表或组件变体；禁止在业务代码里临时写 `rounded-[17px]`。
- 卡片越大，圆角越大；小控件过大圆角会显得松散。

---

## 8. 动效规范

### 8.1 原则

- **快速、克制、可预测。** 动效帮助用户理解空间变化，不展示技术。
- **一个入口动画。** 页面/卡片进入优先使用 `slideUpFade`，不要混用多套方向和曲线。
- **有物理反馈，但不夸张。** pressed 用 scale，card hover 可轻微上浮，禁止弹跳。

### 8.2 时长

| 场景 | 时长 | 示例 |
|------|------|------|
| 颜色/透明度变化 | 150-200ms | hover 背景、文字颜色 |
| Pressed scale | 150-200ms | 按钮、tab、sidebar row |
| 展开/收起 | 200-300ms | sidebar collapse、workspace panel |
| 弹层出入 | 150-200ms | dialog、dropdown、popover |
| 页面/卡片进入 | 600ms | `slideUpFade` + stagger delay |

### 8.3 使用的 transition

| Tailwind Class | 用途 |
|----------------|------|
| `transition-colors` | 纯颜色变化 |
| `transition-all duration-200` | hover + scale 组合、tab、buttons |
| `transition-opacity` | 元素淡入淡出 |
| `transition-transform` | pressed、card hover lift |
| `animate-slide-up-fade` | 页面块/卡片进入 |

**规则：** `slideUpFade` 的位移控制在 16px 以内，stagger delay 通常 40-100ms。卡片 hover 可以 `hover:-translate-y-1`，但不要同时加重 shadow。

---

## 9. 组件使用规范

### 9.1 shadcn 优先

所有 UI 组件优先使用已安装的 shadcn 组件。新增 UI 需求时：

1. 先查 shadcn 是否有对应组件 → `pnpm ui:add <component>`
2. 需要变体 → 用 CVA 在现有组件上扩展
3. 确实没有 → 自建组件，但必须遵循本规范的 token / 圆角 / 交互状态

### 9.2 按钮层级

从最强调到最弱：

| 变体 | 视觉重量 | 使用场景 |
|------|---------|----------|
| `default` / `primary` | ██████ | 页面主操作（每屏最多 1 个），黑色 CTA |
| `outline` | ████░░ | 次要操作，hairline border |
| `secondary` | ███░░░ | 辅助操作、toolbar chip、浅 hover |
| `ghost` | █░░░░░ | 图标按钮、内联操作、紧凑工具栏 |
| `destructive` | ████░░ | 删除、危险操作（红色调，仅危险语义） |
| `link` | █░░░░░ | 内联文字链接 |

**规则：** 一个视图里的 primary 按钮最多 1 个。Primary 使用 `bg-zinc-900 hover:bg-zinc-800 text-white`（dark 模式反向映射），不要给 primary 加彩色渐变。

### 9.3 Dropdown / Popover

- 内容宽度默认 `w-auto` 或按内容设定合理 min/max，避免固定 `w-52` 造成文字不可控换行。
- 菜单项统一 `text-sm`，图标 `size-4`。
- 表面使用 `bg-white` / `bg-popover` + `border-black/[0.04-0.06]` + `rounded-[14px]` 到 `rounded-[18px]`。
- 选中项通过 checkmark、左侧指示条或 `bg-active` 标记，不使用彩色背景。
- 危险操作项使用 `text-destructive`，放在最底部，上方用 hairline 或间距隔开。

### 9.4 表单输入

- 输入框统一使用 `border-input` / `border-black/[0.04-0.06]` 边框，focus 时 `border-ring` + ring。
- Label 使用 `text-sm font-medium`。
- 描述/帮助文字使用 `text-xs text-muted-foreground`。
- 错误信息使用 `text-xs text-destructive`，放在输入框正下方。
- Floating input 可以使用 `bg-white/70 backdrop-blur-3xl rounded-[26px]` + 极低透明 shadow，但仅限真正浮动的输入 dock；其 send/submit 按钮使用正圆 `rounded-full`。

### 9.5 Workbench Titlebar 与 Agent Composer

Workbench 中间内容区的 titlebar 是当前对象的操作栏，不是全局 toolbar。已有内容页的动作按稳定 slots 渲染：

- `primary`：当前内容最主要的上下文动作。允许使用带文字的小型按钮，帮助用户确认动作含义。
- `refresh`：刷新项目或当前内容读取状态，使用独立 icon button。
- `more`：低频、替代或次级动作，进入右侧更多菜单。

**规则：**

- titlebar 动作和内容区必须由同一份 active object / active tab 状态推导。不要让 titlebar 和正文各自维护临时 tab 状态，否则切换 tab 时按钮区容易出现旧动作闪回。
- titlebar 的 slot 顺序保持稳定，避免不同内容页之间按钮位置跳动。
- 已有内容的“调整 / 重写 / 修改”类动作优先 handoff 到 Agent composer：预填命令 chip 和有边界的 draft，让用户补充要求后再发送。
- 直接启动 Agent run 只用于目标明确、无需用户补充意图的流程，例如空文档生成、缺失审修、恢复写作。
- Composer chip 在视觉角色上属于输入语法提示，不是卡片或 banner。它应接近或小于输入文字尺寸；如果需要和正文输入分层，放在输入框上方的轻量区域，不占满整列，也不抢主输入区域的视觉层级。

### 9.6 Workbench 内容生命周期

Workbench 中间内容区不是普通页面容器，而是 Novel project 当前对象的状态投影。新增一级菜单、文档视图或 Agent action 时，必须先判断它属于哪一种生命周期状态，再选择对应 contract：

| 状态 | 含义 | UI Contract |
|------|------|-------------|
| `empty` | 当前对象没有可用输入或产物 | 居中空态：品牌插图或 Lucide 图标、标题、短正文、最多一个主操作；特殊双入口必须使用同一按钮尺寸 contract |
| `source-ready` | 已有用户输入源，但还没有生成结果 | 居中待处理态：来源摘要 + 主要 Agent action；删除等次要操作保持低权重 |
| `agent-running` | 当前 Agent run 的 target 匹配当前对象 | 使用统一 `WorkbenchGenerationEmptyState` 或 `WorkbenchGenerationFrame`；正文操作收起或 disabled，完成后自动刷新 |
| `document-ready` | NarraCat 已生成可阅读 Markdown | 使用 `ArtifactDocumentShell` / `ArtifactDocumentBody` 的阅读画布；不在 Markdown 外层再包 card、panel 或完成 banner |
| `stale` | 输入源晚于已生成报告 | 回到 `source-ready`，提示重新分析，不展示过期报告作为当前结果 |
| `error` | 读取或客户端操作失败 | 使用低权重内联错误；不使用 toast 代替页面内状态 |

**规则：**

- 生成类 Markdown 产物统一进入 reading canvas。正文区域不加外边框、不放品牌插图、不插入“已完成”横条。
- 空态和待处理态的 CTA 尺寸统一使用 Workbench guide action contract；同屏两个并列入口也必须保持同一尺寸。
- 完成态的低频操作进入 titlebar `more` slot。body 只承载内容本身，避免操作条压住阅读层级。
- Agent running 是页面生命周期状态，不只是按钮 loading。当前 target 命中时，空内容页显示标准 running empty state；已有内容页显示标准 running status bar。

---

### 9.7 弹窗（Dialog）容器规范

基准样板 = 新建小说弹窗（`CreateNovelDialog`）。所有内容型弹窗遵循：

- 容器：`bg-workspace p-0 overflow-hidden`（覆盖 DialogContent 默认的 `bg-floating p-6`——内部分区自管间距），宽度按内容 `sm:max-w-[560px]`（表单）到 `sm:max-w-[680px]`（含长文/清单），高度上限 `max-h-[calc(100dvh-2rem)]` 或 `-4rem`。
- 结构三段式：可见 `DialogHeader`（`border-b border-border px-6 pb-5 pt-6 text-left` + `DialogTitle` `text-lg leading-tight` + sr-only `DialogDescription`）→ 内容区（`px-6 py-5`，超长内容自滚 `min-h-0 flex-1 overflow-y-auto`）→ 如有操作按钮，底部 `border-t border-border px-6 py-4` 右对齐按钮条。
- 不要用默认 `bg-floating` + `p-6` 裸容器装成页内容——那是轻确认框的形态。
- 复用先行：同一内容组件多处弹窗承载时，容器 class 提为导出常量（例：`PACK_DETAIL_DIALOG_CONTENT_CLASS`），不要各写一套。

### 9.8 设置页二级视图导航（面包屑规范）

设置页 section 内的二级视图（详情页、指南页等）统一走这套，不要在内容区放「← 返回」按钮：

- **路由化**：二级视图状态进 URL（`/settings?section=<id>&sub=<subId>`），浏览器返回、刷新恢复天然可用。子视图参数的解析器由该 section 的面板模块导出（例：`parsePacksSubParam`）。
- **titlebar 面包屑**：二级激活时内容区 titlebar 从 `h1` 切为 `SettingsBreadcrumb`（`SettingsLayout` 导出），一级为 section 名可点返回（清 `sub` param，replace），末级为当前二级名（与 h1 同字级 `text-sm font-semibold`）。
- 层级分隔用 `ChevronRight size-3.5 text-hint-foreground`；可点级 `text-muted-foreground hover:text-foreground`。
- 后续任何 section 新增二级视图沿用本规范；三级及更深先回到设计评审（设置页原则上不该出现三级）。

## 10. 反模式清单

以下做法**禁止**出现在代码中：

| 禁止 | 原因 | 替代 |
|------|------|------|
| 硬编码彩色装饰 `text-blue-500`、`bg-purple-100` | 破坏单色系统 | 使用 zinc/token；语义色只表达状态 |
| 混用 `gray` / `slate` / 自定义 neutral hex | 中性色会漂移 | 统一使用 zinc 或 design token |
| 实心 hex 边框 `#e5e7eb` | 破坏 hairline 质感 | `border` token / `black/[0.04]` |
| 任意字号 `text-[13px]`、`text-[17px]` | 脱离 scale | 使用规范内字号或组件变体 |
| 主内容（空态标题/说明、对话正文、问题选项）写成 `text-xs` | 主信息被误读为元数据 | 使用 typography role contract（`EMPTY_*` / `AGENT_*` 常量） |
| 滥用 `font-bold` / `font-extrabold` | 信息密度失控 | `font-semibold`；bold 只给数字/hero |
| 普通文本随意 `text-xl` 以上 | 页面节奏变散 | `text-lg` 只给页面标题，峰值只给 hero/stat |
| `shadow-sm` / `shadow-md` / `shadow-lg` 到处用 | 层级变脏 | hairline + canvas；少数 floating surface 用低透明大 shadow |
| hover 时 `scale-105` | 突兀且影响布局感 | pressed 使用 `active:scale-[0.92-0.98]` |
| 多色 gradient 背景 | 装饰性，分散注意力 | zinc canvas + whisper radial glow |
| Skeleton loading | 与简洁风格不匹配 | Spinner（`Loader2Icon animate-spin`）或内联 loading 文字 |
| Toast 做操作确认 | 转瞬即逝，用户容易错过 | 内联状态文字；Sonner 只用于错误/重要提示 |
| 固定宽度 dropdown `w-52` | 文字换行不可控 | `w-auto` / `min-w-* max-w-*` |
| Header/sidebar 做不透明卡片 | 破坏 floating workspace 母题 | header/sidebar 透明，主工作区浮起 |
| 把 workspace card 铺满屏幕边缘 | 失去产品识别度 | 保留 `mt-1.5 mr-3 mb-3` gutter |
| 顶栏元素硬编码平台让位像素（`pl-[112px]`） | mac 与 Windows 让位量不同，Windows 高 DPI 下还是运行时实测值 | 消费 `--titlebar-inset-*` / `--titlebar-gutter-top`（§4.4） |
| 裸写 `pl-[var(--titlebar-inset-left)]`，不带 `max()` 保底 | 非 mac / 非 win 平台变量为 `0`，该侧 padding 直接塌掉，且开发机复现不了 | `pl-[max(1rem,calc(var(--titlebar-inset-left)+1rem))]` |
| 页面直接 import Logo 或品牌插图并散写尺寸 | 品牌资产难以治理 | 使用 `BrandMark` / `BrandLockup` / `BrandIllustration` |
| 把品牌绿用于 primary、active 或成功状态 | 混淆品牌身份和操作语义 | `brand` 只用于低频品牌细节；操作仍用 `primary` / `active` |
| 有内容的阅读态显示品牌插图 | 干扰 Markdown 阅读和小说正文 | 插图只进入缺失 / 引导态 |
| Tooltip 和 Dropdown / Popover 共享 trigger 但各自非受控 | focus return 会造成 tooltip 残留 | 由组合组件统一协调 open 状态 |
| 把 composer chip 做成整列卡片或粗重 banner | 抢走输入框主语义 | 使用轻量 chip slot，接近输入文字尺寸 |

---

## 11. 检查清单

在提交任何 UI 变更前，过一遍：

- [ ] 是否体现了 canvas + floating workspace card 的主结构？
- [ ] 所有颜色是否使用 token？有没有散落的彩色 Tailwind class？
- [ ] 语义色是否只用于状态/错误/优先级，而不是装饰？
- [ ] 字号峰值是否只出现在 hero、页面标题、关键数字等允许场景？
- [ ] 主内容文字（空态、对话正文、问题选项）是否使用 typography role contract，而不是硬写 `text-xs`？
- [ ] Agent 可读正文是否使用 Agent body contract（`text-[15px]`）？
- [ ] 是否没有在生产代码新增脱离 scale 的任意字号（如 `text-[13px]` / `text-[17px]`）？
- [ ] 字重是否控制在 `normal` / `medium` / `semibold` / 少量 `bold`？
- [ ] Header / titlebar / panel header 是否有足够上下留白，没有贴近上下 hairline？
- [ ] Hover 状态是否比 active 状态更淡？
- [ ] Active 项被 hover 时，active 样式是否仍然可辨识（不被 hover 覆盖）？
- [ ] 复合浮层是否同步了 Tooltip 与 Dropdown / Popover 状态，关闭后没有残留 tooltip？
- [ ] Pressed scale 是否按组件大小选择了 `0.92` / `0.95` / `0.97` / `0.98`？
- [ ] 图标尺寸是否与组件尺寸匹配？IconTile 是否保持单色？
- [ ] 间距是否使用 Tailwind 内置 scale（无任意值）？
- [ ] 贴近窗口顶边的元素是否按 §4.4 让位（消费 `--titlebar-*` 变量 + `max()` 保底 + 呼吸位），而不是硬编码像素？新页面是否按页面结构选对了水平让位 / 上下分区？
- [ ] 让出来的那条 caption 带**还能拖动窗口**吗（上下分区必须挂 `TitlebarDragGutter`，全屏覆盖层必须自带 drag）？落在 drag 区里的交互件是否反声明 `no-drag`？
- [ ] 圆角是否来自降低 2px 后的规范 scale 或组件变体？等宽高 submit/send 是否为正圆？
- [ ] Dark 模式下 floating card、glass、hairline 是否仍有清晰层级？
- [ ] 有没有不必要的分割线（可以用间距或 hairline 透明度替代）？
- [ ] Dropdown / Popover 是否避免固定宽度导致换行？
- [ ] Workbench titlebar 动作是否来自同一 active tab / object 状态，slot 顺序是否稳定？
- [ ] Composer chip 是否保持轻量输入语法提示，而不是整列卡片？
- [ ] 一个视图里 primary 按钮是否不超过 1 个？
- [ ] 品牌资产是否通过 `BrandMark` / `BrandLockup` / `BrandIllustration` 使用，没有散写图片尺寸？
- [ ] 品牌绿是否只低频表达产品身份，没有进入 primary、active 或状态语义？
- [ ] 品牌插图是否只出现在高价值引导空态，没有进入有内容的阅读态？

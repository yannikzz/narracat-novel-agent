/**
 * win32 顶部 caption 带的拖拽层。
 *
 * 背景：窗口是 titleBarStyle:'hidden'，「能不能拖窗口 / 双击能不能最大化」完全由页面
 * 自己声明的 -webkit-app-region:drag 决定。win32 的「上下分区」布局（globals.css 方案 A）
 * 把顶部 56px 让给 caption 带，舞台卡片从带下方开始——那条带在 DOM 里只是父容器的
 * pt padding，**padding 不带 drag 属性**，于是侧边栏 headbar 以外的整条顶栏成了死区
 * （真机走查 2026-08-30：工作台/设置页顶部拖不动、双击不最大化）。mac 上 gutter 为 0、
 * 卡片通顶，卡片自身的 h-14 header 就是 drag 区，所以这个洞只在 Windows 上暴露。
 *
 * 用法：挂在消费 --titlebar-gutter-top 的那个容器里（该容器需 relative），放最后一个子节点
 * ——同 z-auto 时后置节点在上，确保拖拽层不被前面的兄弟盖住。
 * 非 win32 平台 --titlebar-gutter-top 为 0px，本层高度归零，等同不存在。
 */
export function TitlebarDragGutter() {
  return (
    <div
      aria-hidden="true"
      data-titlebar-drag-gutter="true"
      className="absolute inset-x-0 top-0 h-[var(--titlebar-gutter-top)] [-webkit-app-region:drag]"
    />
  )
}

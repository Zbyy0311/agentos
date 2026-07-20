# 明暗模式选择持久化设计

## 目标

记住用户在 AgentOS 中选择的明亮或深色模式，用户再次打开页面时恢复上次选择，而不是每次先使用深色模式。

## 范围

- 使用浏览器 `localStorage` 保存主题选择。
- 保存键固定为 `agentos-theme`。
- 只接受 `light` 和 `dark`；缺失或非法值回退到 `dark`。
- 不做账号同步、跨设备同步或服务端存储。

## 方案

在页面绘制前通过布局中的内联脚本读取 `localStorage`，同步设置 `document.documentElement.dataset.theme`，确保首屏直接使用用户选择的模式。`ThemeProvider` 再通过 `useState` 惰性初始化读取同一值，避免 React 状态与首屏属性不一致。服务端渲染时默认深色；主题变化时继续通过现有副作用设置属性并写回 `localStorage`。

## 验证

- 无保存值时初始化为 `dark`。
- 保存 `light` 时初始化为 `light`。
- 非法保存值时初始化为 `dark`。
- 现有 Web 构建命令通过。

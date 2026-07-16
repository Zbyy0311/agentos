# 明暗模式选择持久化设计

## 目标

记住用户在 AgentOS 中选择的明亮或深色模式，用户再次打开页面时恢复上次选择，而不是每次先使用深色模式。

## 范围

- 使用浏览器 `localStorage` 保存主题选择。
- 保存键固定为 `agentos-theme`。
- 只接受 `light` 和 `dark`；缺失或非法值回退到 `dark`。
- 不做账号同步、跨设备同步或服务端存储。

## 方案

在 `ThemeProvider` 的 `useState` 惰性初始化函数中读取 `localStorage`。服务端渲染时检测 `window` 是否存在，避免访问浏览器 API；客户端首次初始化即可使用已保存主题，避免先渲染深色再切换。主题变化时继续通过现有副作用设置 `document.documentElement.dataset.theme` 并写回 `localStorage`。

## 验证

- 无保存值时初始化为 `dark`。
- 保存 `light` 时初始化为 `light`。
- 非法保存值时初始化为 `dark`。
- 现有 Web 构建命令通过。

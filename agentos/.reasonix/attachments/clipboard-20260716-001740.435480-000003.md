# AgentOS UI 反馈状态设计（修正版）

## 背景

工作区当前只有单个 `actionNotice`，固定显示在页面底部中央；错误主要通过单个 `error` 文本展示；发送按钮只根据输入内容和附件是否为空决定禁用状态。需要在不改变现有“运行中可继续排队发送”的行为下，补充明确的 loading、Toast 和错误反馈。

## 目标

1. 发送按钮使用 `canSendMessage(draft, attachments)` 作为唯一禁用条件。
2. 运行中仍允许带内容的消息进入队列；发送按钮显示 loading spinner，但不因此变为不可点击。
3. Toast 改为页面级右下角堆叠，可同时显示多条，并自动消失。
4. 将错误分为连接错误、执行错误和验证错误，分别使用内联提示、浮层 Toast 和字段级提示。
5. 保持现有组件边界和视觉变量，不引入第三方通知依赖。

## 方案

### 发送按钮

`ChatPanel` 计算 `canSend = canSendMessage(draft, attachments)`，发送按钮使用 `disabled={!canSend}`。`sending` 不会改变按钮的可点击性：当输入框有内容时，点击仍调用现有入队逻辑。

按钮状态拆成两个独立维度：

- `!canSend`：真正禁用，降低 opacity，并显示 `cursor-not-allowed`。
- `sending`：显示 spinner、设置 `aria-busy="true"`，但保留正常 opacity 和可点击光标，以免把“可加入队列”误导成不可操作。

运行中按钮的 `aria-label` 或辅助文本应明确表达“加入队列”，空输入时才表达禁用状态。

### 页面级 Toast 堆叠

工作区页面将 `actionNotice: string` 替换为 `ToastItem[]`，每个条目包含唯一 id、级别、消息和短暂生命周期。页面提供局部 `pushToast`/`dismissToast` 行为，并在工作区根布局中渲染独立的 `ToastStack`。

`ToastStack` 不作为 `ChatPanel` 的子职责，也不通过 `toasts` prop 传入 `ChatPanel`。它使用 fixed 定位放在右下角，沿垂直方向堆叠；成功、警告和错误沿用现有 CSS 变量。条目在自动移除前执行纯 CSS 退出动画，避免突然消失。

执行失败、保存失败、删除失败等操作错误进入错误 Toast；原有成功操作提示进入成功 Toast。Toast 不阻塞输入和对话滚动。

### 错误分级

页面保留连接状态作为 `connectionNotice`，连接断开、重连中和重连失败以内联方式显示在对话流中。

执行阶段的异常通过错误 Toast 展示，不再只依赖对话区底部的单文本错误。取消执行属于用户动作，不产生错误 Toast。

验证错误新增独立的 `validationError`，放在 composer 输入区域下方并使用 `role="alert"`。空消息、无效附件或发送条件不满足时显示字段级提示；已有 `attachmentError` 继续保持字段级显示。

错误分类集中在页面的错误处理辅助函数中，组件只接收已分类的内联展示数据。Toast 的生命周期和渲染完全由页面级 `ToastStack` 管理。

## 组件接口变化

- `ChatPanel` 增加 `validationError`，并接收发送按钮所需的 `canSend`/`sending` 状态。
- `ChatPanel` 保留 `connectionNotice`，不接收 `toasts` 或 Toast 生命周期回调。
- 页面负责 Toast 状态、`ToastStack` 渲染和错误分类；`ChatPanel` 负责输入框、按钮和内联提示渲染。

## 验收标准

- 空消息且无附件时发送按钮真正禁用，出现低透明度和禁止光标。
- 运行中输入补充消息时，发送按钮仍可点击并将消息加入队列；按钮显示 spinner、`aria-busy`，不显示禁止光标。
- 连续触发多条操作提示时，Toast 在右下角按顺序堆叠，分别自动消失且有退出动画。
- 连接中断只显示对话内联连接提示；执行失败显示错误 Toast；输入/附件验证失败显示 composer 字段提示。
- 用户取消运行不产生错误 Toast。
- 现有图片附件、队列、自动重连和工作区布局行为不回归。

## 验证策略

- 为 Toast 生命周期、错误分类和发送按钮状态添加纯函数测试。
- 运行现有前端辅助测试和生产构建。
- 使用浏览器检查发送按钮 loading/禁用态、右下角多 Toast 堆叠和 composer 字段错误布局。

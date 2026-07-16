# Signal Studio UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** 在不改变 AgentOS 业务逻辑的前提下，将首页和工作区主界面实现为已确认的 Signal Studio 视觉系统，并完成桌面/移动端 Browser 验证。

**Architecture:** 沿用现有 Next.js App Router、Tailwind utility class 和 `globals.css` token 层。首页只调整布局与工作区呈现组件；工作区只调整四栏组件的表面、间距、状态线和响应式 class，不新增状态管理或依赖。动效全部由 CSS token、pseudo-element 和现有状态 class 驱动。

**Tech Stack:** Next.js 14、React 18、TypeScript、Tailwind CSS、CSS custom properties、Codex Browser。

## Global Constraints

- 不修改 API、服务端、共享类型、Agent 执行逻辑和现有交互状态模型。
- 不新增依赖，不引入新的 UI 框架或动画库。
- 保留主题持久化、工作区动态面板宽度、会话选择、消息发送、附件、运行取消、执行详情、记忆面板和 toast 行为。
- 不触碰当前工作树中与本次 UI 无关的用户改动。
- 保持 `prefers-reduced-motion: reduce` 下无非必要动画。

---

### Task 1: 建立 UI 验证基线与实现前失败断言

**Files:**
- Read: `apps/web/src/app/page.tsx`
- Read: `apps/web/src/app/workspace/[id]/page.tsx`
- Read: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: 现有首页 `/`、工作区 `/workspace/d7994c0c` 和当前 Browser 会话。
- Produces: 一组可重复的 Browser DOM/screenshot 检查，用来证明新结构在实现前尚不存在，并记录现状 baseline。

- [ ] **Step 1: 运行 Browser 基线检查**

目标流：`/` → 首页渲染 → 主题按钮可见；`/workspace/d7994c0c` → 工作区渲染 → Agent、会话、消息输入框和执行检查器可见。

- [ ] **Step 2: 运行实现前失败断言**

使用 Browser DOM 检查以下新结构标记存在：

```js
const snapshot = await tab.playwright.domSnapshot();
if (!snapshot.includes('data-signal-home')) throw new Error('缺少 data-signal-home');
if (!snapshot.includes('data-signal-workspace')) throw new Error('缺少 data-signal-workspace');
```

预期：断言失败，说明新结构尚未实现；实现后同一断言必须转为通过。

---

### Task 2: 重建共享 Signal Studio token 与基础表面

**Files:**
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: 现有 `--app-*` token、`.ui-*` 基础 class、现有断点和 reduced-motion 规则。
- Produces: 首页/工作区共用的背景、网格、surface、selected、timeline、focus 和 motion class。

- [ ] **Step 1: 写入基础 token 与状态样式**

在现有 token 旁补充 Signal Studio 所需的 surface 层、细网格背景、焦点环和状态动效；不删除现有 token，确保未改动组件继续可用。

- [ ] **Step 2: 保持主题和可访问性规则**

为 `html[data-theme='light']` 提供对应 token，复用现有 `focus-visible` 与 `prefers-reduced-motion` 规则；避免使用新的第三方字体或动画库。

- [ ] **Step 3: 运行 web TypeScript/build 检查**

运行：`pnpm --filter @agentos/web run build`

预期：命令退出码为 0。

---

### Task 3: 实现首页 Signal Studio 布局

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/components/workspace/WorkspaceList.tsx`

**Interfaces:**
- Consumes: `useWorkspace()` 返回的 `workspaces/loading/error/create/import/remove`，`ThemeToggle` 和 `NewWorkspaceModal`。
- Produces: 带 `data-signal-home` 标记的首页结构；新建、导入、打开、删除、主题切换保持原有 handler 和数据流。

- [ ] **Step 1: 调整首页分栏和主要操作层级**

保留现有中文文案意图，把首屏改成主标题/说明与新建按钮的分栏布局；工作区列表与导入目录形成主次明确的操作区。

- [ ] **Step 2: 调整工作区列表和空/加载/错误状态**

保留工作区字段和回调，只改变容器、列表项边界、hover、状态 badge 和空状态表达；删除操作继续阻止冒泡。

- [ ] **Step 3: 运行首页 Browser 检查**

检查页面身份、非空渲染、`data-signal-home`、主题按钮、导入输入框和新建按钮；截图记录首页视觉结果。

---

### Task 4: 实现工作区三栏 Signal Studio 表面与状态轨道

**Files:**
- Modify: `apps/web/src/components/layout/WorkspaceLayout.tsx`
- Modify: `apps/web/src/components/chat/AgentList.tsx`
- Modify: `apps/web/src/components/chat/ConversationHistory.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Modify: `apps/web/src/components/chat/ExecutionInspector.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

**Interfaces:**
- Consumes: 现有组件 props、动态面板宽度、Agent/会话/执行状态、composer callback 和 Browser DOM contract。
- Produces: 带 `data-signal-workspace` 标记的工作区结构；不改变任何业务 handler 或数据请求。

- [ ] **Step 1: 调整工作区根布局和 rail 边界**

保留 `AgentList`、`ConversationHistory`、`ChatPanel`、`ExecutionInspector` 顺序和 resize handle，只调整背景、边界、内边距、selected 状态和断点 class。

- [ ] **Step 2: 调整 Agent/会话导航层级**

保留所有按钮回调、context menu 和主题切换；使用轻量状态线、低亮背景、统一列表行高和可聚焦样式。

- [ ] **Step 3: 调整 ChatPanel 主内容与 composer**

保留消息、附件、模型、思考强度、发送/取消和连接状态逻辑；只调整顶部状态、消息留白、composer surface、按钮尺寸和 loading/streaming 反馈。

- [ ] **Step 4: 调整 ExecutionInspector 时间线**

保留权限、状态标签、事件顺序、耗时和执行详情回调；强化节点/连接线/当前状态的语义样式，并确保长内容仍可滚动。

- [ ] **Step 5: 在工作区页面挂载 data contract**

在已有根容器上加入 `data-signal-workspace`，不引入新的 React state 或 effect。

- [ ] **Step 6: 运行工作区 Browser 检查**

检查 Agent 选择、会话选择、消息输入框、执行检查器和 `data-signal-workspace`；截图记录桌面视觉结果。

---

### Task 5: 桌面/移动端交互回归与修复

**Files:**
- Modify: 仅修复前述 UI 文件中验证发现的问题。

**Interfaces:**
- Consumes: 首页和工作区 Browser 检查结果。
- Produces: 1280px 左右桌面视图和 390px 左右移动视图均无横向溢出、遮挡或不可用入口。

- [ ] **Step 1: 检查桌面首屏和工作区**

验证首页主操作层级、工作区主会话焦点、右侧时间线可扫描性和控制台日志。

- [ ] **Step 2: 检查移动视图**

使用 Browser viewport 覆盖约 390px 宽度，验证 Agent 入口、当前会话、composer 和主题切换仍可用；确认 history/inspector 的隐藏策略无溢出。

- [ ] **Step 3: 验证主题切换**

点击首页或工作区的主题按钮，确认 `data-theme` 在 dark/light 间变化且 UI 仍可读；刷新后确认持久化行为未回归。

- [ ] **Step 4: 运行完整验证**

运行：

```powershell
pnpm --filter @agentos/web run build
pnpm --filter @agentos/agent-core run test:smoke
```

预期：两个命令都退出码为 0；Browser 页面无新的 console error/warn。

---

## Self-review checklist

- Spec coverage: 视觉 token、首页层级、工作区四栏、响应式、主题、核心交互和构建验证均有对应任务。
- Placeholder scan: 本计划无 TBD、TODO、占位步骤；每个代码任务都指向真实文件和现有接口。
- Type consistency: 只复用现有 props 和 callback；`data-signal-home`/`data-signal-workspace` 是 DOM contract，不改变 TypeScript 类型。

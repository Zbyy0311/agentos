# AgentOS Composer UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AgentOS 在单聊发送栏旁即时选择模型和思考强度，并确保选择值真实进入本次 CLI 执行；同时将对话区调整为接近 Codex 的深色 Composer 体验。

**Architecture:** 前端由 `WorkspacePage` 持有当前发送设置，`ChatPanel` 只渲染控件并通过回调更新；SSE 请求携带可选覆盖值，服务端基于当前 Agent 的动态 capability 校验后传给 `ConversationAgentRunner`。Agent profile 的默认设置仍由 Agent 编辑器管理，群聊不接受全局覆盖。

**Tech Stack:** Next.js/React、Tailwind CSS、Express、TypeScript、Vitest、现有 `@agentos/shared`/`@agentos/agent-core`。

## Global Constraints

- 单聊选择只影响当前消息，不写回 Agent 默认配置。
- 群聊沿用每个成员的模型和思考强度，Composer 只读展示“按成员配置”。
- 只允许 `auto | low | medium | high`，且必须符合当前模型 capability。
- 模型优先使用动态发现列表，无发现结果时使用 fallback；不凭空制造模型 ID。
- 保留现有三栏工作区和右侧执行检查器，不删除既有执行状态、权限和会话能力。
- 中文文案必须保存为真实 UTF-8，不能新增乱码文本。

## 文件边界

- Modify: `apps/server/src/routes/conversations.ts` — 解析 SSE 覆盖值、按 Agent capability 校验、向 ConversationService 传值。
- Modify: `apps/server/src/services/ConversationService.ts` — 为单聊运行接收本次覆盖值，群聊不使用覆盖值。
- Modify: `apps/server/src/services/ConversationService.test.ts` — 覆盖值传递和群聊隔离测试。
- Modify: `packages/agent-core/src/conversationRunner.ts` — 接收运行时模型/思考强度覆盖。
- Modify: `packages/agent-core/src/conversationRunner.test.ts` — 验证 runner 生成的执行配置使用覆盖值。
- Create: `apps/web/src/components/chat/ComposerControls.tsx` — 模型、思考强度和群聊只读状态控件。
- Create: `apps/web/src/lib/composerSettings.ts` — 前端模型选项、思考选项和默认值归一化纯函数。
- Create: `apps/web/src/lib/composerSettings.test.ts` — 前端选择归一化测试。
- Modify: `apps/web/src/components/chat/ChatPanel.tsx` — Codex 风格底部 Composer、消息空状态、键盘行为和 clean UTF-8 文案。
- Modify: `apps/web/src/components/chat/ExecutionInspector.tsx` — 统一状态面板间距、颜色和 clean UTF-8 文案。
- Modify: `apps/web/src/app/workspace/[id]/page.tsx` — 持有 Composer 状态、切换 Agent 时重置、请求发送覆盖值。
- Modify: `apps/web/src/app/globals.css` — 全局滚动条、背景和表单 focus token。

## Task 1: 运行时覆盖的失败测试

**Files:**

- Test: `packages/agent-core/src/conversationRunner.test.ts`
- Test: `apps/server/src/services/ConversationService.test.ts`
- Test: `apps/web/src/lib/composerSettings.test.ts`

**Interfaces:**

- `ConversationAgentRunnerOptions.runtimeOverrides?: { model?: string; thinkingEffort?: ThinkingEffort }`
- `SendDirectMessageInput.runtimeOverrides?: { model?: string; thinkingEffort?: ThinkingEffort }`
- `getModelOptions(agent)`, `getThinkingEfforts(agent, model)`, `getInitialComposerSettings(agent)`。

- [ ] **Step 1: Add an agent-core test that fails before runtime override support**

在 `conversationRunner.test.ts` 增加一个可观察的 CLI 执行断言：传入 profile 默认模型 `profile-model`、默认思考强度 `low`，同时传入 `runtimeOverrides: { model: 'turn-model', thinkingEffort: 'high' }`；测试 fake CLI 输出收到 `turn-model` 和 `high`，而不是 profile 默认值。

- [ ] **Step 2: Run the focused agent-core test and confirm the expected failure**

Run: `pnpm --filter @agentos/agent-core test -- conversationRunner.test.ts`

Expected: FAIL because `ConversationAgentRunnerOptions` 尚未接受或使用 `runtimeOverrides`。

- [ ] **Step 3: Add server tests for direct override and group isolation**

在 `ConversationService.test.ts` 中增加：

1. direct message 传入 `runtimeOverrides` 时，fake CLI 输出收到覆盖模型和思考强度；
2. group message 即便 input 对象包含同名字段，每个成员仍使用 profile 自己的模型/思考强度。

- [ ] **Step 4: Add pure frontend settings tests**

覆盖以下行为：动态 `modelOptions` 优先于旧 `models`；切换到只支持 `auto` 的模型会把 `high` 归一化为 `auto`；没有 profile 模型时初始 Composer 不写入自定义模型；未知思考值回退到模型默认值。

- [ ] **Step 5: Run the new frontend test and confirm it fails for missing helpers**

Run: `pnpm --filter @agentos/web test -- composerSettings.test.ts`

Expected: FAIL because `composerSettings.ts` 尚不存在。

## Task 2: 实现服务端运行时覆盖

**Files:**

- Modify: `packages/agent-core/src/conversationRunner.ts`
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/routes/conversations.ts`

**Interfaces:**

- Runner 用 `runtimeOverrides` 生成临时 `AgentConfig`，不改变传入的 profile 对象。
- 路由 direct SSE body 接收 `model?: unknown`、`thinkingEffort?: unknown`。
- 路由使用现有 `withCapability(agent, modelDiscovery)` 结果验证模型和模型级思考强度。

- [ ] **Step 1: Implement the minimal runner override path**

将 `toAgentConfig(agent)` 改为 `toAgentConfig(agent, runtimeOverrides)`，使用 `runtimeOverrides.model ?? agent.model` 和 `runtimeOverrides.thinkingEffort ?? agent.thinkingEffort ?? 'auto'`，其余权限沙箱处理保持不变。

- [ ] **Step 2: Run the focused agent-core test and verify it passes**

Run: `pnpm --filter @agentos/agent-core test -- conversationRunner.test.ts`

Expected: new override test and existing conversation runner tests PASS。

- [ ] **Step 3: Thread overrides through ConversationService direct execution**

扩展 `SendDirectMessageInput`，并把 `runtimeOverrides` 传给 `ConversationAgentRunner`；不要把它写入 Store，也不要把它用于 group turns。

- [ ] **Step 4: Add route-level validation helpers**

新增小型纯函数或路由内函数：

```ts
function parseRuntimeOverrides(body: Record<string, unknown>): RuntimeOverrides
function validateRuntimeOverrides(agent: AgentProfile & { capability: AgentCapability }, overrides: RuntimeOverrides): void
```

规则：空模型视为未覆盖；非空模型必须命中 `capability.modelOptions`/fallback；思考强度必须命中所选模型的 `thinkingEfforts`；非法值返回 400。

- [ ] **Step 5: Pass only validated direct overrides and explicitly omit group overrides**

direct 分支在调用 `sendDirectMessage` 前读取并校验；group 分支不读取覆盖字段，按已有 profile 执行。

- [ ] **Step 6: Run server focused tests and full server tests**

Run: `pnpm --filter @agentos/server test -- ConversationService.test.ts conversations.test.ts modelDiscovery.test.ts`

Expected: focused tests PASS；随后 `pnpm --filter @agentos/server test` PASS，且失败响应不会产生 execution 记录。

## Task 3: 实现前端 Composer 状态和控件

**Files:**

- Create: `apps/web/src/lib/composerSettings.ts`
- Create: `apps/web/src/lib/composerSettings.test.ts`
- Create: `apps/web/src/components/chat/ComposerControls.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

**Interfaces:**

- `ComposerControls` 接收 `isGroup`、`modelOptions`、`model`、`thinkingEffort`、`thinkingEfforts`、`disabled` 和两个 change callback。
- `WorkspacePage` 的 `handleSend` 将 direct body 发送为 `{ content, model?, thinkingEffort }`；group body 只发送 `{ content }`。

- [ ] **Step 1: Implement and pass pure composer settings tests**

用 `AgentProfile` capability 生成模型选项；选择新模型时保留原思考强度仅在支持时，否则回退该模型的 `defaultThinkingEffort`，再运行 `pnpm --filter @agentos/web test -- composerSettings.test.ts`。

- [ ] **Step 2: Build `ComposerControls` with native accessible controls**

使用 `<label>`、`<select>` 和显式 `aria-label`，模型显示 label/id，思考显示中文 label；群聊使用 disabled select 或只读 badge，文案为“按成员配置”。

- [ ] **Step 3: Add page state initialized from selected Agent**

进入 Agent、切换 Agent、加载动态 capability 后重置 Composer；模型变化时同步归一化思考强度。不要调用保存 Agent 的 PATCH。

- [ ] **Step 4: Pass controls into ChatPanel and request body**

将 Composer props 传入 `ChatPanel`，发送时只在 direct conversation 添加覆盖值；请求错误时恢复 draft 的现有行为不变。

- [ ] **Step 5: Run web unit tests and typecheck**

Run: `pnpm --filter @agentos/web test -- composerSettings.test.ts` and `pnpm --filter @agentos/web exec tsc --noEmit`

Expected: PASS with no TypeScript errors。

## Task 4: Codex 风格视觉重做

**Files:**

- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Modify: `apps/web/src/components/chat/ExecutionInspector.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**

- 不改变现有消息、SSE、取消、重命名回调名称。
- Composer 仍支持 Enter 发送和 Shift+Enter 换行。

- [ ] **Step 1: Rewrite only the affected JSX/styles with clean UTF-8 copy**

Composer 使用 `rounded-2xl`、低对比度边框、底部工具栏、圆形发送按钮；消息区域在宽屏使用 `max-w-3xl`，空状态、加载、错误状态分别可见。

- [ ] **Step 2: Rebalance three-column widths and inspector hierarchy**

仅调整现有 layout class：主对话区保持 `min-w-0 flex-1`，左右面板使用固定窄宽度和弱边界；执行时间线和权限块保留原数据。

- [ ] **Step 3: Run web build**

Run: `pnpm --filter @agentos/web build`

Expected: Next.js production build exits 0。

## Task 5: 集成回归与验收

**Files:**

- Modify: `docs/superpowers/specs/2026-07-13-agentos-composer-ui-design.md` only if the verified behavior differs from the design.

- [ ] **Step 1: Run all package tests**

Run: `pnpm --filter @agentos/agent-core test` and `pnpm --filter @agentos/server test`。

Expected: 现有与新增测试全部通过。

- [ ] **Step 2: Run repository build**

Run: `pnpm -r run build`

Expected: shared、agent-core、web、server 全部 build 成功。

- [ ] **Step 3: Verify API behavior with mock execution**

以 `AGENTOS_FORCE_MOCK=true` 启动 server，创建 direct conversation，发送不同模型/思考强度；检查响应成功、execution 创建、Agent profile 未变化。发送非法模型和不支持思考强度，检查 HTTP 400 且无新增 execution。

- [ ] **Step 4: Verify UI manually or with browser automation**

检查 1440px 和 960px 宽度：模型/思考控件在发送按钮左侧可见；切换模型同步思考选项；群聊显示只读状态；发送后控件仍保留；执行中控件禁用。若 Browser 插件和 Playwright 均不可用，记录具体缺失依赖，不把“构建通过”表述为视觉验收通过。

- [ ] **Step 5: Inspect diff and report changed files**

Run: `git -c safe.directory=E:/workspace/Multi-Agent diff --check` and `git -c safe.directory=E:/workspace/Multi-Agent status --short`。

Expected: 本次改动无 whitespace 错误；报告区分本次改动和工作区已有未提交改动。

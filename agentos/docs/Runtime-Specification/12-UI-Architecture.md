# AgentOS Runtime Specification v2.0

## 12 — UI Architecture

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Web-first, Desktop-ready User Interface Architecture  
> Depends On:
> - `00-Vision.md`
> - `01-Core-Concepts.md`
> - `02-Runtime-Lifecycle.md`
> - `03-Event-Model.md`
> - `04-Provider-Specification.md`
> - `05-Process-Runtime.md`
> - `06-Worktree-Runtime.md`
> - `07-Memory-Runtime.md`
> - `08-Policy-Runtime.md`
> - `09-Conversation-Runtime.md`
> - `10-Data-Model.md`
> - `11-API-Specification.md`
> Design Reference:
> - Emil Kowalski, `emilkowalski/skills`, `skills/apple-design/SKILL.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的 UI Architecture。

它将 AgentOS 的 Runtime、Conversation、Task、Run、Provider、Process、Worktree、Memory、Policy、Approval 和 Artifact 能力映射为统一的前端信息架构、设计系统、交互模型、实时数据模型和平台适配边界。

本文件规定：

- UI 产品定位；
- Web-first 与 Desktop-ready 架构；
- Apple Design Engineering 原则；
- App Shell；
- Information Architecture；
- Navigation；
- Conversation Workspace；
- Task / Run Workbench；
- Runtime Inspector；
- Agent History；
- Provider Settings；
- Memory UI；
- Policy / Approval UI；
- Artifact UI；
- Design Token；
- Typography；
- Color；
- Material；
- Layout；
- Motion；
- Gesture；
- Streaming；
- Accessibility；
- Responsive；
- Client State；
- Server State；
- Realtime；
- API Client；
- Platform Adapter；
- Browser Adapter；
- Future Tauri Adapter；
- Performance；
- Security；
- Testing；
- v1 UI Migration；
- 00–11 文档一致性调整。

本文件的目标是确保：

> AgentOS 的界面不是 Runtime 数据的简单可视化，而是一个让用户始终理解系统状态、保有控制权、能够安全管理多个 AI Agent 的工程工作台。

---

## 2. Final Architecture Decision

AgentOS v2 第一阶段采用：

```text
Web-first
+ Desktop-ready
+ Apple Design Engineering
+ Runtime-driven UI
```

具体含义：

```text
Current Product:
  Web UI
  + Independent AgentOS Server
  + REST
  + SSE
  + WebSocket
  + SQLite

Future Desktop Product:
  Tauri Shell
  + Reused Web UI
  + AgentOS Server Sidecar
  + Native Platform Adapter
```

### 2.1 Current Implementation Boundary

当前先完成：

- Web App Shell；
- Conversation；
- Agent Management；
- Task / Run Workbench；
- Runtime Inspector；
- Memory；
- Policy / Approval；
- Provider Settings；
- Artifact Viewer；
- Settings；
- Realtime Recovery。

当前不要求：

- Tauri 工程；
- Rust Runtime 重写；
- Sidecar 打包；
- 系统托盘；
- 自动更新；
- 原生通知；
- Tauri Capability；
- 多平台安装包。

### 2.2 Future Tauri Migration

后续移植 Tauri 时，主要增加：

```text
Desktop Host
├── Window Lifecycle
├── Native Menu
├── Tray
├── File Dialog
├── Open / Reveal
├── Native Notification
├── Global Shortcut
├── Auto Update
└── Sidecar Lifecycle
```

以下内容必须直接复用：

- UI 页面；
- Design System；
- Domain Components；
- API Client；
- REST Contract；
- SSE；
- WebSocket；
- Runtime State Model；
- Conversation State；
- Task / Run Workflow；
- Approval UI；
- Inspector；
- Error Model。

---

## 3. Product Positioning

AgentOS UI 的产品定位是：

> 面向长期 AI Coding Agent 团队的本地工程控制台和协作工作台。

它不是：

- 普通聊天机器人；
- 多个 CLI 窗口的拼接；
- 单次 Prompt 表单；
- Provider 官网的聚合入口；
- Apple 官网式产品宣传页面；
- 全屏 Dashboard；
- 纯日志查看器；
- macOS 界面的像素级仿制品。

它应让用户感受到：

```text
Calm
Controlled
Continuous
Precise
Responsive
Trustworthy
```

---

## 4. Apple Design Engineering Reference

本文件借鉴 Emil Kowalski `apple-design` Skill 中总结的 Apple Web Interface 原则。

核心不是：

```text
white
rounded
blur
```

而是：

```text
Immediate Response
Direct Manipulation
Interruptibility
Velocity Continuity
Momentum
Spatial Consistency
Soft Boundaries
Material Hierarchy
Restraint
Accessibility
```

### 4.1 Reference Scope

该 Skill 用于指导：

- 交互反馈；
- 面板运动；
- Drag / Resize；
- Sheet；
- Popover；
- Sidebar；
- Inspector；
- Spring；
- Reduced Motion；
- Typography；
- Material；
- Motion Performance。

### 4.2 No Visual Copying

AgentOS 不复制：

- Apple Logo；
- SF Symbols 作为跨平台唯一图标；
- macOS Window Chrome；
- Apple 专有组件外观；
- Apple 官网布局；
- Apple 产品营销语言。

采用的是设计原则，而不是品牌模仿。

---

# Part I — Product Design Principles

## 5. Purpose

每个 UI 元素必须支持以下至少一个目的：

- 理解当前状态；
- 发起任务；
- 控制执行；
- 处理风险；
- 查看结果；
- 管理 Agent；
- 恢复错误；
- 查找历史。

无法说明目的的装饰应移除。

---

## 6. Agency

用户必须始终能够理解：

- Agent 正在做什么；
- 哪个 Provider 在运行；
- 哪个 Stage 正在执行；
- 是否正在修改文件；
- 是否等待审批；
- 是否可以暂停；
- 是否可以取消；
- 是否可以恢复；
- 是否可以撤销或重试。

### 6.1 No Hidden Autonomy

修改型 Action 不能只显示：

```text
Agent is working...
```

必须逐步展示：

- Planning；
- Tool；
- Command；
- File Change；
- Test；
- Review；
- Approval；
- Result。

### 6.2 Control Availability

Run 运行期间，核心控制不能被动画或 Loading Overlay 阻塞。

---

## 7. Responsibility

AI 输出和 Runtime Action 可能有风险。

界面必须：

- 明确标记 Agent Output；
- 明确标记 Runtime Fact；
- 明确标记 User Decision；
- 对高风险操作展示真实目标；
- 对 Approval 展示范围；
- 对 Secret 只展示 Reference；
- 对外部上传展示目的地；
- 对 Merge 展示 Target Branch；
- 对 Force 操作进行二次确认。

---

## 8. Familiarity

AgentOS 使用用户熟悉的生产力应用模式：

- Sidebar；
- List；
- Detail；
- Inspector；
- Toolbar；
- Search；
- Command Palette；
- Context Menu；
- Tab；
- Split View；
- Status Indicator。

同类操作必须保持：

- 相同图标语义；
- 相同位置；
- 相同文案；
- 相同风险颜色；
- 相同快捷键模式。

---

## 9. Flexibility

界面必须支持：

- 不同窗口宽度；
- 不同信息密度；
- Light / Dark / System；
- Reduced Motion；
- Reduced Transparency；
- More Contrast；
- Keyboard；
- Pointer；
- Touch-ready；
- Web；
- Future Tauri。

高级用户可以：

- 调整 Sidebar；
- 调整 Inspector；
- 保存 View；
- 选择默认面板；
- 设置 Density；
- 设置通知；
- 设置 Runtime Detail Level。

---

## 10. Simplicity, Not Minimalism

AgentOS 信息复杂，不能通过隐藏一切制造“极简”。

应采用：

```text
Common path first
Advanced detail one level deeper
Runtime detail progressively disclosed
```

示例：

```text
Conversation Message
  ↓
Run Card Summary
  ↓
Expanded Tool Timeline
  ↓
Full Runtime Inspector
  ↓
Raw Artifact
```

---

## 11. Craft

所有视觉与交互必须由 Token 驱动：

- Spacing；
- Radius；
- Color；
- Typography；
- Shadow；
- Material；
- Motion；
- Z-index；
- Focus；
- Density。

禁止组件各自随意设置：

```text
13px
17px
0.23s
border-radius: 19px
```

---

## 12. Delight

Delight 来自：

- 即时反馈；
- 连续运动；
- 清晰状态；
- 精确布局；
- 可恢复错误；
- 不丢历史；
- 操作可预测；
- 细节一致。

不依赖：

- 彩纸动画；
- 大量光效；
- 无意义弹跳；
- 持续背景运动；
- 过度毛玻璃；
- 夸张音效。

---

# Part II — Architectural Boundaries

## 13. UI Is a Client of Runtime

```text
UI
  ↓
API Client
  ↓
REST / SSE / WebSocket
  ↓
AgentOS Server
```

UI 不直接：

- Spawn CLI；
- 调用 `child_process`；
- 执行 Git；
- 读取 SQLite；
- 创建 Worktree；
- 读取 Provider Credential；
- 读取本地 Provider 历史目录；
- 推断 Run Terminal State。

---

## 14. Server Owns Runtime

```text
Server owns:
  Task
  Run
  Stage
  Provider Session
  Process
  Worktree
  Approval
  Runtime Event

Client owns:
  View State
  Selection
  Panel Layout
  Draft
  Focus
  Scroll
```

### 14.1 Browser Disconnect

```text
Browser disconnect
  ↓
subscription ends
  ↓
Run continues
  ↓
client reconnects
  ↓
REST state + sequence replay
```

---

## 15. UI Is Not Source of Truth

UI 可以 Optimistic Update：

- Rename Conversation；
- Pin；
- Mark Read；
- Toggle Panel。

UI 不得 Optimistic Finalize：

- Run Completed；
- Merge Completed；
- Approval Granted；
- Process Exited；
- Worktree Deleted。

这些必须等待 Server Fact。

---

## 16. Projection Boundary

UI 展示三种数据：

### Resource State

```text
GET /api/runs/:id
```

### Runtime History

```text
GET /api/runs/:id/events
```

### User-facing Projection

```text
Conversation Message
Run Card
Approval Card
Artifact Card
```

不得把 Projection 当作 Runtime 真相。

---

## 17. Frontend Framework Contract

AgentOS 当前 Next.js 前端可以保留，但必须满足 Tauri-ready 约束：

- 业务运行逻辑全部在 AgentOS Server；
- 不依赖 Next.js API Route 承载 Runtime；
- 不依赖 Server Action 执行 Runtime Action；
- 不依赖 SSR 才能展示核心 Workspace；
- 页面可静态或 Client-side 渲染；
- Route 可以在静态 Host 中恢复；
- 构建结果可以适配 Tauri WebView；
- API Base URL 可配置；
- Browser History 和 Deep Link 有统一处理。

### 17.1 Recommended Direction

```text
Existing Next.js UI
  ↓
Client-heavy application shell
  ↓
Static-export-compatible where practical
  ↓
Independent AgentOS Server
```

无需为了 Tauri 立即重写成 Vite。

如果未来发现 Next.js 仅承担 SPA 功能，可以单独评估是否迁移 Vite；该迁移不是 Tauri 前置条件。

---

## 18. Package Boundaries

```text
apps/
├── web/
│   └── current web application
├── server/
│   └── AgentOS Runtime API
└── desktop/                  # future
    └── Tauri host

packages/
├── ui/
│   ├── tokens
│   ├── primitives
│   ├── patterns
│   └── domain-components
├── api-client/
│   ├── rest
│   ├── sse
│   ├── websocket
│   └── errors
├── platform/
│   ├── contract
│   ├── browser-adapter
│   └── tauri-adapter         # future
├── runtime-types/
├── shared/
└── feature-flags/
```

---

## 19. UI Layering

```text
Design Tokens
  ↓
Primitives
  ↓
Interaction Patterns
  ↓
Domain Components
  ↓
Feature Workspaces
  ↓
App Shell
```

### 19.1 Design Tokens

No domain knowledge.

### 19.2 Primitives

Button、Input、Popover、Sheet、Tabs、ScrollArea。

### 19.3 Interaction Patterns

Resizable Panel、Command Menu、Virtual List、Inline Approval。

### 19.4 Domain Components

Run Card、Stage Node、Tool Call、Worktree Diff、Provider Badge。

### 19.5 Feature Workspaces

Conversation、Workbench、Inspector、Memory、Policy。

---

# Part III — Information Architecture

## 20. Global Information Architecture

```text
AgentOS
├── Conversations
│   ├── Direct Agents
│   ├── Groups
│   ├── Task Conversations
│   └── Run Conversations
├── Work
│   ├── Tasks
│   ├── Runs
│   ├── Review
│   └── Worktrees
├── Agents
│   ├── Profiles
│   ├── History
│   ├── Providers
│   └── Memory
├── Runtime
│   ├── Active Runs
│   ├── Processes
│   ├── Events
│   ├── Artifacts
│   └── Recovery
├── Safety
│   ├── Approvals
│   ├── Policies
│   ├── Grants
│   └── Audit
└── Settings
    ├── Workspace
    ├── Providers
    ├── Appearance
    ├── Notifications
    └── Advanced
```

---

## 21. App Shell

Wide Desktop Layout：

```text
┌──────────────────────────────────────────────────────────────────┐
│ Unified Toolbar / Workspace Context / Search / Global Actions    │
├──────┬──────────────────┬───────────────────────────┬────────────┤
│ Nav  │ Context Sidebar  │ Main Canvas               │ Inspector  │
│ Rail │                  │                           │            │
│      │ Conversation     │ Message Timeline          │ Run        │
│      │ Agent List       │ Task Workbench            │ Agent      │
│      │ Task List        │ Runtime Timeline          │ Artifact   │
│      │ Run List         │ Settings                  │ Memory     │
├──────┴──────────────────┴───────────────────────────┴────────────┤
│ Optional operation / connection status layer                     │
└──────────────────────────────────────────────────────────────────┘
```

### 21.1 Nav Rail

宽度：

```text
48–56px
```

用于主要 Product Area。

### 21.2 Context Sidebar

建议：

```text
240–320px
```

可调整、折叠。

### 21.3 Main Canvas

占据主要空间。

最小可用宽度：

```text
560px
```

### 21.4 Inspector

建议：

```text
320–440px
```

按需打开，可调整。

---

## 22. Adaptive Layout

### Wide

```text
>= 1440px
Nav + Sidebar + Canvas + Inspector
```

### Standard

```text
1100–1439px
Nav + Sidebar + Canvas
Inspector overlay or collapsible
```

### Compact

```text
768–1099px
Nav + Canvas
Sidebar and Inspector as sheets
```

### Narrow

```text
< 768px
Single primary surface
Stack navigation
Touch-ready controls
```

断点是建议，最终以 Container Query 和实际信息密度为准。

---

## 23. Unified Toolbar

Toolbar 展示：

- Current Workspace；
- Current Feature；
- Breadcrumb；
- Search；
- Command Palette；
- Connection；
- Active Run Count；
- Pending Approval；
- User / Appearance。

### 23.1 Contextual Actions

右侧只展示当前 Canvas 的主要操作。

不要将所有全局操作塞入 Toolbar。

---

## 24. Workspace Switching

Workspace Switcher：

- 显示 Name；
- Repository Status；
- Active Run；
- Provider Warning；
- Recent Workspace；
- Add Workspace。

切换 Workspace 不应自动取消当前 Workspace Run。

---

## 25. Command Palette

支持：

- Navigate；
- Create Task；
- Open Conversation；
- Select Agent；
- Start Run；
- Open Run；
- Approvals；
- Search History；
- Toggle Inspector；
- Change Theme。

高风险 Action 不能因为 Command Palette 而跳过 Confirmation 和 Policy。

---

# Part IV — Conversation Workspace

## 26. Conversation Layout

```text
Context Sidebar
  ├── Direct Agents
  ├── Group Conversations
  ├── Task Conversations
  ├── Run Conversations
  └── Archived

Main Canvas
  ├── Conversation Header
  ├── Message Timeline
  ├── Active Runtime Strip
  └── Composer

Inspector
  ├── Members
  ├── Linked Tasks
  ├── Linked Runs
  ├── Artifacts
  ├── Memory
  └── Conversation Settings
```

---

## 27. Conversation List

List Item 显示：

- Avatar；
- Title；
- Agent / Group Type；
- Last Message；
- Time；
- Unread；
- Mention；
- Active Run；
- Pending Approval；
- Provider Warning；
- Muted / Archived。

### 27.1 Selection Motion

选择后：

- 立即 pointer-down feedback；
- Selection background 连续变化；
- Main Canvas 内容使用短 Crossfade；
- 不做大幅左右滑动；
- Scroll Position 按 Conversation 恢复。

---

## 28. Message Timeline

支持：

- User Message；
- Agent Message；
- System Notice；
- Run Card；
- Stage Summary；
- Tool Call；
- Command；
- File Change；
- Diff；
- Approval；
- Artifact；
- Review；
- Error；
- Recovery。

### 28.1 Message Density

普通聊天保持轻量。

Runtime 细节默认折叠。

### 28.2 No Card Soup

连续普通 Message 不需要每条都有大阴影卡片。

推荐：

- User Message 使用轻量 Bubble；
- Agent Message 使用开放内容布局；
- Runtime Object 使用语义卡片；
- System Status 使用 Inline Row。

---

## 29. Streaming Presentation

```text
stream.text_delta
  ↓
batched client updates
  ↓
single streaming block
  ↓
final message
```

要求：

- 光标或细微状态可选；
- 不为每个字符创建 DOM Node；
- 不自动跳动 Layout；
- 用户向上滚动后停止 Auto-scroll；
- 显示“回到最新”按钮；
- Finalize 后保持 Scroll Anchor。

---

## 30. Tool and Command Presentation

Tool Card 最小状态：

- Icon；
- Name；
- Status；
- Duration；
- Summary。

展开后：

- Arguments，脱敏；
- Result；
- Files；
- Artifact；
- Error；
- Runtime Event Link。

### 30.1 Running Tool

使用连续状态，不使用无限强烈 Pulse。

### 30.2 Completed Tool

完成反馈应短暂、克制。

---

## 31. Composer

Composer 支持：

- Text；
- Markdown；
- `@Agent`；
- Slash Command；
- Attachment；
- Create Task；
- Start Run；
- Reply Target；
- Group Mode；
- Stop Streaming。

### 31.1 Composer Modes

```text
Chat
Task
Run
```

模式必须明确。

普通 Send 不应隐式变成修改型 Run。

### 31.2 Expanding Composer

Composer 随内容增长，但应限制最大高度。

超出后内部滚动。

### 31.3 Attachment

前端上传后只保存 Artifact / File Reference。

不把本地绝对路径作为消息合同。

---

## 32. Group Conversation

Group Header 展示：

- Members；
- Roles；
- Reply Policy；
- Orchestrator；
- Mode；
- Reply Budget。

发送时可以选择：

- One Agent；
- Mentioned Agents；
- Orchestrator；
- Sequential；
- Parallel；
- Discussion；
- Workflow Run。

---

## 33. Agent-to-Agent Visibility

内部 Workflow 协作默认投影为：

- Stage Result；
- Summary；
- Artifact；
- Review。

不把所有 Agent 内部协调都变成聊天气泡。

---

# Part V — Task and Run Workbench

## 34. Workbench Layout

```text
Context Sidebar
  ├── Task Filters
  ├── Active
  ├── Review
  ├── Completed
  └── Archived

Main Canvas
  ├── Task Header
  ├── Run Selector
  ├── Stage Graph / Timeline
  ├── Main Detail
  └── Result / Diff / Review

Inspector
  ├── Run Config
  ├── Agent
  ├── Provider
  ├── Worktree
  ├── Memory
  ├── Policy
  └── Artifacts
```

---

## 35. Task Header

展示：

- Title；
- Status；
- Priority；
- Agent；
- Workflow；
- Acceptance Criteria；
- Active Run；
- Accepted Run；
- Create Run；
- Request Changes；
- Accept。

Task Status 不能由 UI 随意改成 Completed。

---

## 36. Run Selector

Task 可以有多个 Run。

Run Item 显示：

- Reason；
- Status；
- Provider；
- Started；
- Duration；
- Result；
- Failure；
- Accepted；
- Parent / Child。

Retry 不覆盖旧 Run。

---

## 37. Stage Graph

支持：

- Linear；
- Branch；
- Parallel；
- Join；
- Skipped；
- Waiting Approval；
- Failed；
- Retried。

### 37.1 Stage Node

展示：

- Name；
- Agent；
- Provider；
- Status；
- Duration；
- Attempt；
- Worktree；
- Approval；
- Result。

### 37.2 Motion

Stage 状态变化使用颜色、图标和轻微形变。

不使用大范围节点跳动。

Graph Layout 应稳定，状态变化不重新随机排布。

---

## 38. Run Timeline

Timeline 聚合：

- Run；
- Stage；
- Provider；
- Tool；
- Command；
- File；
- Approval；
- Test；
- Review；
- Artifact；
- Error。

默认 Summary Mode。

Advanced Mode 显示 Event。

---

## 39. Worktree View

展示：

- Branch；
- Base Commit；
- Head Commit；
- Status；
- Changed Files；
- Diff；
- Review；
- Merge；
- Cleanup。

Merge 操作必须展示：

- Source；
- Target；
- Expected Commit；
- Strategy；
- Tests；
- Approval。

---

## 40. Diff Viewer

支持：

- Unified；
- Split；
- File Tree；
- Added / Modified / Deleted；
- Binary；
- Search；
- Collapse unchanged；
- Comment / Review Reference。

### 40.1 Diff Performance

大 Diff 使用：

- Virtualization；
- Lazy File Load；
- Syntax Highlight Worker；
- Line Window；
- Artifact Range。

---

## 41. Result View

Run Terminal 后展示：

- Summary；
- Output Contract；
- Test；
- Review；
- Diff；
- Artifact；
- Warning；
- Failure；
- Retry；
- Accept。

---

# Part VI — Runtime Inspector

## 42. Inspector Purpose

Runtime Inspector 面向高级查看和恢复。

它不是普通用户每次都必须进入的主页面。

---

## 43. Inspector Structure

```text
Run Overview
├── Identity
├── Snapshot
├── Stages
├── Events
├── Provider Sessions
├── Processes
├── Worktrees
├── Memory Context
├── Policy Decisions
├── Approvals
├── Artifacts
├── Recovery
└── Audit
```

---

## 44. Inspector Opening Behavior

Inspector 从当前对象附近打开。

例如点击 Run Card：

- 右侧 Inspector 滑入；
- Canvas 不重新导航；
- 无遮罩；
- 用户可继续查看 Conversation。

需要全屏细节时：

- Inspector 提供 Open Full View。

---

## 45. Process Tree

显示：

- Process Type；
- PID；
- Parent；
- Status；
- Executable；
- CWD，按权限；
- Duration；
- Exit；
- Usage；
- Stop。

Force Kill 必须明确标记风险。

---

## 46. Event Viewer

功能：

- Sequence；
- Type；
- Source；
- Stage；
- Correlation；
- Severity；
- Payload；
- Artifact；
- Search；
- Filter；
- Replay Cursor。

默认不显示 Raw JSON。

Raw JSON 属于 Advanced View。

---

## 47. Recovery UI

Recovery Item 展示：

- Detected State；
- Confidence；
- Missing Resource；
- Suggested Action；
- Risk；
- Preserve；
- Reattach；
- Cleanup；
- Manual Review。

不默认选择 Destructive Action。



# Part VII — Agent and Provider UI

## 48. Agent Directory

Agent List 展示：

- Avatar；
- Name；
- Role；
- Status；
- Default Provider；
- Active Run；
- Pending Approval；
- Recent Failure；
- Conversation Entry。

Agent 是主要身份，Provider 是次级运行信息。

---

## 49. Agent Profile

```text
Agent Profile
├── Identity
├── Role and Instructions
├── Capabilities
├── Provider Bindings
├── Conversations
├── Tasks
├── Runs
├── Sessions
├── Artifacts
├── Memory
├── Failures
└── Usage
```

### 49.1 Agent History

历史按时间和对象类型组织。

不得只展示 Provider 本地 Session 文本。

---

## 50. Provider Settings

Provider Card 展示：

- Name；
- Provider Type；
- Adapter；
- Executable；
- Model；
- Validation；
- Authentication；
- Capability；
- Health；
- Last Used；
- Error。

### 50.1 KimiCode

KimiCode UI 必须明确：

```text
Provider Type: KimiCode
Adapter: builtin.kimicode
Executable: kimi.exe
```

不得显示为：

```text
OpenCode + Kimi Model
```

### 50.2 Validation

Validation 使用明确状态：

- Validating；
- Valid；
- Warning；
- Auth Required；
- Executable Missing；
- Unsupported Version；
- Failed。

---

## 51. Provider Authentication

Authentication Flow：

```text
Provider Settings
  ↓
Start Auth
  ↓
Native / Browser / Device Flow
  ↓
Status Poll
  ↓
Revalidate
```

不在 UI 展示 Credential Value。

---

## 52. Provider Comparison

比较视图展示：

- Agent；
- Provider；
- Base Commit；
- Duration；
- Cost / Usage；
- Result；
- Diff；
- Tests；
- Review；
- Failure。

Provider 比较不是普通聊天消息的横向堆叠。

应使用专门 Comparison Workspace。

---

# Part VIII — Memory UI

## 53. Memory Library

Memory List 支持：

- Scope；
- Category；
- Status；
- Pinned；
- Authority；
- Confidence；
- Importance；
- Source；
- Last Used；
- Conflict。

---

## 54. Memory Entry Inspector

显示：

- Content；
- Summary；
- Scope；
- Category；
- Tags；
- Source；
- Authority；
- Confidence；
- Importance；
- Usage；
- Conflict；
- Supersession；
- Index State；
- Edit History。

---

## 55. Memory Context Inspector

Run / Stage 中展示：

- Query；
- Selected Entries；
- Score；
- Rank；
- Reasons；
- Budget；
- Excluded；
- Truncated；
- Prompt Artifact。

用户应能回答：

```text
为什么这个 Agent 收到了这条 Memory？
```

---

## 56. Candidate Review

Candidate Card 展示：

- Proposed Content；
- Source；
- Scope；
- Category；
- Duplicate；
- Conflict；
- Confidence；
- Recommendation。

操作：

- Accept；
- Edit and Accept；
- Reject；
- Merge。

---

## 57. Memory Safety

Imported Memory 和 User Constraint 使用不同视觉标签。

Imported Content 不能看起来像 System Rule。

---

# Part IX — Policy and Approval UI

## 58. Approval Center

Approval Queue 按：

- Critical；
- High；
- Medium；
- Time；
- Run；
- Workspace。

展示：

- Requesting Agent；
- Provider；
- Action；
- Resource；
- Risk；
- Exact Target；
- Policy Reason；
- Scope Options；
- Run Context。

---

## 59. Approval Card

Approval 操作必须是明确按钮：

```text
Approve Once
Approve Stage
Approve Run
Reject
Cancel Run
```

不使用：

```text
Continue
OK
Yes
```

表达高风险授权。

### 59.1 Default Selection

默认选择最小授权范围。

不能默认 Workspace。

---

## 60. Destructive Confirmation

仅对真正不可逆或高影响行为使用 Modal。

示例：

- Force Push；
- Unmanaged Recursive Delete；
- Hard Delete Memory；
- Force Cleanup Dirty Worktree；
- Unsafe Mode。

普通 Save、Archive 不使用重复确认。

---

## 61. Policy Editor

Policy Editor 分层：

### Basic

- Profile Mode；
- Common Permissions；
- Network；
- Merge；
- Package；
- Secret。

### Advanced

- Rule；
- Selector；
- Priority；
- Specificity；
- Simulation；
- Recent Match；
- Shadowed Rule。

---

## 62. Policy Simulation

显示：

```text
Principal
Action
Resource
Context
  ↓
Matched Rules
  ↓
Precedence Trace
  ↓
Decision
```

Simulation 不执行 Action。

---

## 63. Unsafe Mode

Unsafe Mode 开启后必须常驻显示：

- Toolbar Warning；
- Workspace Badge；
- Expiration；
- Reason；
- Disable Button。

不能只出现一次 Toast 后消失。

---

# Part X — Artifact UI

## 64. Artifact Browser

Artifact 按：

- Run；
- Stage；
- Type；
- Date；
- Sensitivity；
- Source；

组织。

---

## 65. Artifact Viewer

支持：

- Text；
- Markdown；
- JSON；
- Image；
- Diff；
- Log；
- Archive Index；
- Binary Metadata。

大型内容使用 Range 和 Lazy Load。

---

## 66. Artifact Actions

Web：

- Preview；
- Download；
- Copy Reference；
- Open Source Run。

Future Tauri：

- Open Native；
- Reveal in File Manager；
- Save As。

Domain Component 只调用 Platform Adapter。

---

# Part XI — Design Token Architecture

## 67. Token Layers

```text
Primitive Tokens
  ↓
Semantic Tokens
  ↓
Component Tokens
  ↓
State Overrides
```

---

## 68. Primitive Color Tokens

示例：

```text
gray.0
gray.50
gray.100
...
gray.950

blue.50–950
green.50–950
yellow.50–950
red.50–950
purple.50–950
```

组件不得直接使用 Primitive Color 表达语义。

---

## 69. Semantic Color Tokens

```css
--surface-base
--surface-subtle
--surface-raised
--surface-overlay
--surface-glass
--surface-selected
--surface-hover
--surface-pressed

--text-primary
--text-secondary
--text-tertiary
--text-disabled
--text-on-accent

--border-subtle
--border-default
--border-strong
--separator
--focus-ring

--accent
--accent-hover
--accent-pressed

--status-neutral
--status-running
--status-waiting
--status-success
--status-warning
--status-danger
--status-paused
```

---

## 70. Status Semantics

状态不能只靠颜色。

必须同时使用：

- Icon；
- Label；
- Shape / Pattern，必要时；
- Accessible Name。

示例：

```text
Running:
  blue + spinner + "Running"

Failed:
  red + error icon + "Failed"
```

---

## 71. Typography

优先系统字体：

```css
font-family:
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  sans-serif;
```

代码：

```css
font-family:
  ui-monospace,
  "SFMono-Regular",
  "Cascadia Code",
  "Segoe UI Mono",
  monospace;
```

### 71.1 Type Scale

建议：

```text
Display      32 / 38
Title Large  24 / 30
Title        20 / 26
Heading      16 / 22 semibold
Body         14 / 20
Body Dense   13 / 18
Caption      12 / 16
Micro        11 / 14
Code         13 / 19
```

### 71.2 Tracking

- 大标题轻微负 Tracking；
- Body 接近 0；
- 小 Caption 可轻微正 Tracking；
- 不使用全局固定 Letter Spacing。

### 71.3 Weight

优先：

- Regular；
- Medium；
- Semibold。

避免大面积 Thin。

---

## 72. Spacing

建议基础单位：

```text
4px
```

Scale：

```text
0
4
8
12
16
20
24
32
40
48
64
```

### 72.1 Density

支持：

```text
comfortable
compact
```

Compact 只减少间距和高度，不缩小到不可点击。

---

## 73. Radius

建议：

```text
4   micro
6   input / compact
8   button / row
10  card
12  panel
16  large overlay
20  prominent sheet
999 pill
```

避免每个元素都使用超大圆角。

---

## 74. Shadow and Elevation

Elevation：

```text
level-0  content
level-1  raised card
level-2  floating toolbar
level-3  popover
level-4  modal / sheet
```

Shadow 必须适配 Light / Dark。

---

## 75. Material

Material 用于功能层：

- Unified Toolbar；
- Sidebar；
- Floating Composer；
- Popover；
- Inspector Header；
- Sheet；
- Temporary Controls。

内容层优先 Solid Surface：

- Messages；
- Code；
- Diff；
- Logs；
- Forms；
- Data Tables。

### 75.1 Material Rules

1. 不嵌套多个浅色 Glass。
2. 大 Surface 比小 Surface 更厚。
3. Busy Content 上提高分离度。
4. Reduced Transparency 时转 Solid。
5. More Contrast 时增加 Border。
6. Glass 进入时 Materialize，而不是只 Fade。

---

## 76. Iconography

使用跨平台、可访问、线宽一致的图标系统。

要求：

- 统一 ViewBox；
- 统一 Stroke；
- 统一 Optical Size；
- Text Alternative；
- 常见操作保持熟悉图标。

不依赖 SF Symbols 作为 Web / Windows 唯一资源。

---

## 77. Z-index

统一层级：

```text
base
sticky
toolbar
inspector
popover
dropdown
sheet
modal
toast
critical
```

禁止组件自行设置极大 Z-index。

---

# Part XII — Interaction and Motion Architecture

## 78. Immediate Response

所有可操作控件在 pointer-down 时提供反馈。

```css
.control:active {
  transform: scale(0.98);
}
```

反馈目标：

```text
perceived immediate
```

不能等网络响应后才显示按压状态。

---

## 79. Direct Manipulation

适用于：

- Panel Resize；
- Sidebar Resize；
- Drag Reorder；
- Split Handle；
- Sheet Drag；
- Timeline Scrub，未来。

要求：

- 1:1 跟随 Pointer；
- 保留 Grab Offset；
- Pointer Capture；
- 边界阻尼；
- 释放时考虑 Velocity。

---

## 80. Interruptibility

所有 Panel、Sheet、Popover 和 Drag Motion 必须：

- 可在中途反向；
- 从当前屏幕值开始；
- 不锁住输入；
- 不等待旧动画结束；
- 不因快速点击跳变。

---

## 81. Motion Tokens

```ts
interface MotionTokens {
  press: {
    durationMs: 100;
    scale: 0.98;
  };

  micro: {
    durationMs: 140;
  };

  crossfade: {
    durationMs: 180;
  };

  panelSpring: {
    dampingRatio: 1.0;
    responseSeconds: 0.36;
  };

  momentumSpring: {
    dampingRatio: 0.8;
    responseSeconds: 0.34;
  };

  largeSurface: {
    responseSeconds: 0.42;
  };
}
```

### 81.1 Default

默认使用临界阻尼：

```text
damping ratio = 1.0
```

### 81.2 Bounce

只有以下场景允许轻微 Bounce：

- Flick；
- Drag Release；
- Throw；
- Snap；
- 用户输入本身带动量。

普通 Menu、Toast、Dialog 不弹跳。

---

## 82. Velocity Handoff

Drag 释放后，Spring 必须继承 Release Velocity。

不能：

```text
drag ends
velocity becomes zero
animation starts
```

---

## 83. Momentum Projection

可拖动物体的最终目标根据：

```text
current position
+ projected momentum
```

决定，而不是只按松手位置。

适用于：

- Reorder；
- Sheet Snap；
- Carousel，未来；
- Floating Inspector，未来。

---

## 84. Spatial Consistency

### 84.1 Symmetric Path

从右侧进入的 Inspector 从右侧退出。

### 84.2 Source Anchoring

Popover 从触发按钮附近出现。

### 84.3 Shared Object Continuity

Conversation 中的 Run Card 打开 Inspector 时，应保持对象身份连续。

可以使用：

- Shared Layout ID；
- Anchor Rect；
- Source Highlight；
- Short Transition。

不需要夸张 Morph。

---

## 85. Rubber-band

Resizable Panel 到达边界时：

- 提供渐进阻力；
- 不完全跟随；
- 释放后回到合法值。

Keyboard Resize 不使用 Rubber-band。

---

## 86. Feedback Types

统一四类：

```text
status
completion
warning
error
```

### Status

持续但克制。

### Completion

短暂明确。

### Warning

说明风险和预防方式。

### Error

说明发生了什么、是否执行、如何恢复。

---

## 87. Sound and Haptic

Web 第一阶段默认不使用 Sound。

Future Tauri 可以对以下事件提供可关闭反馈：

- Critical Approval；
- Run Completed；
- Run Failed；
- Merge Completed。

必须与视觉事件同步。

---

## 88. Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  /* replace translation and spring with crossfade */
}
```

Reduced Motion：

- 禁用 Overshoot；
- 禁用 Parallax；
- Sheet 使用短 Crossfade；
- 保留必要状态反馈；
- 不使用持续循环动画。

---

## 89. Reduced Transparency

```css
@media (prefers-reduced-transparency: reduce) {
  /* raise opacity, remove backdrop blur */
}
```

Web 支持不一致时，提供应用设置。

---

## 90. More Contrast

```css
@media (prefers-contrast: more) {
  /* solid surface, stronger border, clearer focus */
}
```

---

## 91. Motion Performance

只优先动画：

- transform；
- opacity；
- filter，谨慎；
- clip-path，谨慎。

避免高频动画：

- width；
- height；
- top；
- left；
- box-shadow 大范围变化；
- backdrop-filter 多层重绘。

---

# Part XIII — Component Architecture

## 92. Primitive Components

必须有统一实现：

```text
Button
IconButton
Toggle
Checkbox
Radio
Input
Textarea
Select
Combobox
Tabs
SegmentedControl
Menu
Popover
Tooltip
Dialog
Sheet
Toast
Badge
Avatar
Separator
ScrollArea
Progress
Skeleton
```

---

## 93. Layout Primitives

```text
AppShell
NavigationRail
ContextSidebar
UnifiedToolbar
MainCanvas
InspectorPanel
SplitView
ResizablePanel
StickyRegion
VirtualList
```

---

## 94. Runtime Domain Components

```text
TaskCard
RunCard
StageNode
StageGraph
RuntimeTimeline
RuntimeEventRow
ToolCallCard
CommandCard
FileChangeCard
DiffViewer
ProcessTree
ProcessCard
WorktreeCard
MergeCard
ApprovalCard
ArtifactCard
ProviderBadge
ProviderHealth
MemoryEntryCard
MemoryContextList
PolicyDecisionCard
RecoveryCard
```

---

## 95. Conversation Domain Components

```text
ConversationList
ConversationListItem
ConversationHeader
MessageTimeline
MessageGroup
UserMessage
AgentMessage
SystemMessage
StreamingMessage
Composer
MentionPicker
GroupModePicker
AgentTurnStatus
```

---

## 96. Component State Contract

所有异步组件支持：

- idle；
- loading；
- empty；
- partial；
- stale；
- error；
- permission denied；
- recovery required；
- offline / reconnecting。

不能只有 Loading 和 Success。

---

## 97. Controlled Risk Components

Approval、Merge、Force Kill、Delete 使用专用组件。

不能复用普通 Button + Alert 拼装而失去语义。

---

# Part XIV — Client Data Architecture

## 98. State Categories

### Server State

- Workspace；
- Agent；
- Task；
- Run；
- Stage；
- Message；
- Approval；
- Worktree；
- Memory；
- Artifact。

### Realtime State

- Runtime Event Cursor；
- Message Delta；
- Presence；
- Typing；
- Connection。

### Local View State

- Selected Row；
- Open Inspector；
- Panel Size；
- Active Tab；
- Filter；
- Search Query；
- Density；
- Scroll Anchor。

### Draft State

- Composer；
- Task Form；
- Policy Rule；
- Review Comment。

---

## 99. Server State Strategy

使用 Query Cache 或等价方案。

要求：

- API DTO 类型化；
- Query Key 稳定；
- ETag；
- Invalidation；
- Stale Time；
- Optimistic Update 白名单；
- Realtime Patch；
- Full Refetch on Gap。

---

## 100. Realtime State Strategy

```text
Initial REST Query
  ↓
Subscribe SSE / WebSocket
  ↓
Apply ordered events
  ↓
detect gap
  ↓
REST resync
```

### 100.1 No Direct stdout State

前端不直接把 stdout 文本推断为 Stage Status。

---

## 101. Streaming Batching

Message Delta 和 Text Delta 使用：

- requestAnimationFrame；
- 16–50ms Batch；
- String Buffer；
- Block Update；
- Checkpoint。

避免每个 Token 触发整个 App Render。

---

## 102. Error State

统一 Client Error：

```ts
interface ClientErrorState {
  code: string;
  title: string;
  detail: string;
  retryable: boolean;
  requestId?: string;
  suggestedAction?: string;
}
```

UI 不解析错误字符串推断类型。

---

## 103. Offline and Reconnecting

Web Local UI 显示：

- Server Disconnected；
- Reconnecting；
- Last Updated；
- Run continues on server，若已知；
- Retry Connection；
- Open Diagnostics。

断线不能立即把 Run 标记 Failed。

---

## 104. Draft Persistence

Composer Draft 可以：

- IndexedDB；
- Local Storage，小内容；
- Server Draft，未来。

Draft Key：

```text
workspaceId
conversationId
userId
```

Secret Scan 在 Send 时执行。

---

# Part XV — API Client Architecture

## 105. AgentOS Client

```ts
interface AgentOSClient {
  workspaces: WorkspaceApi;
  agents: AgentApi;
  providers: ProviderApi;
  workflows: WorkflowApi;
  tasks: TaskApi;
  runs: RunApi;
  stages: StageApi;
  processes: ProcessApi;
  worktrees: WorktreeApi;
  memories: MemoryApi;
  policies: PolicyApi;
  approvals: ApprovalApi;
  conversations: ConversationApi;
  artifacts: ArtifactApi;
  operations: OperationApi;
  realtime: RealtimeApi;
}
```

---

## 106. No Component-level Fetch

错误：

```ts
fetch('/api/runs/' + id)
```

散落在组件中。

正确：

```ts
client.runs.get(id)
```

---

## 107. Runtime Transport

```ts
interface RuntimeTransport {
  request<T>(
    request: TransportRequest
  ): Promise<TransportResponse<T>>;

  subscribeRun(
    runId: string,
    cursor: RuntimeCursor
  ): RuntimeSubscription;

  subscribeConversation(
    conversationId: string,
    cursor: ConversationCursor
  ): RuntimeSubscription;
}
```

Browser 和 Future Tauri 默认都使用：

- REST；
- SSE；
- WebSocket。

---

## 108. API Base Resolution

优先级：

```text
Explicit Runtime Config
  > Desktop Sidecar Discovery, future
  > Same Origin
  > Local Development Default
```

页面组件不知道端口。

---

## 109. Idempotency

API Client 为以下操作生成 Key：

- Send Message；
- Create Task；
- Create Run；
- Approve；
- Merge；
- Export。

网络重试复用原 Key。

---

## 110. ETag

API Client 保存 Resource ETag。

Update 时发送 `If-Match`。

冲突时显示：

- Reload；
- Compare；
- Retry。

---

# Part XVI — Platform Adapter

## 111. Platform Adapter Contract

```ts
interface PlatformAdapter {
  kind:
    | 'browser'
    | 'tauri';

  getCapabilities():
    Promise<PlatformCapabilities>;

  openExternal(
    url: string
  ): Promise<void>;

  selectFile?(
    options: FileSelectionOptions
  ): Promise<SelectedFileReference[]>;

  selectDirectory?(
    options?: DirectorySelectionOptions
  ): Promise<SelectedDirectoryReference | null>;

  downloadArtifact(
    artifactId: string,
    suggestedName?: string
  ): Promise<void>;

  revealArtifact?(
    artifactId: string
  ): Promise<void>;

  openArtifactNative?(
    artifactId: string
  ): Promise<void>;

  showNotification?(
    input: PlatformNotification
  ): Promise<void>;

  writeClipboard(
    content: string
  ): Promise<void>;

  getAppearance():
    Promise<'light' | 'dark' | 'system'>;
}
```

---

## 112. Browser Adapter

Browser Adapter 实现：

- `window.open`，经过安全包装；
- File Input；
- Browser Download；
- Clipboard API；
- Notification API，可选；
- Media Query；
- Web Share，未来。

不支持时提供明确 Fallback。

---

## 113. Future Tauri Adapter

未来实现：

- Native Dialog；
- Native Open；
- Reveal；
- Native Notification；
- Window；
- Tray；
- Menu；
- Update；
- Sidecar。

页面组件不直接调用：

```text
window.__TAURI__
```

---

## 114. Platform Capability

```ts
interface PlatformCapabilities {
  nativeWindow: boolean;
  nativeFileDialog: boolean;
  revealFile: boolean;
  nativeNotification: boolean;
  tray: boolean;
  autoUpdate: boolean;
  sidecar: boolean;
}
```

根据 Capability 决定是否显示操作。

不能只根据 User Agent 猜测。

---

## 115. Artifact Boundary

Platform Adapter 接收：

```text
artifactId
```

而不是：

```text
E:\workspace\...
```

Future Tauri Host 和 AgentOS Server 协作解析受控路径。

---

# Part XVII — Appearance and Personalization

## 116. Appearance Modes

```text
system
light
dark
```

---

## 117. Accent

Accent 可配置，但：

- 不覆盖 Status Color；
- 不降低对比度；
- 不把所有交互元素染色；
- 不改变 Danger 语义。

---

## 118. Density

```text
comfortable
compact
```

Compact 适合 Runtime Inspector。

Conversation 默认 Comfortable。

---

## 119. Panel Preferences

可保存：

- Sidebar Width；
- Inspector Width；
- Sidebar Collapsed；
- Inspector Open；
- Last Tab；
- Timeline Density；
- Code Wrap；
- Diff Mode。

### 119.1 Persistence Class

Local-only：

- 当前 Scroll；
- 临时 Selection；
- Pointer Drag；
- Window Position，future Tauri。

Server-synced：

- Appearance；
- Density；
- Accent；
- Notification；
- Default View，推荐；
- Saved Filter，未来。

---

# Part XVIII — Accessibility

## 120. Keyboard

核心功能必须可通过 Keyboard：

- Navigation；
- Search；
- Send；
- New Task；
- Open Run；
- Toggle Inspector；
- Approve / Reject；
- Cancel；
- Tabs；
- Menu；
- Dialog。

---

## 121. Focus

要求：

- Visible Focus Ring；
- Logical Order；
- Restore Focus；
- Modal Trap；
- Sheet Trap，阻塞式；
- Inspector 非阻塞时不 Trap；
- Skip to Main；
- No Focus Loss on Streaming Update。

---

## 122. Target Size

Desktop Pointer：

```text
minimum 28×28px preferred
```

Touch-ready：

```text
minimum 44×44px
```

图标视觉尺寸可以小于 Hit Area。

---

## 123. Contrast

正文通常满足：

```text
4.5:1
```

大文字和图形按对应标准。

Glass 上的文字必须重新验证实际背景。

---

## 124. Screen Reader

所有 Runtime 状态应有 Accessible Name。

Streaming 更新使用：

- `aria-live`，克制；
- 不逐 Token 宣读；
- Finalize 后宣布完成；
- Critical Approval 使用 assertive，谨慎。

---

## 125. Reduced Cognitive Load

- 状态词统一；
- Error 提供下一步；
- 不同时闪烁多个区域；
- Approval 不使用复杂技术术语作为唯一说明；
- Advanced Detail 可折叠。

---

# Part XIX — Performance Architecture

## 126. Performance Budgets

目标：

```text
Input feedback:
  immediate, no artificial delay

Main interaction:
  60fps target

Frame budget:
  ~16.7ms

Long task:
  avoid > 50ms on main thread

Route shell:
  usable quickly

Streaming:
  batch updates

Large lists:
  virtualized
```

---

## 127. Code Splitting

按 Feature：

- Conversation；
- Workbench；
- Inspector；
- Memory；
- Policy；
- Settings；
- Diff Viewer。

App Shell 和 Navigation 优先加载。

---

## 128. Virtualization

必须考虑：

- Message Timeline；
- Runtime Event；
- Artifact List；
- Memory List；
- Task List；
- Large Diff；
- Process Usage。

---

## 129. Worker

适合 Worker：

- Syntax Highlight；
- Large Diff Parse；
- Search Index，客户端可选；
- JSON Format；
- Timeline Aggregation；
- Checksum，上传前。

---

## 130. Backdrop Filter Budget

只在少量 Chrome Surface 使用。

低性能或 Reduced Transparency：

- 禁用；
- 使用 Solid Surface。

---

## 131. Image and Avatar

- 固定尺寸；
- Lazy Load；
- Placeholder；
- 不阻塞 Timeline；
- Error Fallback。

---

# Part XX — Security Architecture

## 132. Rendering Security

Markdown：

- 默认禁用 Raw HTML；
- Sanitization；
- Link Protocol Allowlist；
- External Link Warning；
- Code Isolation；
- No Script；
- No Inline Event；
- No Auto Execute。

---

## 133. Approval Authenticity

Approval Card 必须由受信 Domain Component 渲染。

Agent 生成的 Markdown 不得伪装：

- Approval Button；
- System Warning；
- Native Dialog；
- Policy Decision。

---

## 134. Secret UI

Secret：

- 显示 Reference Name；
- 默认不可 Reveal；
- Copy 受控；
- 不进入 Toast；
- 不进入 Search；
- 不进入 Screenshot Export，按策略。

---

## 135. File and Path UI

普通 UI 显示：

- Relative Path；
- Workspace-relative；
- Artifact Name。

完整本地路径只在 Restricted Inspector 显示。

---

## 136. External Links

打开前：

- Normalize；
- Display Host；
- Block dangerous scheme；
- Platform Adapter；
- Policy，Server-side fetch 时。

---

# Part XXI — Testing

## 137. Design Token Tests

- Light；
- Dark；
- High Contrast；
- Reduced Transparency；
- Density；
- Status；
- Focus；
- Token completeness。

---

## 138. Component Tests

每个 Domain Component 覆盖：

- Idle；
- Loading；
- Streaming；
- Completed；
- Failed；
- Cancelled；
- Waiting Approval；
- Permission Denied；
- Recovery Required；
- Long Content；
- Empty；
- Keyboard。

---

## 139. Interaction Tests

- Pointer-down feedback；
- Interrupt panel；
- Rapid open / close；
- Resize；
- Drag reorder；
- Rubber-band；
- Reduced Motion；
- Focus restore；
- Escape；
- Keyboard navigation。

---

## 140. Realtime Tests

- Initial REST；
- SSE Event；
- Duplicate；
- Gap；
- Reconnect；
- Browser Refresh；
- Server Restart；
- Streaming Finalize；
- Partial Failure；
- Multi-tab；
- Slow Client。

---

## 141. Visual Regression

关键页面：

- App Shell；
- Conversation；
- Group；
- Task；
- Run；
- Inspector；
- Approval；
- Provider Settings；
- Memory；
- Policy；
- Light / Dark；
- Wide / Compact / Narrow。

---

## 142. Accessibility Tests

- Automated；
- Keyboard-only；
- Screen Reader Smoke；
- Contrast；
- Zoom 200%；
- Text Scaling；
- Reduced Motion；
- Reduced Transparency。

---

## 143. Performance Tests

- 10k Messages；
- 100k Events；
- Large Diff；
- 100 Active Runs；
- Streaming 20 events/sec；
- Multi-conversation；
- Low-end Windows Device；
- Blur disabled fallback。

---

# Part XXII — UI Observability

## 144. Client Metrics

允许记录：

- Route Load；
- Interaction Latency；
- Reconnect；
- Event Gap；
- Streaming Render；
- Error Code；
- Feature Usage；
- Long Task；
- Dropped Frame Approximation。

禁止记录：

- Prompt；
- Message Content；
- Secret；
- Full Path；
- Raw Artifact。

---

## 145. UI Diagnostics

Diagnostics View 展示：

- Client Version；
- API Version；
- Connection；
- SSE Cursor；
- WebSocket；
- Cache；
- Last Request ID；
- Feature Flag；
- Platform；
- Reduced Motion；
- Server Health。

---

# Part XXIII — v1 UI Migration

## 146. Current v1 UI

当前主要模式：

```text
Task Form
  ↓
Fixed Pipeline Page
  ↓
SSE Output
```

需要迁移的问题：

- Task 与 Run 混合；
- Agent 不是持久 Conversation Member；
- Provider 信息混在 Role；
- stdout 直接展示；
- Browser 生命周期影响执行；
- 无 Inspector；
- 无 Approval Center；
- 无 Worktree UI；
- 无 Memory Context UI；
- 无 Agent History；
- 无 Group Conversation。

---

## 147. Migration Principle

不进行整站一次性重写。

```text
Existing UI
  ↓
Shared Design Tokens
  ↓
New App Shell
  ↓
Conversation
  ↓
Task / Run Workbench
  ↓
Inspector
  ↓
Replace old pipeline page
```

---

## 148. Phase 1 — Foundation

- Token；
- Theme；
- App Shell；
- Nav Rail；
- Sidebar；
- Toolbar；
- Inspector；
- API Client；
- Error；
- Realtime Client；
- Platform Adapter。

---

## 149. Phase 2 — Conversation

- Direct Agent；
- Message；
- Streaming；
- Composer；
- Task Bridge；
- Run Card；
- Approval Card；
- Artifact Card。

---

## 150. Phase 3 — Workbench

- Task List；
- Run Selector；
- Stage Graph；
- Timeline；
- Result；
- Diff；
- Worktree；
- Review。

---

## 151. Phase 4 — Runtime Inspector

- Events；
- Provider Session；
- Process Tree；
- Memory Context；
- Policy；
- Approval；
- Artifact；
- Recovery。

---

## 152. Phase 5 — Group and Productization

- Groups；
- Orchestrator；
- Parallel；
- Agent History；
- Search；
- Notification；
- Command Palette；
- Appearance；
- Accessibility；
- Performance。

---

## 153. Phase 6 — Future Tauri

在 Web UI 稳定后：

```text
Add apps/desktop
  ↓
Reuse Web Build
  ↓
Implement TauriPlatformAdapter
  ↓
Package AgentOS Server Sidecar
  ↓
Add Native Capabilities
  ↓
Desktop Testing
```

不修改 Domain Runtime API。



# Part XXIV — Cross-document Alignment

## 154. Overview

`12-UI-Architecture.md` 不改变 AgentOS v2 的核心 Runtime 模型。

它主要补充：

- Web-first；
- Tauri-ready；
- UI / Runtime Boundary；
- Platform Adapter；
- Client State；
- Design System；
- Motion；
- Accessibility；
- Information Architecture。

对 00–11 的影响分为：

```text
Required Revision
Recommended Minor Revision
Cross-reference Only
No Structural Change
```

---

## 155. `00-Vision.md`

### Impact

```text
Recommended Minor Revision
```

### Existing Alignment

现有 Vision 已明确：

- 保留 Next.js 前端；
- 保留 Workspace UI；
- Browser 不应拥有 Runtime；
- UI 基于 Runtime Event；
- 不推倒重写。

### Required Addition

增加正式产品平台决策：

```text
AgentOS v2 is Web-first and Desktop-ready.

The Web UI is the first delivery surface.
A future Tauri client reuses the same UI, API Client,
REST, SSE, WebSocket and Runtime contracts.
```

### Clarification

原：

```text
Next.js frontend can be retained
```

补充：

```text
Next.js may be retained only when runtime-critical logic
remains in the independent AgentOS Server and the UI stays
client/static-host compatible.
```

### Vision Statement Addition

```text
AgentOS UI should make autonomous execution feel calm,
continuous, observable and user-controlled.
```

---

## 156. `01-Core-Concepts.md`

### Impact

```text
Recommended Minor Revision
```

### Add Concepts

#### UI Surface

```text
A human-facing view of runtime resources and projections.
```

#### Client Session

```text
A temporary browser or desktop connection.
It does not own Run, Process or Provider Session.
```

#### Platform Adapter

```text
A frontend boundary for browser or desktop-native capabilities.
```

#### Runtime Transport

```text
REST + SSE + WebSocket used by all UI hosts.
```

#### View State

```text
Ephemeral client state such as selection, panel size and scroll.
It is not Runtime State.
```

### Add Invariants

```text
UI Surface ≠ Runtime
Client Session ≠ Provider Session
View State ≠ Domain State
Platform Adapter ≠ Runtime Provider
```

---

## 157. `02-Runtime-Lifecycle.md`

### Impact

```text
Cross-reference Only / Optional Minor Revision
```

### Existing Alignment

现有文档已经规定：

```text
Browser Disconnect
  → subscription ends
  → Run continues
```

无需修改 Run、Stage、Cancel 或 Recovery 状态机。

### Optional Addition

增加 Client Subscription Lifecycle：

```text
connecting
connected
reconnecting
resyncing
disconnected
```

并明确它不进入 Run Lifecycle。

---

## 158. `03-Event-Model.md`

### Impact

```text
Cross-reference Only / Optional Minor Revision
```

### No Event Envelope Change

Apple Motion、Panel Open、Hover、Selection、Typing 等 UI 交互不应进入 Durable Runtime Event Store。

### Add Classification Note

```text
Durable Runtime Event
  = execution fact

Projection Event
  = rebuildable user-facing update

Ephemeral UI Event
  = hover, focus, panel, gesture, presence
```

### Existing Events Remain

- `stream.text_delta`；
- Run；
- Approval；
- Artifact；
- Conversation Projection；

无需重新设计。

---

## 159. `04-Provider-Specification.md`

### Impact

```text
No Structural Change
```

Provider Runtime 与 UI 通过 API 和 Capability 交互。

UI 不直接调用 Provider CLI。

可以增加一条 Cross-reference：

```text
Provider-specific UI must render from Provider Manifest,
Validation and Capability data, not hard-coded provider logic.
```

---

## 160. `05-Process-Runtime.md`

### Impact

```text
No Structural Change
```

Web-first 阶段不需要 Tauri Sidecar。

Future Tauri 可以新增 Process Type 或 Host Metadata：

```text
desktop-sidecar
```

但不应现在修改核心 Process Manager。

现有：

- Server owns Process；
- Browser Disconnect does not Cancel；
- Output Stream；
- Recovery；

已经满足 UI Architecture。

---

## 161. `06-Worktree-Runtime.md`

### Impact

```text
No Structural Change
```

UI 只需消费：

- Status；
- Diff；
- Review；
- Merge；
- Conflict；
- Cleanup。

Worktree Domain 和 Lifecycle 无需修改。

---

## 162. `07-Memory-Runtime.md`

### Impact

```text
No Structural Change
```

Memory Inspector、Candidate Review 和 Context Explanation 属于 UI 映射。

Memory Entry、Context、Ranking、Budget 不变。

可以增加 Cross-reference：

```text
Memory Context selection reasons must be exposed to the UI.
```

该要求现有文档已经基本包含。

---

## 163. `08-Policy-Runtime.md`

### Impact

```text
Optional Minor Revision
```

Web-first 阶段无须添加 Tauri Action。

Future Tauri 可增加：

```text
platform.open_external
platform.open_native
platform.reveal_artifact
platform.notify
platform.select_directory
desktop.sidecar_restart
desktop.auto_update
```

这些 Action 只有在真正实现 Tauri 时加入。

### UI-specific Addition

Approval UI 必须：

- 最小授权范围默认；
- 明确 Target；
- 明确 Risk；
- 不接受模糊文本批准。

现有 Policy Runtime 已覆盖核心要求。

---

## 164. `09-Conversation-Runtime.md`

### Impact

```text
Required Alignment Revision
```

这是受影响最大的现有文档。

### Keep

保留 Conversation Runtime 中：

- Conversation；
- Message；
- Member；
- Turn；
- Orchestrator；
- Streaming；
- Projection；
- Read State；
- Search；
- Recovery；
- UI-required data contract。

### Change

原 `Part XXI — Conversation UI Contract` 应：

1. 保留 Conversation 特有 UI Requirement；
2. 删除重复的全局 App Shell、视觉系统和平台细节；
3. 添加：

```text
See 12-UI-Architecture.md for:
  App Shell
  Layout
  Design Tokens
  Motion
  Platform Adapter
  Accessibility
  Client State
```

### Add Explicit Boundary

```text
09 defines what Conversation UI must be able to represent.
12 defines how the product UI is architected and rendered.
```

### No Domain Schema Change

Conversation Data Model 不需要修改。

---

## 165. `10-Data-Model.md`

### Impact

```text
Recommended Minor Revision
```

Runtime Data Model 不应保存所有 View State。

建议增加三个可选对象。

### User UI Preferences

```sql
CREATE TABLE user_ui_preferences (
  user_id TEXT PRIMARY KEY,

  appearance TEXT NOT NULL,
  accent TEXT,
  density TEXT NOT NULL,

  reduced_motion_override TEXT,
  reduced_transparency_override TEXT,
  contrast_override TEXT,

  notification_preferences_json TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL
);
```

### Workspace UI Preferences

```sql
CREATE TABLE workspace_ui_preferences (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  default_area TEXT,
  default_conversation_id TEXT,

  sidebar_width INTEGER,
  inspector_width INTEGER,

  sidebar_collapsed INTEGER NOT NULL,
  inspector_default_open INTEGER NOT NULL,

  saved_filters_json TEXT,

  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL,

  PRIMARY KEY(workspace_id, user_id)
);
```

### Client-local State

以下不进入主数据库：

- Scroll；
- Current Drag；
- Hover；
- Focus；
- Temporary Selection；
- Unsent transient state；
- Window Position，Future Tauri 本地存储。

### Optional Saved View

复杂 Runtime Filter 稳定后再增加。

---

## 166. `11-API-Specification.md`

### Impact

```text
Recommended Minor Revision
```

现有 API 已明确支持：

- Web UI；
- Desktop Client；
- REST；
- SSE；
- WebSocket；
- Browser Disconnect；
- Artifact ID；
- Capabilities。

无需改变核心资源 API。

### Recommended Endpoints

```text
GET   /api/preferences/ui
PATCH /api/preferences/ui

GET   /api/workspaces/:workspaceId/ui-preferences
PATCH /api/workspaces/:workspaceId/ui-preferences
```

### Client Capability Metadata

`GET /api/meta` 可补充：

```json
{
  "ui": {
    "supportedHosts": ["web", "tauri"],
    "currentHost": "web"
  }
}
```

Server 不应相信 `currentHost` 作为安全凭证。

### Native Platform Boundary

Tauri Native Command 不进入普通 Server API Specification。

Browser 和 Tauri 都继续使用相同 Runtime API。

---

## 167. Change Priority

### Must Change Before UI Implementation

```text
09 Conversation Runtime
  → replace duplicated UI architecture with cross-reference
```

### Should Change During UI Foundation

```text
00 Vision
01 Core Concepts
10 Data Model
11 API Specification
```

### Optional Documentation Alignment

```text
02 Runtime Lifecycle
03 Event Model
08 Policy Runtime
```

### No Structural Change

```text
04 Provider Specification
05 Process Runtime
06 Worktree Runtime
07 Memory Runtime
```

---

# Part XXV — Implementation Plan

## 168. UI Phase 0 — Architecture Alignment

- Update 00；
- Update 01；
- Align 09；
- Add UI Preferences to 10；
- Add Preferences API to 11；
- Create package boundaries；
- Freeze Token Naming；
- Freeze Navigation Model。

---

## 169. UI Phase 1 — Design System and Shell

Deliver：

- Theme；
- Tokens；
- Primitives；
- App Shell；
- Navigation Rail；
- Context Sidebar；
- Unified Toolbar；
- Inspector；
- Split View；
- Error Boundary；
- Loading；
- Empty；
- Realtime Status；
- Browser Platform Adapter。

Acceptance：

- Light / Dark；
- Keyboard；
- Reduced Motion；
- Responsive；
- No domain feature required.

---

## 170. UI Phase 2 — Direct Conversation

Deliver：

- Agent List；
- Direct Conversation；
- Message Timeline；
- Streaming；
- Composer；
- Tool Card；
- Run Card；
- Approval Card；
- Artifact Card；
- Reconnect。

---

## 171. UI Phase 3 — Workbench

Deliver：

- Task List；
- Task Detail；
- Run Selector；
- Stage Graph；
- Runtime Timeline；
- Diff；
- Result；
- Review；
- Worktree；
- Merge。

---

## 172. UI Phase 4 — Runtime Inspector

Deliver：

- Event；
- Process；
- Provider Session；
- Worktree；
- Memory Context；
- Policy Decision；
- Approval；
- Artifact；
- Recovery。

---

## 173. UI Phase 5 — Group Collaboration

Deliver：

- Group；
- Member；
- Mention；
- Orchestrator；
- Sequential；
- Parallel；
- Reply Budget；
- Agent History。

---

## 174. UI Phase 6 — Productization

Deliver：

- Search；
- Command Palette；
- Notifications；
- Settings；
- Appearance；
- Density；
- Accessibility Audit；
- Performance；
- Visual Regression；
- Onboarding。

---

## 175. UI Phase 7 — Future Tauri

Start only after:

- Web Runtime Stable；
- API Stable；
- SSE Recovery Stable；
- Platform Adapter Stable；
- Artifact Boundary Stable；
- UI Visual Regression Stable。

---

# Part XXVI — Definition of Done

## 176. UI Architecture Foundation DoD

Foundation 完成必须满足：

1. Web-first 是正式交付策略。
2. Tauri-ready 是架构约束，不是当前实现任务。
3. UI 不直接执行 Runtime Action。
4. UI 只通过 API Client 和 Runtime Transport。
5. AgentOS Server 拥有 Run 和 Process。
6. Browser Disconnect 不取消 Run。
7. Runtime State 和 View State 分离。
8. Projection 和 Runtime Fact 分离。
9. Next.js Runtime 逻辑不承载 AgentOS Runtime。
10. Frontend 可适配静态 / Client Host。
11. Platform Adapter 已定义。
12. Browser Adapter 已实现。
13. 页面不直接判断 `window.__TAURI__`。
14. Artifact 以 ID 而非 Path 传递。
15. App Shell 支持 Sidebar、Canvas、Inspector。
16. Layout 支持 Wide、Standard、Compact、Narrow。
17. Conversation 是主要协作入口。
18. Chat、Task 和 Run 模式明确分离。
19. Runtime Output 使用 Streaming Block 和 Domain Card。
20. Tool、Command、File、Diff 不拼成单段文本。
21. Run Workbench 支持多 Run。
22. Runtime Inspector 可渐进披露。
23. Agent Identity 与 Provider 视觉上分离。
24. Approval 使用专用受信组件。
25. Unsafe Mode 常驻可见。
26. Memory Context 可解释。
27. Provider Validation 和 Auth 状态明确。
28. Design Token 覆盖 Color、Type、Spacing、Radius、Motion。
29. Glass 只用于功能层。
30. 普通内容使用可读 Solid Surface。
31. pointer-down 有即时反馈。
32. Panel Motion 可打断。
33. 默认 Spring 无 Overshoot。
34. Bounce 仅用于 Momentum Interaction。
35. Reduced Motion 可用。
36. Reduced Transparency 可用。
37. Keyboard 可完成核心操作。
38. Focus 不因 Streaming 丢失。
39. Status 不只依赖 Color。
40. Message 和 Event 大列表可虚拟化。
41. Streaming Update 有 Batch。
42. API Error 使用稳定 Code。
43. ETag 和 Idempotency 在 Client 中支持。
44. Realtime Gap 可 REST Resync。
45. Markdown 安全渲染。
46. Agent Output 不能伪造 Approval。
47. Secret 不进入普通 UI 状态。
48. Light / Dark 视觉回归通过。
49. Accessibility Smoke Test 通过。
50. Future Tauri 不需要重写 Domain UI。

---

# Part XXVII — Anti-patterns

## 177. Apple Equals Glass

错误：

```text
Every panel
Every card
Every message
  → backdrop blur
```

正确：

```text
Functional chrome
  → material

Content
  → solid semantic surface
```

---

## 178. Apple Equals Marketing Page

错误：

```text
Huge heading
Large empty space
One card per screen
```

正确：

```text
Desktop productivity information density
+ clear hierarchy
+ calm motion
```

---

## 179. Provider as Navigation Identity

错误：

```text
Codex
KimiCode
OpenCode
```

作为唯一 Agent 列表。

正确：

```text
Architect
Backend Engineer
Reviewer

Provider appears as runtime capability
```

---

## 180. Client Owns Run

错误：

```text
React component unmount
  → AbortController
  → Kill Provider
```

正确：

```text
explicit POST cancel
```

---

## 181. Raw API in Components

错误：

```text
each component uses fetch
```

正确：

```text
AgentOSClient
+ Query Layer
+ Runtime Transport
```

---

## 182. Tauri Branches Everywhere

错误：

```ts
if (window.__TAURI__) ...
```

分散在页面中。

正确：

```text
PlatformAdapter
```

---

## 183. Persist All UI State

错误：

```text
hover
scroll
selection
drag position
→ SQLite
```

正确：

```text
runtime data → server
stable preference → preference store
ephemeral view → client
```

---

## 184. Animation Locks Input

错误：

```text
isAnimating
  → disable pointer
```

正确：

```text
interrupt and retarget from current value
```

---

## 185. Every Event Is a Chat Message

错误：

```text
tool.started
tool.delta
tool.completed
file.changed
...
→ separate message bubbles
```

正确：

```text
aggregate into Tool / Run Card
full detail in Inspector
```

---

## 186. Ambiguous Safety UI

错误：

```text
Continue?
```

正确：

```text
Approve `git push` to `origin/main` once
```

---

## 187. Path as Frontend Resource

错误：

```text
E:\workspace\...
```

作为下载和打开合同。

正确：

```text
artifactId
worktreeId
file reference
```

---

## 188. Static Screenshots as Motion Spec

错误：

```text
design screenshots
then add animation later
```

正确：

```text
interactive prototype
+ motion tokens
+ interruptibility tests
```

---

# Part XXVIII — Global Invariants

## 189. UI Architecture Invariants

AgentOS v2 必须始终满足：

1. UI 是 Runtime Client。
2. UI 不拥有 Run 生命周期。
3. Client Session 不等于 Provider Session。
4. View State 不等于 Domain State。
5. Projection 不等于 Runtime Fact。
6. Browser Disconnect 不取消 Run。
7. Web 是第一交付 Surface。
8. Tauri 是未来 Host，不是新 Runtime。
9. Tauri 复用同一 UI 和 Runtime API。
10. Platform-specific 能力必须经过 Adapter。
11. 页面不得直接依赖 Tauri Global。
12. Agent Identity 不等于 Provider。
13. Conversation 是持久协作入口。
14. Chat 不默认等于 Run。
15. Task 不等于 Run。
16. Run Card 不等于 Run State Source。
17. UI 不解析 stdout 推断 Runtime State。
18. Runtime Event 驱动 Timeline 和 Projection。
19. Realtime 不是唯一数据来源。
20. Reconnect 必须补齐 Durable State。
21. Streaming 必须最终 Finalize 或 Fail。
22. Tool 和 Command 必须结构化展示。
23. Approval 必须由受信组件展示。
24. 模糊文本不得批准 Action。
25. Artifact 以 ID 访问。
26. Secret 不进入普通 Client State。
27. Design Token 是视觉唯一来源。
28. Motion Token 是交互运动唯一来源。
29. Apple-like 不等于 Apple visual copying。
30. Glass 只属于功能层。
31. 内容可读性优先于材质。
32. pointer-down 必须即时反馈。
33. 可触摸对象运动必须可打断。
34. Momentum Motion 必须继承 Velocity。
35. 普通 UI 默认无 Bounce。
36. Spatial Path 必须可预测。
37. Reduced Motion 必须可用。
38. Reduced Transparency 必须可用。
39. Keyboard 必须覆盖核心操作。
40. Focus 必须稳定。
41. Status 不能只靠颜色。
42. 大列表必须分页或虚拟化。
43. Streaming 必须 Batch。
44. Full Runtime Detail 必须渐进披露。
45. Common Path 必须比 Advanced Mode 更明显。
46. UI Error 必须提供恢复动作。
47. Dangerous Action 必须显示真实目标。
48. Panel Layout 必须自适应。
49. Stable Preference 与 Ephemeral State 必须分离。
50. Web UI 完成后移植 Tauri 不应重写 Domain Feature。

---

# Part XXIX — Final Definition

## 190. Final Definition

AgentOS v2 UI Architecture 定义如下：

> AgentOS v2 UI 是一个 Web-first、Desktop-ready 的 AI 工程协作工作台。它以持久 Conversation 作为人与 Agent 的主要协作入口，以 Task / Run Workbench 表达工程意图和执行尝试，以 Runtime Inspector 渐进展示 Provider Session、Process、Worktree、Memory、Policy、Approval、Artifact 和 Runtime Event。界面不拥有 Runtime 生命周期，不直接执行 CLI、Git 或文件操作，而是通过统一 AgentOS API Client、REST、SSE 和 WebSocket 与独立 Server 通信。未来 Tauri Desktop 只作为 Native Host、Platform Adapter 和 Server Sidecar 管理层，不重写 UI 或 Runtime 合同。

设计表达：

```text
Apple Design Engineering
  ≠ Apple visual imitation

Apple Design Engineering
  = immediate feedback
  + direct manipulation
  + interruptible motion
  + spatial continuity
  + restrained material
  + accessibility
  + craft
```

产品结构：

```text
App Shell
├── Navigation Rail
├── Context Sidebar
├── Main Canvas
└── Inspector

Main Experiences
├── Conversation
├── Task / Run Workbench
├── Runtime Inspector
├── Agent History
├── Memory
├── Policy / Approval
└── Settings
```

平台结构：

```text
Now:
  BrowserPlatformAdapter
  + Web UI
  + AgentOS Server

Later:
  TauriPlatformAdapter
  + same Web UI
  + AgentOS Server Sidecar
```

数据结构：

```text
REST
  = durable state and commands

SSE / WebSocket
  = reconnectable realtime updates

Runtime Event
  = execution truth

Conversation Projection
  = user-facing runtime view

Local View State
  = temporary UI behavior

Platform Adapter
  = browser or native host capability
```

本文件定义的 UI Architecture 是 AgentOS v2 Conversation、工程 Workbench、Runtime Inspector、Apple-style interaction system、Web implementation 和未来 Tauri Desktop Migration 的统一产品与前端架构基础。

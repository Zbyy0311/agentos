# AgentOS Runtime Specification v2.0

## 00 — Vision

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Runtime  
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的产品愿景、系统边界、核心目标、非目标、设计原则与长期方向。

它不是功能清单，也不是实现计划，而是 AgentOS v2 后续架构设计与开发决策的最高层依据。

当以下内容发生冲突时，应优先遵循本文件：

1. 产品定位；
2. Runtime 核心抽象；
3. Provider 接入方式；
4. 多 Agent 协作方式；
5. 权限、隔离和安全策略；
6. 数据模型与可观测性设计；
7. UI 与交互方向；
8. 后续功能取舍。

AgentOS v2 的所有模块都必须能够回答一个问题：

> 这个模块是否在加强“统一管理异构 AI Coding Agent 的工程运行时”这一核心定位？

如果答案是否定的，该模块不应成为 AgentOS v2 的核心能力。

---

## 2. Why AgentOS

AI Coding Agent 正在快速发展。

Codex、Claude Code、KimiCode、OpenCode、Gemini CLI 以及未来更多 Coding Agent，正在逐步具备：

- 自主理解任务；
- 拆分任务；
- 调用工具；
- 修改代码；
- 运行命令；
- 创建子 Agent；
- 执行测试；
- Review 代码；
- 维护当前会话上下文。

这意味着，“让一个 Agent 再调用多个子 Agent”正在成为 Provider 自身的基础能力。

AgentOS 不应该与这些 Provider 竞争推理能力，也不应该试图重新实现它们已经具备的内部 Agent 能力。

真正没有被统一解决的问题是：

- 不同 Provider 的运行方式不一致；
- 不同 Agent 的 Session、历史与上下文彼此隔离；
- 多个 Agent 修改同一仓库时容易互相污染；
- 执行过程缺少统一事件模型；
- 工具调用、命令、文件变更和子 Agent 活动难以统一观察；
- 任务、执行尝试、结果和产物缺少持久化关系；
- Agent 权限通常依赖 Provider 自身设置或 Prompt 约束；
- 跨 Provider 的审批、审计、回放和故障恢复缺乏统一实现；
- 项目级长期记忆分散在不同会话、不同 Provider 和不同文件中；
- 用户无法在同一个系统内持续管理一个长期存在的 AI 工程团队。

AgentOS 的存在价值，就是解决这些 Provider 之上的 Runtime 问题。

---

## 3. Product Vision

AgentOS v2 的愿景是：

> 成为一个面向长期 AI 工程团队的、Provider 无关的本地优先运行时。

AgentOS 将 Codex、Claude Code、KimiCode、OpenCode、Gemini CLI、本地模型、远程 Agent 和自定义 CLI 视为不同的 Runtime Provider。

AgentOS 不关心哪个 Provider 最聪明，也不强制所有 Provider 使用同一种推理方式。

AgentOS 负责统一管理：

- Workspace；
- Agent Identity；
- Provider；
- Conversation；
- Task；
- Run；
- Stage；
- Runtime Event；
- Process；
- Worktree；
- Memory；
- Artifact；
- Policy；
- Approval；
- Metrics；
- Replay。

最终，用户看到的不再是多个互不关联的 CLI，而是一个长期存在、可管理、可观察、可审计、可恢复的 AI 工程团队。

---

## 4. One-Line Positioning

> AgentOS 是一个统一管理不同 AI Coding Agent 的工程运行时，而不是另一个 Coding Agent。

英文定位：

> AgentOS is a provider-agnostic runtime for persistent AI engineering teams.

---

## 5. Product Definition

AgentOS v2 的产品交付策略是 Web-first、Desktop-ready。

### 5.1 Product Surface Strategy

#### 5.1.1 当前交付 Surface

```text
第一交付 Surface：
  Web UI
  独立 AgentOS Server
  REST / SSE / WebSocket 通信

Web UI 功能范围：
  App Shell、Conversation、Task / Run Workbench、
  Runtime Inspector、Memory、Policy、Approval、
  Provider Settings、Artifact Viewer
```

#### 5.1.2 未来 Desktop 策略

未来 Tauri Desktop 只作为：

```text
Desktop Host：
  Window Lifecycle、Native Menu、Tray、File Dialog、
  Native Notification、Global Shortcut、Auto Update、
  Platform Adapter、Server Sidecar Lifecycle

Tauri 不替代 AgentOS Runtime。
Tauri 不重写 REST、SSE、WebSocket 和领域 UI。
```

> Tauri 是 Desktop Host，不是新的 Runtime。  
> Tauri 复用相同的 Web UI、API Client、Design Token、Domain Components 和 Runtime Transport。

#### 5.1.3 Next.js 约束

现有 Next.js 前端可以保留，但必须满足以下条件：

1. Runtime-critical 逻辑全部位于独立 AgentOS Server。
2. 不依赖 Next.js API Route 承载 Runtime。
3. 核心页面保持 Client-side 或 Static-host compatible。
4. API Base URL 可配置。
5. 构建产物可适配 Tauri WebView。

### 5.2 AgentOS 是什么

AgentOS 是：

- 一个本地优先的 AI 工程运行时；
- 一个异构 Coding Agent 的统一控制平面；
- 一个长期项目状态管理系统；
- 一个面向 Agent 执行过程的事件平台；
- 一个支持人工审批与工程隔离的执行系统；
- 一个跨 Provider 的协作与可观测性平台；
- 一个能够管理多个 Workspace、Agent、Conversation、Task 和 Run 的工程系统。

### 5.3 AgentOS 不是什么

AgentOS 不是：

- Codex、Claude Code、KimiCode 或 OpenCode 的替代品；
- 只会按固定顺序执行多个 Prompt 的流水线；
- 单纯的多 Agent 聊天界面；
- 单纯的任务看板；
- 单纯的 CLI 包装器；
- 单纯的 Prompt 编排框架；
- IDE 的替代品；
- 只服务于某一家模型或 Provider 的产品；
- 依靠 Prompt 约束安全行为的系统；
- 将所有 Agent 放在同一个目录中并行修改代码的执行器。

---

## 6. Core Problem Statement

AgentOS v2 解决的核心问题是：

> 当用户同时使用多个 AI Coding Agent 时，如何统一管理它们的身份、执行、上下文、权限、隔离、状态、记忆、产物与历史？

该问题可拆分为以下子问题。

### 6.1 Provider Fragmentation

每个 Provider 都有不同的：

- CLI 参数；
- 登录方式；
- Session 机制；
- 流式输出格式；
- 工具事件格式；
- 取消方式；
- 权限模型；
- 子 Agent 模型；
- 错误格式；
- Token 与成本统计方式。

AgentOS 必须通过 Provider Adapter 层将这些差异隔离。

### 6.2 Execution Fragmentation

一次任务可能经历：

- 多次失败；
- 多次重试；
- 多 Provider 对比；
- 中途暂停；
- 人工审批；
- 从某个阶段恢复；
- 切换 Agent；
- 切换 Worktree；
- Review 后返工。

因此，Task 不能等同于一次执行。

AgentOS 必须区分：

```text
Task
└── Run
    └── Stage
        └── Runtime Event
```

### 6.3 State Fragmentation

长期项目状态不能只存在于：

- 当前聊天窗口；
- Provider 自身 Session；
- 临时 Prompt；
- 某个 Markdown 文件；
- 某次 CLI 输出。

AgentOS 必须持久化：

- 项目决策；
- Agent 历史；
- 失败经验；
- Review 结论；
- 测试知识；
- 运行记录；
- 产物；
- 审批；
- Provider Session 信息。

### 6.4 Isolation Fragmentation

多个 Agent 直接在同一个仓库目录中工作，会导致：

- 修改相互覆盖；
- Review Agent 直接改变 Worker 结果；
- 并发任务冲突；
- 难以区分每个 Agent 的产物；
- 无法安全回滚；
- 难以合并与审计。

AgentOS 必须将 Worktree 作为修改型 Run 的默认隔离单位。

### 6.5 Observability Fragmentation

用户不能只看到最终文本。

用户应能够看到：

- 当前由哪个 Agent 执行；
- 使用哪个 Provider；
- 启动了什么进程；
- 调用了什么工具；
- 执行了什么命令；
- 读取和修改了哪些文件；
- 产生了什么 Patch；
- 创建了哪些子 Agent；
- 消耗了多少时间和 Token；
- 在哪里等待审批；
- 为什么失败；
- 如何恢复。

AgentOS 必须以 Runtime Event 作为执行过程的统一语言。

### 6.6 Safety Fragmentation

高风险行为不能只依赖：

- Provider 默认权限；
- Prompt 中的“不要这样做”；
- 用户事后检查；
- `--dangerously-bypass-approvals-and-sandbox`。

AgentOS 必须在 Runtime 层实现：

- Policy；
- Approval；
- Worktree；
- Path Boundary；
- Secret Boundary；
- Command Boundary；
- Process Lifecycle；
- Audit Log。

---

## 7. Primary Users

### 7.1 独立开发者

同时使用多个 Coding Agent，希望：

- 比较不同 Provider；
- 管理多个项目；
- 保留完整执行历史；
- 减少重复解释项目背景；
- 控制高风险操作；
- 查看 Agent 真实做了什么。

### 7.2 AI Native Developer

希望将 AI Coding Agent 作为长期工程团队成员，而不是一次性工具。

关注：

- Agent Identity；
- 长期记忆；
- 会话；
- 任务分配；
- Worktree；
- Review；
- 自动化与人工介入。

### 7.3 小型团队

希望统一管理：

- 多人共享的 Agent 配置；
- 多个项目；
- 任务和 Run；
- 审批；
- 产物；
- Provider 成本；
- 执行审计。

### 7.4 Agent Framework Developer

希望通过 AgentOS 的 Provider Adapter、Runtime Event 和 Extension SDK 接入：

- 新 Provider；
- 自定义 CLI；
- 本地模型；
- 远程 Agent；
- 内部工具链。

---

## 8. Primary User Experience

理想状态下，用户可以：

1. 创建或导入一个 Workspace；
2. 配置 Codex、KimiCode、OpenCode、Claude Code 等 Provider；
3. 创建长期 Agent Identity，例如“架构师”“后端工程师”“Reviewer”；
4. 与某个 Agent 私聊，或创建多 Agent 群聊；
5. 在聊天中提出需求；
6. 将消息转换为 Task；
7. 为 Task 创建一个 Run；
8. 选择单 Agent、固定 Workflow 或动态 Planner；
9. 在独立 Worktree 中执行；
10. 实时查看 Runtime Timeline；
11. 在高风险操作前进行审批；
12. 查看代码 Diff、测试报告和 Artifact；
13. Review 后决定合并、返工或放弃；
14. 将执行结论沉淀为 Memory；
15. 在未来会话和 Run 中继续使用这些 Memory；
16. 回放任意历史 Run；
17. 对比不同 Provider 的结果、耗时和失败原因。

---

## 9. Goals

### 9.1 Provider-Agnostic Runtime

AgentOS 必须支持不同 Provider，而不将系统核心绑定在某个 CLI 或模型上。

目标包括：

- 统一 Provider 生命周期；
- 统一执行输入；
- 统一取消；
- 统一事件；
- 统一错误；
- 统一 Session；
- 统一能力声明；
- 统一运行记录。

### 9.2 Persistent AI Team

Agent 应是长期存在的身份，而不是一次 Prompt 调用。

Agent 应拥有：

- 名称；
- 角色；
- Provider 配置；
- 能力；
- 历史；
- Memory Scope；
- Conversation；
- Run 记录；
- 可切换 Provider。

### 9.3 Durable Execution Model

所有执行都必须围绕以下关系建模：

```text
Workspace
├── Conversation
├── Task
│   └── Run
│       ├── Stage
│       ├── Runtime Event
│       ├── Process
│       ├── Worktree
│       ├── Artifact
│       └── Approval
├── Agent
├── Memory
└── Policy
```

### 9.4 Runtime Observability

所有重要执行行为都必须可观察、可查询、可回放。

### 9.5 Safe Isolation

修改型 Run 默认进入独立 Worktree。

高风险操作必须经过 Policy 判断，必要时进入 Approval。

### 9.6 Long-Term Memory

Memory 必须支持：

- 多作用域；
- 检索；
- 来源追踪；
- 重要度；
- 去重；
- 摘要；
- 结构化沉淀；
- Prompt 注入预算。

### 9.7 Human-in-the-Loop

用户必须能够：

- 暂停；
- 继续；
- 取消；
- 审批；
- 拒绝；
- 修改请求；
- 改派 Agent；
- 切换 Provider；
- 从失败 Run 重试；
- 决定是否合并。

### 9.8 Incremental Evolution

AgentOS v2 必须基于现有项目增量演进，而不是推倒重写。

---

## 10. Non-Goals

### 10.1 不构建更聪明的基础模型

AgentOS 不训练模型，不与 Provider 比较推理能力。

### 10.2 不复制 Provider 内部 Subagent

Provider 已经具备的子 Agent 能力，应被视为 Provider 的内部能力。

AgentOS 只记录和管理 Provider 暴露出的 Subagent Event。

### 10.3 不强制所有 Provider 使用相同 Prompt

统一 Runtime 不等于统一推理提示词。

每个 Provider Adapter 可以采用不同执行协议。

### 10.4 不在 v2 初期构建复杂自治组织

v2 初期不追求：

- 无限 Agent 自主对话；
- 无人工控制的长期自治；
- 自我复制 Agent；
- 高复杂度组织政治；
- 无边界自我规划。

### 10.5 不在 v2 初期构建插件市场

先建立稳定的内部扩展边界，再考虑市场和生态。

### 10.6 不将向量数据库作为第一阶段依赖

Memory v2 第一阶段优先采用：

- SQLite；
- FTS5；
- 标签；
- Scope；
- Importance；
- Recency。

Embedding 可作为后续增强。

### 10.7 不默认允许危险权限

v2 不应以绕过审批和沙箱作为默认配置。

---

## 11. Design Principles

### 11.1 Runtime Over Orchestration

AgentOS 的核心不是“如何写更复杂的多 Agent Prompt”，而是“如何可靠运行和管理 Agent”。

### 11.2 Provider Intelligence Stays in Providers

Provider 负责：

- 推理；
- 编码；
- 原生工具；
- 原生子 Agent；
- Provider 特定优化。

AgentOS 负责：

- 生命周期；
- 状态；
- 隔离；
- 事件；
- 权限；
- 审计；
- Memory；
- Collaboration；
- Observability。

### 11.3 Task Is Not Run

Task 描述要做什么。

Run 描述某一次如何执行。

所有 Retry 必须创建新 Run，不覆盖旧 Run。

### 11.4 Events Are the Runtime Language

UI、Timeline、Metrics、Memory、Artifact、Approval 和 Replay 都应基于 Runtime Event。

不允许将 stdout 字符串作为唯一系统事实。

### 11.5 Agent Is Not Provider

“后端工程师”是 Agent Identity。

“KimiCode”是 Provider。

同一个 Agent 可以在不同 Run 中切换 Provider。

### 11.6 Policy Is Code

安全规则必须由 Runtime 执行。

Prompt 规则只能作为行为指导，不能作为唯一安全边界。

### 11.7 Isolation by Default

修改型 Run 默认使用 Worktree。

主工作目录不应成为并发 Agent 的共享修改区。

### 11.8 Durable Before Clever

优先保证：

- 数据不丢失；
- Run 可查询；
- Event 可回放；
- 进程可取消；
- Worktree 可清理；
- 错误可诊断。

再考虑更复杂的自治与 Planner。

### 11.9 Local-First

AgentOS 首先服务本地开发环境。

用户应能知道：

- 数据存在哪里；
- 哪个进程在运行；
- 哪些文件被修改；
- 哪些 Secret 被使用；
- 哪些网络访问被允许。

### 11.10 Inspectability

系统的每一个关键决策都应可解释：

- 谁发起；
- 谁执行；
- 使用什么 Provider；
- 基于哪些 Memory；
- 执行了什么；
- 为什么被阻止；
- 为什么失败；
- 如何恢复。

### 11.11 Incremental Migration

现有可工作的功能应通过兼容层逐步迁移。

不因追求架构纯度而一次性破坏现有流程。

### 11.12 Open Extension Boundary

核心模块应采用可替换接口：

- Provider Adapter；
- Policy Rule；
- Memory Retriever；
- Artifact Processor；
- Workflow；
- Event Processor。

---

## 12. Product Boundaries

### 12.1 AgentOS Owns

AgentOS 负责：

- Workspace Lifecycle；
- Agent Identity；
- Provider Configuration；
- Conversation；
- Task；
- Run；
- Stage；
- Runtime Event；
- Process Lifecycle；
- Worktree Isolation；
- Memory；
- Artifact；
- Policy；
- Approval；
- Metrics；
- Replay；
- Runtime Inspector。

### 12.2 Provider Owns

Provider 负责：

- 模型推理；
- Provider 原生 Prompt 处理；
- 原生工具调用；
- 原生 Session；
- 原生子 Agent；
- Provider 内部规划；
- Provider 特定输出；
- Provider 特定模型选择。

### 12.3 Git Owns

Git 负责：

- Commit；
- Branch；
- Diff；
- Merge；
- Worktree 基础能力。

AgentOS 负责管理 Git 生命周期和策略，不重新实现 Git。

### 12.4 User Owns

用户最终拥有：

- 是否批准高风险操作；
- 是否合并；
- 是否保留 Artifact；
- 是否接受 Agent 结论；
- 是否允许某个 Provider；
- 是否启用不安全模式。

---

## 13. Core Differentiation

### 13.1 与单一 Coding Agent 的区别

单一 Coding Agent 解决：

> 如何完成当前编码任务。

AgentOS 解决：

> 如何长期管理多个不同 Coding Agent 的工程执行。

### 13.2 与 Provider Subagent 的区别

Provider Subagent 通常：

- 属于单一 Provider；
- 服务当前 Session；
- 生命周期短；
- 由 Provider 内部管理；
- 事件和状态不可跨 Provider 统一。

AgentOS：

- 管理不同 Provider；
- 持久化 Agent Identity；
- 管理长期 Workspace；
- 管理 Task 与 Run；
- 统一事件与权限；
- 提供 Worktree、Approval、Replay 和 Memory。

### 13.3 与 IDE 的区别

IDE 主要管理：

- 编辑器；
- 文件；
- 调试；
- 插件；
- 人工开发界面。

AgentOS 主要管理：

- Agent；
- Provider；
- Run；
- Process；
- Worktree；
- Event；
- Approval；
- Memory；
- Artifact。

AgentOS 可以与 IDE 并存。

### 13.4 与通用 Workflow Engine 的区别

通用 Workflow Engine 管理固定步骤和任务队列。

AgentOS 额外理解：

- Provider Session；
- Agent Identity；
- Runtime Event；
- Tool Call；
- File Change；
- Git Worktree；
- Prompt Context；
- Memory；
- Approval；
- Artifact。

---

## 14. Success Criteria

AgentOS v2 的成功不以“支持多少 Agent”衡量，而以以下指标衡量。

### 14.1 Runtime Reliability

- Run 状态不会因页面刷新丢失；
- Server 重启后能够识别未完成 Run；
- Cancel 能可靠终止完整进程树；
- Event 顺序可恢复；
- Worktree 不会长期泄漏；
- Retry 不覆盖历史结果。

### 14.2 Provider Independence

- 新 Provider 可通过 Adapter 接入；
- 核心 Run Engine 不包含 Provider 特定逻辑；
- KimiCode 不再通过 OpenCode 伪装调用；
- Agent Identity 与 Provider Config 分离。

### 14.3 Observability

用户能够查看：

- Run Timeline；
- Provider；
- Agent；
- Process；
- Tool；
- Command；
- File；
- Patch；
- Approval；
- Artifact；
- Usage；
- Error。

### 14.4 Safety

- 修改型 Run 默认使用 Worktree；
- 危险操作进入 Approval；
- Secret 不被默认写入日志；
- 不默认启用危险绕过参数；
- 所有审批有审计记录。

### 14.5 Memory Quality

- 不再把全部 Markdown 无差别注入 Prompt；
- Memory 有 Scope 和 Source；
- Run 结束后可生成结构化 Memory；
- 用户可查看 Memory 被何时检索和使用。

### 14.6 Product Coherence

Conversation、Task、Run、Event 和 Artifact 必须形成完整闭环。

用户不需要在多个互不关联的页面中手动拼接执行过程。

---

## 15. v2 Foundation Scope

AgentOS v2 Foundation 必须优先完成：

1. SQLite 作为主存储；
2. Task 与 Run 分离；
3. Runtime Event；
4. Provider Adapter；
5. KimiCode 直接调用；
6. Process Manager；
7. 可靠取消；
8. 基础 Worktree；
9. Run Timeline；
10. v1 兼容迁移。

以下内容不属于 Foundation 首要范围：

- 完整群聊自治；
- 插件市场；
- 高级向量检索；
- 云端多租户；
- 移动端；
- 复杂 RBAC；
- 大规模分布式调度。

---

## 16. Migration Philosophy

AgentOS v2 不进行整仓推倒重写。

采用渐进式替换策略：

```text
Existing v1 Flow
    ↓
Compatibility Layer
    ↓
New Run + Event + Provider Runtime
    ↓
Old Pipeline Converted to Workflow Template
    ↓
JSON Storage Retired
```

### 16.1 可直接保留

- Monorepo；
- Next.js 前端（Runtime 逻辑不在 Next.js 中）
- Express Server；
- Workspace UI；
- SSE 基础；
- CLI 命令发现；
- Mock 模式；
- Git Diff；
- 基础日志；
- 任务创建流程。

### 16.2 需要架构级重构

- Task 数据模型；
- AgentRunner；
- CLIExecutor；
- Provider 配置；
- 存储层；
- Runtime 输出；
- 取消和超时；
- Memory 注入；
- Pipeline 表达。

### 16.3 应废弃的核心假设

- Task 等于一次执行；
- KimiCode 等于 OpenCode + Kimi 模型；
- stdout 等于 Runtime Event；
- Prompt 规则等于安全策略；
- 所有 Agent 共用一个工作目录；
- 固定四阶段等于 Runtime；
- 所有 Memory 都应注入每个 Prompt。

---

## 17. Long-Term Direction

AgentOS 的长期方向不是构建一个更强的单体 Agent。

它应逐步成为：

- 本地 AI 工程控制平面；
- 多 Provider Runtime；
- 持久 AI Team Manager；
- Agent 执行审计系统；
- Agent Worktree 与 Merge 系统；
- Agent Memory 系统；
- 人工审批中心；
- Runtime Inspector；
- Agent Provider 扩展平台。

未来，无论某个 Provider 是否新增：

- 更强推理；
- 更多子 Agent；
- 更长上下文；
- 更复杂工具；
- 更强代码能力；

AgentOS 的价值都不应因此消失。

因为 AgentOS 管理的是 Provider 之上的工程运行时。

---

## 18. Vision Statement

AgentOS v2 的最终愿景是：

> 用户可以像管理一个真实工程团队一样管理 AI Agent：为它们分配角色、选择 Provider、创建任务、观察执行、控制权限、隔离代码、审查产物、保留记忆，并在任何时候回放、恢复或重新运行整个工程过程。

AgentOS 不决定哪个 Agent 最聪明。

AgentOS 确保所有 Agent 都能够在一个统一、持久、安全、透明且可管理的工程环境中工作。

---

## 19. Decision Rule

后续任何功能、模块或架构提案，都应通过以下检查：

1. 是否加强跨 Provider 管理？
2. 是否加强长期状态？
3. 是否加强执行可靠性？
4. 是否加强隔离与安全？
5. 是否加强可观测性？
6. 是否加强人工控制？
7. 是否减少 Provider 耦合？
8. 是否可以通过 Runtime Event 表达？
9. 是否能被持久化和回放？
10. 是否属于 AgentOS，而不是 Provider 自身应负责的能力？

如果大部分答案是否定的，该能力不应进入 AgentOS v2 核心。

---

## 20. Final Definition

AgentOS v2 定义如下：

> AgentOS is a local-first, provider-agnostic engineering runtime that manages persistent AI agents, conversations, tasks, runs, events, processes, worktrees, memory, artifacts, policies, approvals, and execution history across heterogeneous coding-agent providers.

中文定义：

> AgentOS 是一个本地优先、Provider 无关的 AI 工程运行时，用于统一管理异构 Coding Agent 的长期身份、会话、任务、执行、事件、进程、Worktree、记忆、产物、权限、审批与历史。

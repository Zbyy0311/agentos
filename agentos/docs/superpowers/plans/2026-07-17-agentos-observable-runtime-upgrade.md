# AgentOS Codex-first 可观察运行时升级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先把一个 Codex Agent 做到可实时逐字输出、可查看结构化工具轨迹、可交付文件/差异/报告/图片/日志 Artifact、可回放执行档案并通过真实浏览器验收；在此闭环完成前不实现 KimiCode/OpenCode Adapter，也不推进新的多 Agent 编排能力。

**Architecture:** 保留 `CLIExecutor -> ConversationAgentRunner -> ConversationService -> RunStreamRegistry -> SSE -> React` 主链路，只增加 Codex Adapter，将 `codex exec --json` JSONL 转成统一 `NormalizedCliEvent`。服务端复用现有 RunFileChange、CLI 调用记录和 AgentEvent，再由 `RuntimeArtifactService` 把可验证产物保存为 SQLite 元数据与 AgentOS 托管的不可变快照；前端渲染文字、工具卡和 Artifact Shelf。“逐字出现”由前端按 Unicode 字素平滑播放。Adapter 接口保持可扩展，但当前实现和真实 Gate 只覆盖 Codex。

**Tech Stack:** Node.js >= 22.5、TypeScript、Express、`node:sqlite`、Next.js 14、React 18、SSE、Vitest、Node Test Runner、PowerShell、pnpm workspace。

## 本轮执行状态（2026-07-17）

- Task 1-9：已完成并通过对应单元测试、构建和回归检查。
- Task 10.1：已完成；隔离服务器 fixture gate 通过，覆盖 SSE、tool 配对、Artifact、内容路由和 cursor 回放。
- Task 10.2：已完成；WindowsApps 入口本身不可直接启动，但同版本 CLI 与 code-mode host 的临时可执行副本探测通过。
- Task 10.3：已完成；真实 AgentOS + Codex 受控写入任务通过，产生 file/diff/report/log Artifact 且 `npm test` 通过。
- Task 10.4：已完成隔离 fixture 的真实浏览器验收；聊天 Artifact Shelf、工具时间线、RunDetails、刷新回放、深浅色、1280/1440px 和 console 结果均已检查。
- Task 10.5：确定性 fixture、全量测试、构建、生产验收和真实 Codex Gate 均通过；Windows fixture 使用 `cmd.exe /d /s /c npm test`，避免 `spawnSync('npm.cmd')` 的 EINVAL。
- Task 10.6：验收文档、恢复命令、回滚边界和 KimiCode/OpenCode 后续独立计划已更新。

> **执行状态更新（2026-07-17）**：Task 1-9、Task 10.1-10.3、Task 10.5-10.6 已通过对应自动化验收；真实 Codex Gate 已使用临时可执行副本通过（Codex 0.144.0-alpha.4）。本轮补齐了 Task 10.4 的最终聊天 Artifact Shelf 接入：发送完成后从 Run Details 加载 file/diff/report/image/log artifacts，切换会话时清空旧状态。仍未执行 KimiCode/OpenCode 真实 Gate，符合本计划的硬边界。

## Global Constraints

- 默认中文 UI、文档和用户可见错误；新增文本使用 UTF-8 无 BOM。
- 不重写现有系统，不引入 WebSocket、Redis、Kafka、向量数据库或新的模型 SDK。
- SSE 继续负责 Server -> Web；发送、取消、恢复继续使用 HTTP。
- 不记录或展示模型私有思维链；reasoning 只映射为“正在分析”等公开状态。
- 工具事件只来自 Codex JSONL；纯文本降级不靠正则伪造工具轨迹。
- 工具参数、结果、stderr 和诊断进入 UI/SQLite 前脱敏并限长；raw JSONL 不持久化。
- Artifact 元数据写入 SQLite；内容快照保存到 `AGENTOS_PROJECT_ROOT/.agentos/artifacts/`，不得只引用会继续变化的工作区绝对路径。
- Artifact 快照创建后不可覆盖；内容下载必须做 workspace 归属、realpath、MIME、大小和响应头校验。
- 兼容现有 SQLite、Conversation、Execution、Run、Event、群聊和 `agent-memory/`。
- 保持 `onChunk`、Mock 模式、Task Pipeline 和未适配 CLI 的纯文本行为可用。
- 每个任务先写失败测试，再最小实现，再跑局部和阶段回归；每阶段独立提交。
- 当前工作区已有未提交 Streaming/UI 变更；执行前先单独完成、审查或撤回，不得覆盖。
- **目标代码基线：本计划针对 `codex/agentos-current` 分支的 v2 源码。当前 `main`（`3d0a763`）缺少 ConversationService/SqliteStore/RunDetails 源码；执行前必须切换到 `codex/agentos-current` 或先把该分支合入目标分支。**
- **Codex 硬闸门：Task 1-10 未全部验收前，不创建 KimiCode/OpenCode Adapter，不增加三 CLI 联合 Gate，不新增群聊编排或 worktree 功能。**

---

## 0. 当前基线与方案边界

### 已存在，禁止重复建设

- `AgentRun`、`AgentExecution`、`ExecutionEvent`、`AgentEvent`。
- SQLite 运行档案、`EventBus`、`RunDetails`、CLI 元数据、Git 文件变化。
- `RunStreamRegistry`、SSE 心跳、cursor 重连、取消与服务重启恢复。
- Conversation chunk 累加链路；`2026-07-16-conversation-streaming.md` 正在补齐逐 chunk 转发。
- 群聊、项目记忆、FTS5 检索、记忆注入和候选审核。

### 方案选择

1. 纯文本解析只能做回复流，不能可靠还原工具调用，保留为降级。
2. 当前只实现 Codex `exec --json` Adapter，完成 Streaming + Tool Timeline + 历史回放 + 真实 Gate。
3. KimiCode/OpenCode 必须在 Codex Gate 后分别建立独立计划、fixture、版本矩阵和真实 Gate，不能复制未稳定的抽象。

### 当前计划里程碑

| 里程碑 | 任务 | 交付结果 |
|---|---:|---|
| M0 Streaming 基线 | 1 | 普通回复真正按 chunk 到达，回归入口稳定 |
| M1 Codex Protocol | 2-4 | Codex JSONL fixture 可稳定转换为统一事件 |
| M2 Codex Runtime Output | 5-7 | Codex 事件可持久化，并形成不可变 RuntimeArtifact |
| M3 Codex Experience | 8-9 | Codex 文字、工具、Artifact 实时显示和回放 |
| M4 Codex Real Gate | 10 | 一个真实 Codex 完成自动化、浏览器、安全、Artifact 和历史验收 |

---

## 文件结构锁定

### 新增文件

```text
packages/agent-core/src/adapters/
  types.ts
  jsonLineDecoder.ts
  registry.ts
  capabilityProbe.ts
  plainTextAdapter.ts
  codexAdapter.ts
  redaction.ts
  fixtures/codex-basic.jsonl
apps/server/src/services/RuntimeEventProjector.ts
apps/server/src/services/RuntimeArtifactService.ts
apps/server/src/services/RuntimeArtifactCollector.ts
apps/server/src/routes/artifacts.ts
apps/web/scripts/run-tests.mjs
apps/web/src/lib/typewriterQueue.ts
apps/web/src/lib/runtimeEvents.ts
apps/web/src/lib/artifacts.ts
apps/web/src/components/runtime/RuntimeEventFeed.tsx
apps/web/src/components/runtime/ToolEventCard.tsx
apps/web/src/components/runtime/CurrentAction.tsx
apps/web/src/components/artifacts/ArtifactShelf.tsx
apps/web/src/components/artifacts/ArtifactCard.tsx
scripts/verify-codex-runtime-e2e.mjs
scripts/verify-codex-runtime-e2e.ps1
docs/acceptance/codex-runtime-baseline.md
docs/acceptance/codex-runtime-final.md
```

### 主要修改文件

```text
packages/shared/src/types/index.ts
packages/agent-core/src/index.ts
packages/agent-core/src/executor.ts
packages/agent-core/src/executor.test.ts
packages/agent-core/src/conversationRunner.ts
packages/agent-core/src/conversationRunner.test.ts
packages/agent-core/src/config.ts
apps/server/src/services/ConversationService.ts
apps/server/src/services/ConversationService.test.ts
apps/server/src/services/RunStreamRegistry.ts
apps/server/src/routes/conversations.ts
apps/server/src/routes/runs.ts
apps/server/src/index.ts
apps/server/src/store/SqliteStore.ts
apps/web/src/app/workspace/[id]/page.tsx
apps/web/src/components/chat/ChatPanel.tsx
apps/web/src/components/chat/ExecutionInspector.tsx
apps/web/src/components/runs/RunDetails.tsx
apps/web/package.json
README.md
docs/AGENTOS_V2.md
```

---

## Task 1：关闭现有 Streaming 前置工作并冻结 Codex 基线

**Files:**
- Verify/finish: `packages/agent-core/src/conversationRunner.ts`
- Verify/finish: `packages/agent-core/src/conversationRunner.test.ts`
- Reference: `docs/superpowers/plans/2026-07-16-conversation-streaming.md`
- Create: `docs/acceptance/codex-runtime-baseline.md`
- Modify: `README.md`

**Interfaces:** 不增加新接口；确认 `onChunk(text, done)` 按 chunk 产生 `streaming_response`，waiting marker 不泄漏。

- [ ] **Step 1.0：确认执行分支具有 v2 源码**

```powershell
git branch --show-current
git rev-parse HEAD
Test-Path apps/server/src/services/ConversationService.ts
Test-Path apps/server/src/store/SqliteStore.ts
Test-Path apps/web/src/components/runs/RunDetails.tsx
```

预期三个路径均为 `True`。若当前仍是旧 `main`，停止执行；切换/合并分支属于单独的 Git 决策，不能在本计划中静默完成。

- [ ] **Step 1.1：记录并隔离当前改动**

```powershell
git status --short
git diff -- packages/agent-core/src/conversationRunner.ts packages/agent-core/src/conversationRunner.test.ts
```

记录分支、HEAD、未提交文件和 streaming 变更归属。前置改动未完成时不开始 Task 2。

- [ ] **Step 1.2：完成 Streaming 测试闭环**

测试普通两段输出、空 done、跨 chunk waiting marker：

```powershell
pnpm --filter @agentos/agent-core test -- conversationRunner.test.ts
```

预期普通回复产生两条独立事件；waiting_user 场景产生零条普通文字事件。

- [ ] **Step 1.3：冻结全仓基线**

```powershell
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server test
pnpm --filter @agentos/web build
pnpm -r run build
```

记录时间、退出码和测试数量；既有失败必须先处理或明确登记。

- [ ] **Step 1.4：验证 Codex 可执行入口**

记录 `Get-Command codex`、实际路径、版本、`codex exec --help` 和登录可用性。WindowsApps 若 Access denied，先通过 `AGENTOS_CODEX_CLI` 指向可执行入口；没有可执行 Codex 时只能完成 fixture 阶段，不能通过 Task 10。

### 检测与验收

- Streaming 三类测试通过；四条基线命令退出 `0` 或 baseline 明确记录既有失败。
- 执行分支包含 v2 的 ConversationService、SqliteStore、RunDetails 源码；不得以 `dist/` 残留文件替代源码。
- baseline 只对 Codex 给出 VERIFIED/UNAVAILABLE/FAIL；KimiCode/OpenCode 标记为“本阶段不验证”。
- README 的 Node 要求与根 `package.json` 的 `>=22.5` 一致。
- Streaming 使用独立提交，不与 Adapter 混合。

**建议提交：** `fix: stream conversation output incrementally`

---

## Task 2：建立 Web 测试入口与最小运行时协议

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/scripts/run-tests.mjs`
- Modify: `packages/shared/src/types/index.ts`
- Create: `packages/agent-core/src/adapters/types.ts`
- Create: `packages/agent-core/src/adapters/types.test.ts`
- Modify: `packages/agent-core/src/index.ts`

**Interfaces:**

```ts
export type CliProvider = 'codex' | 'plain';
export type NormalizedCliEvent =
  | { type: 'status'; phase: 'starting' | 'thinking' | 'working' | 'finalizing'; label: string }
  | { type: 'assistant.message'; text: string; messageId?: string }
  | { type: 'tool.started'; callId: string; toolName: string; summary: string; inputPreview?: string }
  | { type: 'tool.completed'; callId: string; toolName: string; success: boolean; summary: string; outputPreview?: string; durationMs?: number }
  | { type: 'usage'; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
  | { type: 'diagnostic'; level: 'warning' | 'error'; code: string; message: string };
export interface CliEventParser {
  push(chunk: string): NormalizedCliEvent[];
  finish(): NormalizedCliEvent[];
}
export interface AgentCliAdapter {
  readonly provider: CliProvider;
  matches(command: string): boolean;
  supportsStructuredOutput(helpText: string): boolean;
  decorateArgs(args: readonly string[]): string[];
  createParser(): CliEventParser;
}
```

- [ ] **Step 2.1：建立非空跑 Web 测试入口**

`run-tests.mjs` 递归收集 `src/**/*.test.ts(x)`，以 `node --import tsx --test` 执行并返回真实退出码；web package 增加 `tsx` devDependency 和 `test` script。

- [ ] **Step 2.2：写判别联合失败测试**

使用 `switch (event.type)` 和 `const unreachable: never = event` 验证 payload 穷尽匹配。

- [ ] **Step 2.3：锁定边界**

`NormalizedCliEvent` 只在 agent-core 内流转；Web 只消费投影后的公开 `AgentEvent`。当前 provider union 不预注册 Kimi/OpenCode。

### 检测与验收

- `pnpm --filter @agentos/web test` 确实执行已有测试且退出 `0`。
- `pnpm --filter @agentos/agent-core test -- adapters/types.test.ts` 退出 `0`。
- shared/web build 通过。
- shared/server 无新增 reasoning 文本持久化字段。

**建议提交：** `feat: define codex runtime events`

---

## Task 3：实现 JSONL framing、脱敏和 plain 降级

**Files:**
- Create/Test: `packages/agent-core/src/adapters/jsonLineDecoder.ts`
- Create/Test: `packages/agent-core/src/adapters/redaction.ts`
- Create/Test: `packages/agent-core/src/adapters/plainTextAdapter.ts`

**Interfaces:**

```ts
export type DecodedJsonLine =
  | { ok: true; value: unknown }
  | { ok: false; raw: string; error: string };
export class JsonLineDecoder {
  constructor(private readonly maxLineBytes = 1024 * 1024) {}
  push(chunk: string): DecodedJsonLine[];
  finish(): DecodedJsonLine[];
}
export function redactRuntimeText(value: string, maxCharacters = 2048): string;
export function summarizeToolInput(toolName: string, input: unknown): string;
```

- [ ] **Step 3.1：写跨 chunk 失败测试**

覆盖 BOM、CRLF、多行、跨三个 chunk、尾部无换行、空行、非法 JSON 和超 1 MiB 单行。非法行产生 diagnostic，不使 Run 崩溃。

- [ ] **Step 3.2：实现最小 decoder**

只做 framing 与 `JSON.parse`，不认识 Codex schema；finish 处理残留并清 buffer。

- [ ] **Step 3.3：写脱敏失败测试并实现**

覆盖 API Key、Bearer、URL token、`.env` 值和超长内容；值替换为 `[REDACTED]`，截断以 `…[truncated]` 结束。

- [ ] **Step 3.4：实现 plainTextAdapter**

非空 stdout chunk -> assistant.message；finish 不重复聚合；永远不产出 tool 事件。

### 检测与验收

- decoder/redaction/plain adapter 测试通过。
- 假 token 只命中测试输入，不命中输出/snapshot。
- 非法 JSON、未知 schema、超长行有稳定 diagnostic code，CLI 退出码不变。

**建议提交：** `feat: add safe cli stream decoding`

---

## Task 4：实现 Codex Adapter 与能力探测

**Files:**
- Create/Test: `packages/agent-core/src/adapters/capabilityProbe.ts`
- Create/Test: `packages/agent-core/src/adapters/registry.ts`
- Create/Test: `packages/agent-core/src/adapters/codexAdapter.ts`
- Create: `packages/agent-core/src/adapters/fixtures/codex-basic.jsonl`
- Modify: `packages/agent-core/src/config.ts`
- Modify: `packages/agent-core/src/capabilities.ts`

**Protocol:** 依据 [Codex non-interactive JSONL](https://learn.chatgpt.com/docs/non-interactive-mode.md)，幂等加入 `--json`。probe 只运行 version/help，5 秒超时，按绝对命令路径缓存，不发模型请求。

**Mapping:** thread/turn -> status；command/MCP/web/file item -> tool；agent_message -> assistant；turn usage -> usage；reasoning 只生成 thinking status。

- [ ] **Step 4.1：保存最小脱敏 fixture**

fixture 包含 thread/turn、agent message、command execution、file change、usage 和结束事件，只用虚构数据。

- [ ] **Step 4.2：写 Codex Adapter 失败测试**

逐行喂 parser，断言事件顺序、tool callId 配对、最终文字仅含 assistant、reasoning 原文消失。

- [ ] **Step 4.3：验证参数幂等**

连续 decorate 两次后 `--json` 只出现一次，model/sandbox/prompt 顺序不变。

- [ ] **Step 4.4：实现 probe 与 registry**

仅实际 Codex 且 help 支持 `--json` 时选择 Codex Adapter；其他命令或探测失败使用 plain，并发 `adapter.plain_fallback`。不得增加 Kimi/OpenCode schema 分支。

- [ ] **Step 4.5：兼容未知 Codex 事件**

未知 event/item 产生 `adapter.unknown_event`，不显示 JSON 原文，不终止运行。

### 检测与验收

- `pnpm --filter @agentos/agent-core test -- adapters` 通过。
- Codex fixture 的工具轨迹来自结构化 item，不来自 stdout 正则。
- Access denied 得到 UNAVAILABLE；配置可执行入口后 probe 能选择 Codex Adapter。
- V2 文档只宣称 Codex 结构化适配，明确 Kimi/OpenCode 仍为 plain。

**建议提交：** `feat: add codex cli adapter`

---

## Task 5：把 Codex Adapter 接入 CLIExecutor

**Files:**
- Modify/Test: `packages/agent-core/src/executor.ts`
- Modify: `packages/agent-core/src/types.ts`
- Modify: `packages/agent-core/src/runner.ts`
- Modify/Test: `packages/agent-core/src/conversationRunner.ts`
- Modify: `packages/agent-core/src/index.ts`

**Interface:** `ExecuteContext` 增加 `onRuntimeEvent?: (event: NormalizedCliEvent) => void`；`TaskLog.stdout` 仍是公开 assistant 文字，不是 raw JSONL。

- [ ] **Step 5.1：写真实 spawn 流失败测试**

Node fixture 分三次写一条 JSONL，再写 tool/assistant，断言跨 OS chunk 恢复，TaskLog.stdout 只拼 assistant。

- [ ] **Step 5.2：spawn 前选择 Adapter**

命令解析后做缓存 probe 并装饰参数；日志只记 provider/structured/version，不记 prompt/凭据。

- [ ] **Step 5.3：分离 raw stdout 与公开文字**

结构化 stdout -> decoder -> onRuntimeEvent；assistant 同步派生到旧 onChunk；结束只调用一次 done。非 Codex 继续 plain 行为。

- [ ] **Step 5.4：保持错误、取消、超时**

非零退出仍抛 CLIError；Abort 杀进程树；decoder warning 不改变退出码。进程中断时为 open tool call 合成 failed 终态，避免永久 running。

- [ ] **Step 5.5：接入 ConversationAgentRunner**

assistant 文字继续经过 waiting marker 缓冲；tool/status/usage 不参与最终 content 拼接。

### 检测与验收

- agent-core 全部测试通过。
- Mock、Task Pipeline、图片、超时、取消、文件变化无回归。
- TaskLog.stdout 不含 JSONL；tool 不重复成正文；done 仅一次。
- Kimi/OpenCode 配置仍走 plain，不因本任务改变参数或登录行为。

**建议提交：** `feat: stream codex runtime events`

---

## Task 6：投影、持久化并通过现有 SSE 传输公开事件

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Create/Test: `apps/server/src/services/RuntimeEventProjector.ts`
- Modify/Test: `apps/server/src/services/ConversationService.ts`
- Modify/Test: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Modify: `apps/server/src/routes/runs.ts`
- Modify/Test: `apps/server/src/services/RunStreamRegistry.ts`

**AgentEvent additions:** `execution.output.appended`、`execution.tool.started`、`execution.tool.completed`、`execution.usage.recorded`、`execution.diagnostic`。

`RuntimeEventProjector.project(context,event)` 补齐 workspace/conversation/run/execution/agent，上游脱敏后发布 EventBus，并为当前 SSE 发兼容 execution 或新 runtime event。

- [ ] **Step 6.1：写 projector 映射失败测试**

覆盖所有 Normalized event，断言公开类型、上下文、payload 和脱敏；status 兼容 ExecutionEvent，tool/usage 走 runtime。

- [ ] **Step 6.2：复用 agent_events**

不新增重复表。`listAgentEvents()` 按 `timestamp ASC, rowid ASC` 返回，保证同毫秒顺序；历史库无需 destructive migration。

- [ ] **Step 6.3：接入 ConversationService**

每个 execution 有独立 projector context；发布失败必须形成确定性错误，不能静默丢审计事件。

- [ ] **Step 6.4：扩展 SSE 去重与重连**

runtime 使用现有 cursor；重连只重放 `cursor > afterCursor`，同 eventId 可去重。

- [ ] **Step 6.5：扩展 RunDetails API**

返回公开 runtime events；不返回 raw JSONL、完整 env 或未脱敏 stderr。

### 检测与验收

- Projector/ConversationService/Store/RunStreamRegistry 测试通过。
- 刷新后已完成 Codex Run 的工具、用量、诊断仍可从 API 读取。
- cursor 重连不重复工具、不丢后续事件。
- 旧数据库启动成功，不增加重复 runtime event 表。

**建议提交：** `feat: persist codex runtime events`

---

## Task 7：建立 RuntimeArtifact 产物系统

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Modify/Test: `packages/agent-core/src/workspaceChanges.ts`
- Modify/Test: `apps/server/src/store/SqliteStore.ts`
- Create/Test: `apps/server/src/services/RuntimeArtifactService.ts`
- Create/Test: `apps/server/src/services/RuntimeArtifactCollector.ts`
- Create/Test: `apps/server/src/routes/artifacts.ts`
- Modify/Test: `apps/server/src/routes/runs.ts`
- Modify: `apps/server/src/index.ts`
- Create/Test: `apps/web/src/lib/artifacts.ts`
- Create: `apps/web/src/components/artifacts/ArtifactShelf.tsx`
- Create: `apps/web/src/components/artifacts/ArtifactCard.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Modify: `apps/web/src/components/runs/RunDetails.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

**Public interfaces:**

```ts
export type RuntimeArtifactType = 'file' | 'diff' | 'report' | 'image' | 'log';

export interface RuntimeArtifact {
  id: string;
  workspaceId: string;
  runId: string;
  sourceExecutionId: string;
  agentId: string;
  type: RuntimeArtifactType;
  title: string;
  summary?: string;
  originalPath?: string;
  mimeType?: string;
  sizeBytes: number;
  sha256?: string;
  contentAvailable: boolean;
  createdAt: string;
}
```

用户建议中的 `path` 拆成 `originalPath` 与服务端私有 `storageKey`：前者说明产物来自哪个工作区路径，后者指向 AgentOS 托管快照且不得返回浏览器。`sourceExecution` 固定命名为 `sourceExecutionId`，与现有 execution 主键一致。

`originalPath` 必须是以 workspace root 为基准的规范化相对路径，统一使用 `/`；不得保存盘符、UNC 前缀或用户 HOME 绝对路径。

**Server-only input:**

```ts
export type ArtifactContentSource =
  | { kind: 'text'; content: string }
  | { kind: 'workspace-file'; absolutePath: string }
  | { kind: 'reference'; originalPath: string };

export interface CreateRuntimeArtifactInput {
  workspaceId: string;
  workspaceRoot: string;
  runId: string;
  sourceExecutionId: string;
  agentId: string;
  type: RuntimeArtifactType;
  title: string;
  summary?: string;
  originalPath?: string;
  mimeType?: string;
  source: ArtifactContentSource;
}
```

**Storage:** 内容写入 `AGENTOS_PROJECT_ROOT/.agentos/artifacts/<workspaceId>/<runId>/<artifactId>/content`；SQLite 只保存 metadata、相对 `storage_key`、size 和 SHA-256。浏览器不接触磁盘路径。

**Collection rules:**

Artifact 是 Run 的一等产物，不是聊天消息附件。Collector 只能从文件变化、结构化工具事件、CLI 调用记录和公开 RuntimeEvent 创建 Artifact；不得解析 Codex 最终回复来猜测“修改了哪些文件”或“通过了多少测试”。聊天与 RunDetails 只引用 Artifact id，Artifact metadata/快照才是产物事实源。

- `file`：Codex 本次创建/修改的文本或安全二进制文件快照；删除文件只保存 metadata，`contentAvailable=false`。
- `diff`：仅当 Run 开始时 Git workspace 为 clean，记录 `baseHead`，结束时保存 `git diff --no-ext-diff --unified=3 <baseHead>`；即使 Codex 创建 commit，也能覆盖 baseHead 到最终 HEAD/working tree 的变化。dirty baseline 不生成误导性 diff，发布 diagnostic。
- `report`：只对严格识别的测试命令生成，如 `pnpm ... test`、`npm test`、`vitest`、`pytest`、`cargo test`、`go test`、`dotnet test`；保存 exit code、duration、脱敏输出和可确认的 passed/failed 计数。
- `image`：只接受 PNG/JPEG/WebP/GIF，必须校验 magic bytes；MVP 不内联 SVG。
- `log`：从公开 RuntimeEvent 重建，绝不保存 raw JSONL、私有 reasoning 或完整环境变量。

**Limits:** 每 Run 最多 100 个 Artifact；file 文本 2 MiB，diff/report/log 1 MiB，图片 10 MiB。超过限制创建 metadata-only Artifact 并写明原因。

- [ ] **Step 7.1：写类型、迁移和 Store 失败测试**

新增 `runtime_artifacts` 表：

```sql
CREATE TABLE IF NOT EXISTS runtime_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  original_path TEXT,
  storage_key TEXT,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  content_available INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (source_execution_id) REFERENCES executions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS runtime_artifacts_run_created
ON runtime_artifacts (workspace_id, run_id, created_at, id);
```

测试创建、按 Run 查询、workspace 隔离、重启持久化、旧数据库增量迁移、Conversation 删除后的 metadata 清理。`AgentRunDetails` 增加 `artifacts: RuntimeArtifact[]`。

- [ ] **Step 7.2：实现不可变 ArtifactService**

`create()` 生成 UUID、校验 run/execution/workspace 归属、校验 originalPath 在 workspace 内、生成服务端 storageKey、先写临时文件再原子 rename、计算 SHA-256，最后写 metadata。相同 id 不允许覆盖；失败时清理自己创建的临时文件。

- [ ] **Step 7.3：实现 ArtifactCollector**

复用 `RunFileChange`、Codex tool completed、RunCliInvocation 和公开 RuntimeEvent。增强 `workspaceChanges`：记录开始时 `baseHead` 和 clean/dirty；clean baseline 结束后用 `git diff --name-status <baseHead>` 捕获已提交与未提交变化。对开始时已 dirty/untracked 的候选文件记录 hash，避免仅凭 Git status 字母漏掉二次修改。dirty baseline 只生成可确认变化的 file snapshot 和 `artifact.diff_skipped_dirty_baseline` diagnostic。

严格测试命令分类器必须基于 argv/结构化 command 字段，不搜索自然语言回复。未知测试框架只生成 log，不伪造 passed 数量。

- [ ] **Step 7.4：发布 Artifact 事件并扩展 Run API**

在共享事件判别联合中增加 `execution.artifact.created`，payload 只携带公开 `RuntimeArtifact` metadata。每个 Artifact metadata 和内容落盘成功后再发布该 AgentEvent，并通过现有 runtime SSE 推送；失败只发布 `execution.diagnostic`。`GET /runs/:runId` 返回 artifacts，历史刷新后顺序稳定。

- [ ] **Step 7.5：实现安全内容路由**

```text
GET /api/workspaces/:workspaceId/artifacts/:artifactId/content
```

先校验 workspace/artifact 归属，再用 metadata storageKey 定位；realpath 必须位于 artifact root。响应包含 `X-Content-Type-Options: nosniff`；text/diff/report/log 使用安全文本 MIME；PNG/JPEG/WebP/GIF 可 inline；其他内容强制 `Content-Disposition: attachment`。不存在、越界、metadata-only 分别返回 404/403/409。

- [ ] **Step 7.6：实现 Artifact Shelf 与卡片**

Codex 最终回复下显示“完成产物”，按 `diff -> file/image -> report -> log` 排序；卡片显示类型、标题、来源 Agent、大小和摘要。file/report/log/diff 提供安全文本预览与下载；image 提供缩略图与放大；metadata-only 显示不可预览原因。RunDetails 显示相同 Artifact 列表，不复制另一套状态。

受控任务至少呈现以下等价信息，具体图标可沿用现有设计系统：

```text
完成产物
📄 修改文件  executor.ts
📊 测试报告  1 passed
📝 设计文档  architecture.md
```

- [ ] **Step 7.7：定义清理与去重**

同一 run/type/originalPath/sha256 只保留一个 Artifact。删除 Conversation 时只删除其关联 metadata 和 artifact root 内的托管内容，不删除 workspace 原文件。清理失败记录 diagnostic，不把用户操作回滚成失败。

### 检测与验收

- shared/agent-core/server/web 的 Artifact 单元测试与 build 通过。
- Codex fixture Run 至少产生：修改文件 file、clean baseline diff、测试 report、公开 log；设计文档 `architecture.md` 作为 file Artifact。
- 即使 Codex 最终回复未列出文件和测试结果，Collector 仍能根据执行事实产生相同 Artifact；不得依赖聊天文本抽取。
- PNG fixture 生成 image Artifact；伪 PNG、SVG、超 10 MiB 图片不能 inline。
- 修改 workspace 原文件后，历史 Artifact 的 size/SHA-256/内容保持不变，证明快照不可变。
- dirty baseline 不产生包含旧改动的误导性 diff，并有明确 diagnostic。
- 路径遍历、跨 workspace、篡改 storageKey、metadata-only 内容请求全部被拒绝。
- SQLite、Artifact 内容和 API 中不出现假 API Key/Bearer；raw JSONL 不落盘。

**建议提交：** `feat: add immutable runtime artifacts`

---

## Task 8：实现可控的逐字输出队列

**Files:**
- Create/Test: `apps/web/src/lib/typewriterQueue.ts`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`

**Interfaces:**

```ts
export interface TypewriterQueue {
  append(text: string): void;
  tick(): string;
  flush(): string;
  clear(): void;
  readonly pendingLength: number;
}
export function createTypewriterQueue(options?: {
  graphemesPerTick?: number; // default 1
  catchUpThreshold?: number; // default 120
  catchUpSize?: number;      // default 4
}): TypewriterQueue;
```

- [ ] **Step 8.1：写 Unicode 与顺序失败测试**

输入中文、英文、组合音标和家庭 emoji；使用 `Intl.Segmenter` 按 grapheme 切分，默认每 tick 一个完整字素。

- [ ] **Step 8.2：实现积压追赶**

少于 120 字素每 tick 1 个，超过阈值最多 4 个。SSE done 时 flush，使最终显示与 Message 一致。

- [ ] **Step 8.3：接入 React 生命周期**

output.appended 只 append；单个 24ms interval 驱动。切换会话、取消、失败、卸载时清理。reduce-motion 时即时显示。

- [ ] **Step 8.4：避免历史二次打字**

只有 active Codex Run 的实时 output 入队；历史直接显示；已见 eventId 不重复 append。

### 检测与验收

- web 单元测试通过。
- 中文/英文/emoji 不拆字、不乱序、不重复。
- done 后 UI 与持久化 Message 完全相等。
- reduce-motion 即时显示，切换会话后无残留 timer。
- 短回复明显逐字出现，长回复能追赶且不阻塞输入/滚动。

**建议提交：** `feat: add accessible typewriter rendering`

---

## Task 9：实现 Codex Tool Timeline、Artifact Shelf 与历史详情

**Files:**
- Create/Test: `apps/web/src/lib/runtimeEvents.ts`
- Create: `apps/web/src/components/runtime/RuntimeEventFeed.tsx`
- Create: `apps/web/src/components/runtime/ToolEventCard.tsx`
- Create: `apps/web/src/components/runtime/CurrentAction.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Modify: `apps/web/src/components/chat/ExecutionInspector.tsx`
- Modify: `apps/web/src/components/runs/RunDetails.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Modify only for scoped styles: `apps/web/src/app/globals.css`

**UI rules:** 中栏按时间显示公开状态、工具卡和回复；回复完成区显示 Artifact Shelf；工具折叠态显示名称/摘要/状态/耗时，展开态显示最多 2048 字符的脱敏输入输出；右栏显示当前动作、Timeline 和最近工具；RunDetails 显示完整公开事件与 Artifact。不显示 reasoning 原文。

- [ ] **Step 9.1：写事件归并失败测试**

用乱序/重复 started/completed fixture，断言按 callId 合并；completed 先到也可归并；重复 eventId 忽略；未知 tool 用通用图标。

- [ ] **Step 9.2：实现 RuntimeEventFeed**

Feed 只渲染 status/tool/artifact-created，assistant 正文仍由 ChatPanel/TypewriterQueue 渲染。running 轻量动画，终态静态化；artifact-created 只更新同一个 Artifact Shelf，不重复创建卡片。

- [ ] **Step 9.3：升级 Current Action**

优先级：failed tool > running tool > Codex status > execution status > idle。切换会话立即清旧 action。

- [ ] **Step 9.4：升级 RunDetails**

started/completed 配对；usage 缺失显示“Codex CLI 未提供”，不能用 0 代替。RunDetails 使用与聊天完成区相同的 ArtifactCard，按 sourceExecutionId 可追溯到产生它的 Codex execution。

- [ ] **Step 9.5：键盘和读屏**

Tool 卡使用 `<button aria-expanded>`；状态用克制的 `aria-live="polite"`，不能逐字触发读屏。

### 检测与验收

- web test/build 通过。
- 同一 tool call 只有一张卡，running -> completed/failed。
- 同一 Artifact id 只有一张卡；实时创建、刷新历史和 RunDetails 三条路径内容一致。
- UI 不出现 waiting marker、raw JSONL、Bearer/API Key、凭据路径。
- 中栏、右栏、RunDetails 的工具名、状态和 Artifact 数量一致。
- 1280/1440px 无横向溢出，键盘可展开/折叠。

**建议提交：** `feat: visualize codex tool activity`

---

## Task 10：Codex 真实外部 Agent Gate 与发布验收

**Files:**
- Create: `scripts/verify-codex-runtime-e2e.mjs`
- Create: `scripts/verify-codex-runtime-e2e.ps1`
- Create: `scripts/fixtures/codex-artifact-project/package.json`
- Create: `scripts/fixtures/codex-artifact-project/executor.ts`
- Create: `scripts/fixtures/codex-artifact-project/test.mjs`
- Create/Finalize: `docs/acceptance/codex-runtime-final.md`
- Modify: `scripts/verify-next-optimization-acceptance.ps1`
- Modify: `README.md`
- Modify: `docs/AGENTOS_V2.md`

**Gate matrix:**

| Provider | 参数 | 必须观察到 |
|---|---|---|
| Codex fixture | `exec --json` 形状 | thread/turn、assistant、tool started/completed、Artifact、usage/缺失、done |
| Plain fixture | 无 | 文字正常，工具明确不可观测 |
| 真实 Codex | `exec --json` | 真实工具调用、逐字回复、file/diff/report/log Artifact、历史回放和终态 |

 - [x] **Step 10.1：确定性 fixture E2E**

启动隔离 Server，注册 Codex fixture 与 plain fixture，消费 SSE，断言文字顺序、tool 配对、Artifact 创建、cursor 重连、done、SQLite/内容快照回放和脱敏。fixture 额外覆盖 PNG image Artifact 与非法图片拒绝。

 - [x] **Step 10.2：真实 Codex probe**

记录绝对命令、版本、help 和登录状态。命令不存在/Access denied 为 UNAVAILABLE；凭据、模型、schema、超时错误为 FAIL；不能跳过真实 Gate 后宣称完成。

 - [x] **Step 10.3：真实受控写入任务**

fixture 内容固定为：

```json
{
  "name": "codex-artifact-fixture",
  "private": true,
  "scripts": { "test": "node test.mjs" }
}
```

```ts
export const DEFAULT_TIMEOUT_MS = 1000;
```

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./executor.ts', import.meta.url), 'utf8');
assert.match(source, /DEFAULT_TIMEOUT_MS\s*=\s*2000/);
console.log('1 passed');
```

把 fixture 复制到临时 Git workspace 并提交 clean baseline。任务固定为：“把 `executor.ts` 中 `DEFAULT_TIMEOUT_MS` 从 1000 改为 2000，运行 `npm test`，再创建 `architecture.md` 说明这项配置；不要修改其他文件，也不要创建 Git commit。”要求 exit 0、测试通过，并产生 `executor.ts` file、Run diff、测试 report、`architecture.md` file、公开 execution log 五类可追溯结果；原始 fixture 目录保持零改动。

 - [x] **Step 10.4：真实浏览器验收**

1. 文字逐字出现，首个公开 assistant output 后 300ms 内进入队列。
2. 工具卡 running -> completed，展开只有脱敏信息。
3. 执行中刷新，重连不重复文字或工具。
4. 执行中取消，进程终止、状态 cancelled、动画停止。
5. waiting_user 不显示内部 marker。
6. 最终回复下出现“完成产物”，包含 executor.ts、diff、测试报告、architecture.md 和 log。
7. 文本/差异/报告/日志可预览下载；下载 SHA-256 与 metadata 一致；刷新后内容不变。
8. 历史 RunDetails 的工具、Artifact、CLI、usage/缺失说明一致。
9. 浅色/深色与 1280/1440px 可读，console 无 error，network 无无限重连。

 - [x] **Step 10.5：全量回归与安全扫描**

```powershell
pnpm install --frozen-lockfile
pnpm --filter @agentos/shared build
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server test
pnpm --filter @agentos/web test
pnpm --filter @agentos/web build
pnpm -r run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-next-optimization-acceptance.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-codex-runtime-e2e.ps1
git diff --check
```

fixture 注入假 key/Bearer/path；SQLite、Artifact 内容、日志、API 和浏览器响应不得出现原值。现有 Mock、Task Pipeline、群聊、图片、waiting_user、取消、恢复、记忆候选必须回归通过，但不要求 Kimi/OpenCode 真实调用。

 - [x] **Step 10.6：完成文档与回滚**

README 只把 Codex 标记为“结构化工具与 RuntimeArtifact 已验证”；KimiCode/OpenCode 标记为“当前保持 plain，后续独立适配”。V2 文档写 Codex Adapter/Event/SSE/Artifact 数据流、存储上限和清理策略。回滚按提交倒序，不删除历史事件或用户工作区文件。

### 检测与验收（当前计划最终 Gate）

- fixture gate 和所有自动命令退出 `0`。
- 真实 Codex 为 PASS；UNAVAILABLE/FAIL 都不能把本计划标记完成。
- 最终文字不缺失、不重复；每个真实 tool call 有终态。
- 真实受控任务产生预期 file/diff/report/log Artifact；fixture image Artifact 通过；Artifact 来源 execution、SHA-256、内容路由可验证。
- 刷新/重连无重复 eventId、工具卡、Artifact 卡或文本；历史 Artifact 快照可回看且不随 workspace 改变。
- 私有 reasoning、API Key、Bearer、完整 env、raw JSONL 不进入 UI/SQLite/Artifact/常规日志。
- KimiCode/OpenCode 的参数、登录、输出格式和真实 Gate 均未被本计划触碰。
- `codex-runtime-final.md` 包含日期、分支、commit、Codex 版本/路径、命令摘要、浏览器结果和未完成项，不含占位符。

**建议提交：** `docs: close codex runtime acceptance`

---

## 当前计划停止点

Task 10 是硬停止点。只有用户实际体验并确认 Codex 已达到目标，才创建后续计划；不能在同一实现批次中顺手加入其他 Provider。

### 后续独立计划顺序（不属于当前执行范围）

1. **KimiCode Adapter 计划**：重新探测当时版本、参数、登录状态和 stream-json schema；建立 Kimi 专属 fixture、单元测试和真实 Gate。只复用已经由 Codex 验证稳定的通用 decoder/projector/UI，不先假设 schema 一致。
2. **OpenCode Adapter 计划**：在 Kimi 是否完成不影响 Codex 的前提下，单独探测 `run --format json`、权限等待和工具终态；建立 OpenCode 专属 Gate。
3. **多 Agent 协作计划**：至少两个 Provider 分别通过真实 Gate 后，再规划角色交接、并发策略和 worktree 隔离。

每个后续计划必须独立回答：锁定哪个 CLI 版本、结构化 flag 是否仍存在、fixture 来自什么版本、plain fallback 如何工作、真实登录状态如何验收。任何一个 Provider 失败都不能降低已经完成的 Codex 体验。

## 明确不在本计划内

- KimiCode Adapter、OpenCode Adapter、三 CLI 联合真实 Gate。
- 新增群聊角色/调度、并行执行、worktree、自动 merge/cherry-pick。
- 自动选择最佳 Agent/模型。
- 记录或展示私有思维链。
- 跨 Workspace 共享记忆。
- SSE 改 WebSocket。
- CPU/内存实时采样、向量库、外部消息队列、云控制面。

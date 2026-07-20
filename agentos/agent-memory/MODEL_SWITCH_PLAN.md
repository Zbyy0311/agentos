# Agent 模型与思考强度选择功能 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 执行本计划。每个任务都必须按复选框逐项完成，并在任务结束时运行对应验证命令。

**目标：** 用户可以在 Agent 编辑器中选择模型和思考强度，保存后配置持久化，并在 direct conversation、group conversation 和 pipeline 三条执行链路中真实传递到支持该能力的 CLI。

**架构：** 保留现有 `model` 字段，新增可枚举的 `thinkingEffort` 字段；服务端提供按 Agent/CLI 计算出的能力选项，前端只展示当前运行时支持的选项。所有模型和思考强度的 CLI 参数解析集中在 `CLIExecutor` 的运行时解析层，避免在 `runner.ts` 和 `conversationRunner.ts` 中重复拼接参数。CLI 不支持的能力不得通过提示词或无效参数伪造生效，接口拒绝无效组合。

**技术栈：** TypeScript、Node.js >= 22.5、pnpm workspace、Vitest、Next.js、Express、SQLite（现有项目依赖，不新增第三方依赖）。

## 全局约束

- 用户界面文案使用中文；内部字段使用 `thinkingEffort`，不使用 `thinking` 这种含义过宽的名称。
- `thinkingEffort` 取值固定为 `auto | low | medium | high`，缺失或历史空值按 `auto` 处理。
- `model` 继续保存模型标识字符串；模型列表可以是预置项，但必须允许后端保留已有自定义值，避免升级后丢失配置。
- CLI 参数必须在真正 `spawn` 前解析；不能只修改 `AgentConfig` 而不验证最终子进程参数。
- Kimi、OpenCode、Codex 的参数格式不能按 Agent role 互相推断；必须按实际 `cliCommand` 判断。OpenCode 回退到 Codex 时，必须使用 Codex 映射，禁止追加 OpenCode 参数。
- 不支持某个能力的 CLI 只能暴露 `auto`；如果客户端提交其他强度，服务端返回 HTTP 400，不能静默成功。
- 不把 API Key、凭据、完整 prompt 写入诊断日志。可记录经过脱敏的 CLI 参数，例如模型名和思考强度，但不能记录环境变量中的密钥值。
- 不修改现有默认模型行为：历史 Agent 没有新字段时，执行结果必须与升级前一致。
- 不在本功能中实现 Codex CLI 自身的模型下载、账号管理或 provider 管理。

---

## 动态模型发现补充计划

模型选择现在增加了独立的动态发现报告：[CLI_MODEL_DISCOVERY_PLAN.md](CLI_MODEL_DISCOVERY_PLAN.md)。该报告覆盖 Codex `models_cache.json`、Kimi `config.toml`、OpenCode 配置/JSON CLI 输出、30 秒缓存、刷新接口、静态回退和真实 CLI 参数验收；本文件原有的持久化、思考强度校验和运行时参数映射继续作为基础能力。

## 1. 当前代码基线与问题

当前仓库已经具备以下能力：

- `WorkspaceAgent`、`AgentProfile` 和 `AgentConfig` 已有可选 `model` 字段。
- Agent 编辑器已有“模型标识”输入框。
- SQLite 已有 `model` 列及迁移逻辑。
- `runner.ts` 和 `conversationRunner.ts` 会把 Agent 配置传给 `CLIExecutor`。
- `executor.ts` 会在执行前处理 Kimi API Key 环境变量，并在 API Key 模式下删除 `-m` 参数。

因此本功能不能只是在 `runner.ts` 里追加 `-m` 或 `--model`。尤其是 Kimi API Key 模式，新增的模型值必须进入 `KIMI_MODEL_NAME`，否则会在 `resolveKimiCliArgs()` 中被删除。

当前本机能力检查结果：

- Kimi CLI 可用，`kimi --help` 明确支持 `-m, --model <model>`，未发现通用思考强度参数。
- OpenCode 当前不在 PATH 中，不能假设其参数格式。
- Codex 当前终端无法直接启动其 WindowsApps 路径；模型和思考参数采用官方 CLI 文档映射，并由运行时解析单元测试覆盖，真实 CLI 执行仍需在可启动 Codex 的环境完成。

在开始实现前必须完成第 2 节的 CLI 能力矩阵。没有矩阵，不得把某个参数写死到代码中。

## 2. CLI 能力矩阵与产品边界

### 2.1 能力矩阵文件

新增 `agent-memory/CLI_CAPABILITY_MATRIX.md`，记录实际 CLI 的版本、帮助命令输出摘要和参数映射。至少包含以下表格：

| CLI | 模型设置方式 | 思考强度设置方式 | 支持值 | 不支持时行为 |
|---|---|---|---|---|
| Kimi | `-m/--model` 或 API Key 环境变量 | 以 `kimi --help` 和当前 provider 配置为准 | 记录实际值 | 只允许 `auto` |
| OpenCode | 以 `opencode run --help` 为准 | 以 OpenCode 当前版本文档/帮助为准 | 记录实际值 | 只允许 `auto` |
| Codex | `-m <model>`（官方 CLI 映射；本机二进制不可启动） | `-c model_reasoning_effort=<effort>`（官方 CLI 映射；本机二进制不可启动） | `auto`、`low`、`medium`、`high` | 运行时交给 Codex 校验；不可用时返回执行错误 |

```powershell
kimi --help
opencode --help
opencode run --help
codex exec --help
```

如果某个 CLI 因 PATH 或权限不可执行，必须在矩阵中记录“不可验证”。对于没有可靠参数依据的 CLI，UI 只能显示 `auto`；Codex 的参数来自官方 CLI 文档并有运行时单元测试覆盖，因此可以生成配置，但真实执行仍需在可启动 Codex 的环境验收。

### 2.2 统一字段

在 `packages/shared/src/types/index.ts` 增加：

```ts
export type ThinkingEffort = 'auto' | 'low' | 'medium' | 'high';

export interface AgentCapability {
  role: AgentRole;
  cliKind: 'kimi' | 'opencode' | 'codex' | 'unknown';
  models: string[];
  thinkingEfforts: ThinkingEffort[];
  defaultModel?: string;
  defaultThinkingEffort: ThinkingEffort;
}
```

在 `WorkspaceAgent` 中增加：

```ts
thinkingEffort?: ThinkingEffort;
```

在 `AgentConfig` 中增加同名字段。历史数据缺失时由读取层补成 `auto`，写入层仍可将 `auto` 持久化为明确值。

## 3. 文件变更总览

### 修改文件

| 文件 | 责任 |
|---|---|
| `packages/shared/src/types/index.ts` | 增加 `ThinkingEffort`、`AgentCapability` 和 Agent 字段 |
| `packages/agent-core/src/types.ts` | 扩展 `AgentConfig` |
| `packages/agent-core/src/config.ts` | 保留默认模型，补充默认思考强度和 CLI kind 识别入口 |
| `packages/agent-core/src/executor.ts` | 新增统一运行时解析；修复 Kimi API Key 模式模型覆盖；记录脱敏后的最终参数 |
| `packages/agent-core/src/runner.ts` | 从 Workspace Agent 复制 `model` 和 `thinkingEffort`，不再自行拼接 CLI 参数 |
| `packages/agent-core/src/conversationRunner.ts` | 从 AgentProfile 复制 `model` 和 `thinkingEffort`，不再自行拼接 CLI 参数 |
| `packages/agent-core/src/executor.test.ts` | 增加最终运行时参数解析测试 |
| `packages/agent-core/src/conversationRunner.test.ts` | 增加会话路径传递新字段的测试 |
| `packages/agent-core/src/config.test.ts` | 增加默认值和 CLI fallback 测试 |
| `apps/server/src/store/SqliteStore.ts` | 增加 SQLite 列、迁移、读写映射 |
| `apps/server/src/store/SqliteStore.test.ts` | 增加新字段持久化和旧数据迁移测试 |
| `apps/server/src/routes/agents.ts` | PATCH 接受并校验 `thinkingEffort`；返回能力信息 |
| `apps/server/src/routes/conversations.ts` | 会话 Agent 更新接受并校验 `thinkingEffort` |
| `apps/web/src/components/chat/AgentEditor.tsx` | 将模型改为可选控件，并增加思考强度控件 |
| `apps/web/src/app/workspace/[id]/page.tsx` | 保存和加载能力选项，处理 400 错误 |
| `apps/server/src/routes/agents.test.ts` | 增加 Agent API 验证测试 |

### 新增文件

| 文件 | 责任 |
|---|---|
| `agent-memory/CLI_CAPABILITY_MATRIX.md` | 保存实际 CLI 能力和版本验证结果 |
| `packages/agent-core/src/capabilities.ts` | 根据 `cliCommand` 返回能力和选项 |

## 4. 分任务执行计划

### Task 1：完成 CLI 能力矩阵和可选项决策

**Files:**

- Create: `agent-memory/CLI_CAPABILITY_MATRIX.md`
- Read: `packages/agent-core/src/config.ts`
- Read: `packages/agent-core/src/executor.ts`

**Interfaces:**

- Produces: 每种 CLI 的实际模型参数、思考强度参数、支持值和 fallback 行为。
- Later tasks consume: `ThinkingEffort` 的支持集合和运行时映射，不允许重新猜测参数。

- [x] **Step 1: 运行 CLI 帮助命令**

```powershell
kimi --help
opencode --help
opencode run --help
codex exec --help
```

- [x] **Step 2: 记录版本和参数映射**

矩阵必须明确写出类似以下结构，不能只写“支持思考”：

```markdown
| CLI | 版本 | model | thinkingEffort | 支持值 | fallback |
| kimi | x.y.z | `-m <model>`；API Key 模式为 `KIMI_MODEL_NAME` | `none` | `auto` | 非 auto 返回 400 |
```

- [x] **Step 3: 固定产品规则**

规则必须是：

1. `auto` 对所有 CLI 可用。
2. 只有矩阵明确支持的 `low/medium/high` 才出现在下拉框。
3. CLI 不支持思考强度时，服务端拒绝非 `auto`，不修改 prompt 伪造效果。
4. OpenCode 命令实际解析为 Codex 时，使用 Codex 映射，不使用 OpenCode 映射。

- [x] **Step 4: 验证矩阵可执行**

Run: `Get-Content -Encoding utf8 agent-memory/CLI_CAPABILITY_MATRIX.md`

Expected: 每个 CLI 都有“已验证”或“不可验证”的明确状态，不含未验证或占位状态。

### Task 2：扩展共享类型和能力解析

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/agent-core/src/types.ts`
- Create: `packages/agent-core/src/capabilities.ts`
- Test: `packages/agent-core/src/config.test.ts`

**Interfaces:**

```ts
export type ThinkingEffort = 'auto' | 'low' | 'medium' | 'high';

export interface CliCapability {
  cliKind: 'kimi' | 'opencode' | 'codex' | 'unknown';
  modelFlag?: '--model' | '-m';
  thinkingEffortMode: 'arg' | 'env' | 'none';
  thinkingEffortValues: ThinkingEffort[];
}

export function getCliCapability(cliCommand: string): CliCapability;

export function getAgentCapability(
  role: AgentRole,
  cliCommand: string,
  defaultModel?: string,
): AgentCapability;
```

- [x] **Step 1: 先写能力解析测试**

测试至少覆盖：

```ts
expect(getCliCapability('kimi').cliKind).toBe('kimi');
expect(getCliCapability('opencode').cliKind).toBe('opencode');
expect(getCliCapability('C:\\tools\\codex.exe').cliKind).toBe('codex');
expect(getCliCapability('codex').thinkingEffortValues).toContain('auto');
```

并覆盖 OpenCode role 使用 Codex command 时，返回 `codex` 而不是 `opencode`。

- [x] **Step 2: 按 Task 1 矩阵实现 `capabilities.ts`**

实现要求：

- 只返回矩阵中已验证的参数。
- `unknown` CLI 的 `thinkingEffortValues` 必须是 `['auto']`。
- 默认思考强度必须是 `auto`。
- 模型列表至少包含当前默认模型和当前已保存的自定义模型。

- [x] **Step 3: 运行测试和类型检查**

Run: `pnpm --filter @agentos/agent-core test src/config.test.ts`

Expected: 能力解析测试全部通过。

Run: `pnpm --filter @agentos/agent-core build`

Expected: TypeScript 编译成功。

### Task 3：实现统一运行时解析

**Files:**

- Modify: `packages/agent-core/src/executor.ts`
- Modify: `packages/agent-core/src/runner.ts`
- Modify: `packages/agent-core/src/conversationRunner.ts`
- Test: `packages/agent-core/src/executor.test.ts`
- Test: `packages/agent-core/src/conversationRunner.test.ts`

**Interfaces:**

新增统一入口：

```ts
export interface RuntimeResolvedConfig {
  cliArgs: string[];
  env: NodeJS.ProcessEnv;
  cliKind: 'kimi' | 'opencode' | 'codex' | 'unknown';
}

export function resolveAgentRuntimeConfig(
  config: Pick<AgentConfig, 'role' | 'cliCommand' | 'cliArgs' | 'model' | 'thinkingEffort' | 'env'>,
  inheritedEnv?: NodeJS.ProcessEnv,
): RuntimeResolvedConfig;
```

- [x] **Step 1: 先写失败测试**

必须覆盖以下行为：

| 场景 | 期望 |
|---|---|
| Kimi OAuth + 新 model | 替换/追加 `-m <model>` |
| Kimi API Key + 新 model | 设置 `KIMI_MODEL_NAME=<model>`，最终 args 不含 `-m` |
| Kimi 空 model | 保留默认模型行为 |
| OpenCode + 新 model | 替换/追加 `--model <model>` |
| OpenCode command 实际为 Codex | 使用 Codex 的 `-m` 和 `-c model_reasoning_effort=...` 映射，不追加 OpenCode 专属参数 |
| 支持的 low/medium/high | 使用矩阵指定的参数或环境变量 |
| 不支持的 effort | `resolveAgentRuntimeConfig()` 抛出明确错误 |
| 重复 model 参数 | 最终只保留一个模型参数 |
| 原始 `cliArgs` | 调用后不被修改 |

测试用例必须断言 `resolved.cliArgs` 和 `resolved.env`，不能只断言 `AgentConfig.model`。

- [x] **Step 2: 修改 `CLIExecutor.execute()` 的执行顺序**

固定顺序：

```ts
const resolvedRuntime = resolveAgentRuntimeConfig(config, {
  ...process.env,
  AGENTOS_WORKSPACE_ROOT: workspaceRoot,
});
const resolved = await resolveCommand(config.cliCommand, resolvedRuntime.env);
const invocation = await createCommandInvocation(
  resolved,
  resolvedRuntime.cliArgs,
  prompt,
);
```

Kimi 的 API Key 环境变量处理必须在同一个解析流程中完成，不能先注入模型再由旧的 `resolveKimiCliArgs()` 无条件删除模型参数。

- [x] **Step 3: 修改两个 Runner 只负责传字段**

`runner.ts` 和 `conversationRunner.ts` 只构造：

```ts
{
  name,
  role,
  cliCommand,
  cliArgs: [...sourceCliArgs],
  model: sourceModel,
  thinkingEffort: sourceThinkingEffort ?? 'auto',
}
```

不得在两个 Runner 中分别实现 `-m`、`--model` 或思考强度参数拼接。

- [x] **Step 4: 增加脱敏诊断日志**

在 `CHILD_SPAWN` 前记录：

```text
CLI_RUNTIME_RESOLUTION stage=... cliKind=... model=... thinkingEffort=... args=...
```

日志不得包含 API Key、credentials 路径中的敏感内容或完整 prompt。模型标识可以记录，因为它是用户配置值。

- [x] **Step 5: 运行单元测试**

Run: `pnpm --filter @agentos/agent-core test`

Expected: 所有旧测试和新增运行时解析测试通过。

### Task 4：SQLite 持久化和服务端 API

**Files:**

- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/routes/agents.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Test: `apps/server/src/store/SqliteStore.test.ts`
- Test: `apps/server/src/routes/conversations.test.ts`（当前 Agent PATCH 实际入口）

**Interfaces:**

PATCH 请求允许：

```ts
{
  model?: string;
  thinkingEffort?: 'auto' | 'low' | 'medium' | 'high';
}
```

无效值返回：

```http
400 Bad Request
```

响应中的 Agent 必须包含：

```ts
{
  model?: string;
  thinkingEffort: ThinkingEffort;
  capability: AgentCapability;
}
```

- [x] **Step 1: 先写存储失败测试**

测试：

1. 新建 Agent 保存 `model` 和 `thinkingEffort`。
2. 重新创建 Store 后两个字段仍存在。
3. 没有 `thinking_effort` 的旧数据库读取为 `auto`。
4. 空字符串模型仍按未配置模型处理。

- [x] **Step 2: 增加数据库列和迁移**

在现有 Agent 表增加：

```sql
thinking_effort TEXT NOT NULL DEFAULT 'auto'
```

迁移必须兼容已有数据库；不能删除或重建已有 Agent 数据。读取时对历史 `NULL`、空值和未知值统一返回 `auto`，写入时只接受四个枚举值。

- [x] **Step 3: 修改 Agent PATCH 和 conversation PATCH**

校验顺序：

1. `thinkingEffort` 不是字符串枚举时返回 400。
2. 根据 Agent 的 `cliCommand` 获取 capability。
3. 提交的 effort 不在 capability 支持列表时返回 400。
4. 通过校验后再调用 `updateAgentProfile()`。

- [x] **Step 4: 增加能力接口或响应字段**

采用现有 Agent 列表响应扩展方式，避免前端再次请求同一 Agent。每个 Agent 返回根据其 `cliCommand` 计算出的 `capability`。

- [x] **Step 5: 运行服务端测试**

Run: `pnpm --filter @agentos/server test`

Expected: 存储、路由和已有服务测试全部通过；非法思考强度得到 400。

### Task 5：前端选择控件和错误反馈

**Files:**

- Modify: `apps/web/src/components/chat/AgentEditor.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Modify: `apps/web/src/components/chat/AgentList.tsx`（仅当需要展示当前配置）

**Interfaces:**

`AgentEditor` 接收 `AgentProfile` 中的 `capability`，保存回调增加：

```ts
onSave(update: {
  name?: string;
  roleTitle: string;
  systemPrompt: string;
  permissions: AgentPermission[];
  enabled: boolean;
  model?: string;
  thinkingEffort: ThinkingEffort;
}): void;
```

- [x] **Step 1: 修改模型控件**

模型区域使用下拉选择：

- 选项来自 `agent.capability.models`。
- 当前保存的自定义模型不在列表时临时追加为选项。
- 保留“自定义模型”输入入口时，提交前必须 trim；空值提交为空字符串，作为显式清空信号，避免 JSON 省略字段后服务端误保留旧模型。

- [x] **Step 2: 增加思考强度控件**

使用下拉框显示：

```text
自动（默认）
低
中
高
```

只渲染 capability 支持的选项。仅支持 `auto` 时显示说明：`当前 CLI 不支持可调思考强度`，控件不可提交非 auto 值。

- [x] **Step 3: 修改保存逻辑**

`page.tsx` 的 `saveAgent` 必须把 `model` 和 `thinkingEffort` 一起 PATCH，保存成功后用服务端返回值刷新本地 Agent，不能只修改本地 state。

- [x] **Step 4: 增加错误反馈**

服务端返回 400 时，编辑器保留用户输入并显示后端错误；不能提示“保存成功”。

- [x] **Step 5: 运行前端构建**

Run: `pnpm --filter @agentos/web build`

Expected: Next.js 构建成功，无 TypeScript 类型错误。

### Task 6：端到端执行验证

**Files:**

- Modify: `packages/agent-core/src/executor.test.ts`
- Modify: `packages/agent-core/src/conversationRunner.test.ts`
- Modify: `apps/server/src/services/ConversationService.test.ts`
- Modify: `apps/server/src/routes/taskPipeline.test.ts`
- Add: `packages/agent-core/src/runner.test.ts`

- [x] **Step 1: 使用 fake CLI 捕获最终参数**

测试脚本必须输出：

```ts
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  model: process.env.KIMI_MODEL_NAME,
  thinkingEffort: process.env.CODEX_REASONING_EFFORT,
}));
```

测试断言 fake CLI 收到的最终参数或环境变量，而不是断言中间配置对象。

- [x] **Step 2: 验证 direct conversation**

给 Agent 保存一个非默认模型和支持的思考强度，发送消息，断言 fake CLI 收到对应配置。

- [x] **Step 3: 验证 group conversation**

在 group conversation 中让至少两个不同 role 的 Agent 执行，断言每个 Agent 使用各自的 `model` 和 `thinkingEffort`，没有串配置。

- [x] **Step 4: 验证 pipeline**

执行完整阶段：

```text
codex_manager → kimi_worker → opencode_reviewer → codex_final_review
```

断言每个阶段都从对应 Workspace Agent 读取配置，Codex fallback 场景不携带 OpenCode 参数。

- [x] **Step 5: 验证空值回退**

清空模型并设置 `thinkingEffort=auto`，断言最终参数与修改前的默认配置一致。

### Task 7：完整验收、回归和计划收尾

**Files:**

- Read: `agent-memory/MODEL_SWITCH_PLAN.md`
- Read: `agent-memory/CLI_CAPABILITY_MATRIX.md`

- [x] **Step 1: 运行全部自动化检查**

```powershell
pnpm install --frozen-lockfile
pnpm -r run build
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server test
pnpm --filter @agentos/web build
```

Expected: 所有命令退出码为 0。

- [x] **Step 2: 执行手工验收 AC-1 至 AC-8**

本次已完成 API、SQLite、fake CLI、自动化回归和 Chrome 真实 UI 验收：选择自定义模型与 `medium` 后保存，刷新页面重新打开仍显示保存值；再选择“使用默认模型”并保存，刷新后确认模型已清空且思考强度恢复 `auto`。随后使用临时新服务读取同一 SQLite，确认重启后值仍保持默认回退状态。

## 5. 验收标准

### AC-1：模型选择可持久化

步骤：

1. 打开 Agent 编辑器。
2. 选择或输入一个模型标识，例如 `test-switch-model`。
3. 选择思考强度 `medium`（前提是当前 CLI capability 支持）。
4. 保存。
5. 刷新页面并重新打开同一 Agent。

通过条件：模型和思考强度仍显示为保存值；重启服务后值仍存在。

### AC-2：模型真正传递到 CLI

步骤：

1. 使用 fake CLI 或真实 CLI 执行一次 direct conversation。
2. 检查 `CLI_RUNTIME_RESOLUTION` 日志和 fake CLI 捕获结果。

通过条件：最终 `argv/env` 中出现所选模型；不能只在 Agent API 响应中出现。

### AC-3：思考强度真正传递到 CLI

步骤：

1. 分别选择 `low`、`medium`、`high`。
2. 对每个值执行一次支持该能力的 CLI。

通过条件：每个值对应矩阵中规定的 CLI 参数或环境变量；`auto` 不添加覆盖参数。

### AC-4：不支持能力时拒绝保存

步骤：

1. 选择 capability 仅包含 `auto` 的 CLI Agent。
2. 构造 PATCH `thinkingEffort=high`。

通过条件：服务端返回 400，数据库值不变，前端显示明确错误；不能静默保存或伪造生效。

### AC-5：Kimi API Key 模式正确

步骤：

1. 设置 `AGENTOS_KIMI_API_KEY`。
2. 设置一个非默认模型。
3. 执行 Kimi Agent。

通过条件：最终使用 `KIMI_MODEL_NAME` 的配置值；最终 CLI 参数不会被旧逻辑错误删除；日志不包含 API Key。

### AC-6：OpenCode/Codex fallback 正确

步骤：

1. 将 OpenCode 配置为 Codex command。
2. 给 OpenCode role 设置模型和思考强度。
3. 执行 reviewer 阶段。

通过条件：使用 Codex capability；不出现 OpenCode 专属 `--model` 或其他无效参数。

### AC-7：三条执行链路回归

通过条件：

- direct conversation 成功完成。
- group conversation 中各 Agent 使用自己的配置。
- 完整 pipeline 四阶段成功完成。
- 任一 CLI 返回非零退出码时，现有失败处理语义不被改变。

### AC-8：自动化检查全部通过

通过条件：Task 7 的全部 build/test 命令退出码为 0，新增测试覆盖模型、思考强度、空值、API Key、fallback 和原始数组不可变性。

## 6. 失败处理和回滚规则

- 数据库迁移失败时不得删除旧列或覆盖旧 Agent 配置；修复迁移后重新启动。
- CLI capability 无法验证时，该 CLI 只允许 `auto`，不允许通过猜测继续开发非 auto 参数。
- 运行时解析失败时抛出包含 `agentName`、`cliKind` 和配置字段名的错误，不包含密钥。
- 如果只完成数据库/API 而未完成 CLI 真实参数验证，不得将功能标记为完成。
- 本功能不要求修改已有 `cliArgs` 数据；模型和思考强度属于独立配置，避免把用户自定义参数永久重写。

## 7. 完成定义

只有同时满足以下条件，计划才算完成：

1. `model` 和 `thinkingEffort` 可从 UI 保存并从 SQLite 恢复。
2. Server API 对 capability 不支持的值返回 400。
3. `CLIExecutor` 在 spawn 前产生最终运行时配置。
4. fake CLI 或真实 CLI 验证了最终参数/环境变量，而不是只验证中间对象。
5. direct、group、pipeline 三条路径均通过回归验证。
6. Task 7 的 build/test 命令全部通过。
7. `CLI_CAPABILITY_MATRIX.md` 与当前实际 CLI 版本一致。

## 8. 本次执行验收记录（2026-07-13）

| 验收项 | 结果 | 证据 |
|---|---|---|
| AC-1 模型和思考强度持久化 | 通过 | Chrome 真实 UI 完成自定义模型 + `medium` 保存、刷新恢复；随后完成空模型 + `auto` 清除回退；临时新服务读取同一 SQLite 成功 |
| AC-2 模型传递到 CLI | 通过 | `executor.test.ts` 的真实 fake Codex spawn 捕获最终 `argv` |
| AC-3 思考强度传递到 CLI | 通过 | Codex `high`、OpenCode role→Codex `medium` 通过真实 fake pipeline；Kimi 仅 `auto` |
| AC-4 不支持能力返回 400 | 通过 | Agent PATCH 路由测试覆盖 Kimi `high` |
| AC-5 Kimi API Key 模式 | 通过 | 运行时解析测试验证 `KIMI_MODEL_NAME` 和移除 `-m` |
| AC-6 OpenCode/Codex fallback | 通过 | `runner.test.ts` 验证 reviewer 使用 Codex 映射，不使用 OpenCode 参数 |
| AC-7 direct/group/pipeline 回归 | 通过 | server direct/group 测试；runner fake CLI 四阶段真实 spawn 测试 |
| AC-8 自动化检查 | 通过 | `pnpm install --frozen-lockfile`、`pnpm -r run build`、agent-core 60/60、server 30/30 |

验收闭环：自动化测试覆盖运行时参数、API、SQLite 迁移/恢复、空值清除和多阶段执行链；Chrome 真实 UI 覆盖选择、保存、刷新恢复与默认回退；临时新服务再次读取同一 SQLite，确认持久化不依赖当前页面状态。

预计开发时间：**2–4 小时，不含 CLI 能力排查和完整手工验收**。当前矩阵结论是 Kimi/OpenCode 只暴露 `auto`，Codex 使用已记录的 `-c model_reasoning_effort=<effort>` 映射；如果未来 CLI 版本改变参数，必须先更新矩阵和对应运行时测试，不能用提示词替代真实能力。

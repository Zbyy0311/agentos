# CLI 模型发现与思考强度同步实施计划

> **执行说明：** 本文是 AgentOS 当前仓库的可执行实施计划。每个任务都包含明确的文件、接口、测试命令和通过条件；执行时按任务顺序推进，任何一项测试未通过都不能标记整体完成。

**目标：** 读取用户本机 CLI 已配置或已缓存的模型，并在 AgentOS 的 Agent 编辑器中提供刷新、选择和持久化能力，同时保证模型及思考强度最终传递到真实 CLI。

**架构：** Server 增加独立的 `CliModelDiscovery` 服务，按 CLI 类型使用适配器读取本地模型来源。发现结果只在内存中短暂缓存，不写回用户 CLI 配置；`GET /agents` 返回缓存结果，刷新接口强制重新读取。读取失败时返回静态 capability 和可见的来源/警告，不能让模型发现故障阻断聊天执行。

**技术栈：** TypeScript、Node.js `node:test`、Vitest、Express、SQLite、Next.js/React、PowerShell CLI 验收。

## 全局约束

- 模型发现是只读操作，不修改 `~/.codex`、`~/.kimi-code`、OpenCode 配置和 CLI 账号状态。
- 不读取、记录或返回 API Key、OAuth token、credentials 文件内容。
- 当前思考强度公共类型保持 `auto | low | medium | high`；CLI 暴露的未知强度不能被猜测性地传给 CLI。
- 当前 `model` 和 `thinkingEffort` 的 SQLite 持久化及运行时参数映射必须保持兼容。
- 原有 `cliArgs` 必须复制后再处理，不能原地改写工作区配置。
- 发现失败必须降级到静态 capability；模型列表为空不能导致 Agent 不可执行。
- 模型 ID 与显示名称分开保存；运行 CLI 使用模型 ID，UI 优先显示显示名称。
- 发现结果必须带 `source`、`stale` 和 `warning`，让用户知道列表来自实时配置、缓存还是静态回退。

## 文件责任图

| 文件 | 责任 |
|---|---|
| `packages/shared/src/types/index.ts` | 增加模型选项、发现来源和发现状态的共享类型 |
| `apps/server/src/services/CliModelDiscovery.ts` | 读取 Codex/Kimi/OpenCode 模型并做缓存、规范化和降级 |
| `apps/server/src/services/CliModelDiscovery.test.ts` | 用临时 fixture 验证三类 CLI 的解析、过滤、缓存和失败回退 |
| `apps/server/src/routes/conversations.ts` | 将发现结果合并到 Agent capability，并提供强制刷新接口 |
| `apps/server/src/routes/conversations.test.ts` | 验证 Agent API 返回模型、刷新结果和发现失败时的静态回退 |
| `apps/server/src/routes/modelDiscovery.test.ts` | 用注入的发现器验证列表响应和强制刷新请求 |
| `apps/web/src/components/chat/AgentEditor.tsx` | 显示模型来源、刷新按钮和发现到的模型，保留自定义模型入口 |
| `apps/web/src/app/workspace/[id]/page.tsx` | 调用刷新接口并将服务端返回的 Agent 写回页面状态 |
| `agent-memory/CLI_CAPABILITY_MATRIX.md` | 记录本机 CLI 版本、模型来源和不可验证项 |
| `agent-memory/MODEL_SWITCH_PLAN.md` | 链接本计划，并补充动态发现的验收闭环 |

---

## Task 1：定义共享模型发现数据结构

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Test: `apps/server/src/services/CliModelDiscovery.test.ts`

**Interfaces:**

```ts
export type ModelDiscoverySource = 'live' | 'cache' | 'config' | 'fallback';

export interface AgentModelOption {
  id: string;
  label: string;
  thinkingEfforts: ThinkingEffort[];
  defaultThinkingEffort: ThinkingEffort;
}

export interface ModelDiscoveryResult {
  cliKind: AgentCapability['cliKind'];
  models: AgentModelOption[];
  source: ModelDiscoverySource;
  stale: boolean;
  discoveredAt: string;
  warning?: string;
}
```

- [ ] **Step 1: 写失败测试**

```ts
test('normalizes a model option without exposing unsupported thinking levels', () => {
  const result = normalizeModelOption({
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh'],
  });

  assert.deepEqual(result.thinkingEfforts, ['low', 'medium', 'high']);
  assert.equal(result.defaultThinkingEffort, 'medium');
});
```

- [ ] **Step 2: 运行失败测试**

```powershell
pnpm --filter @agentos/server test -- src/services/CliModelDiscovery.test.ts
```

预期：失败原因是 `normalizeModelOption` 尚未导出或类型尚未定义，而不是测试环境启动失败。

- [ ] **Step 3: 写最小类型和规范化函数**

规范化规则：保留模型 ID；没有显示名称时使用 ID；思考强度只保留四个公共值；默认值不在保留集合时使用 `auto`。

- [ ] **Step 4: 重新运行测试**

预期：该测试通过，其他 server 测试不受影响。

---

## Task 2：实现 Codex 模型缓存读取

**Files:**

- Create: `apps/server/src/services/CliModelDiscovery.ts`
- Test: `apps/server/src/services/CliModelDiscovery.test.ts`

**输入来源：** `CODEX_HOME/models_cache.json`，未设置时使用 `USERPROFILE/.codex/models_cache.json`。只读取以下字段：`models[].slug`、`models[].display_name`、`models[].default_reasoning_level`、`models[].supported_reasoning_levels[].effort`、`models[].visibility`。

**接口：**

```ts
export interface ModelDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  cacheTtlMs?: number;
}

export class CliModelDiscovery {
  constructor(options?: ModelDiscoveryOptions);

  discover(input: {
    cliCommand: string;
    role: AgentRole;
    fallbackModels: AgentModelOption[];
    fallbackThinkingEfforts: ThinkingEffort[];
    forceRefresh?: boolean;
  }): Promise<ModelDiscoveryResult>;
}
```

- [ ] **Step 1: 写 Codex fixture 失败测试**

```ts
test('reads visible Codex models from models_cache.json', async () => {
  const root = createFixtureRoot({
    models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
      { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
    ],
  });
  const result = await new CliModelDiscovery({ env: { CODEX_HOME: root } }).discover(codexInput());

  assert.equal(result.source, 'cache');
  assert.deepEqual(result.models.map(model => model.id), ['gpt-5.5', 'gpt-5.6-luna']);
  assert.deepEqual(result.models[0].thinkingEfforts, ['low', 'medium', 'high']);
});
```

- [ ] **Step 2: 运行并确认失败**

```powershell
pnpm --filter @agentos/server test -- src/services/CliModelDiscovery.test.ts
```

预期：失败，因为发现器尚未读取 fixture。

- [ ] **Step 3: 实现最小 Codex 解析器**

实现要求：JSON 无效、文件缺失、模型数组为空都抛出内部发现错误，由上层统一转为 fallback；隐藏模型、无 ID 模型和重复 ID 必须过滤；不返回原始 JSON。

- [ ] **Step 4: 运行 Codex 单测**

预期：Codex fixture 测试通过，source 为 `cache`，模型 ID 和支持的思考强度准确。

---

## Task 3：实现 Kimi 和 OpenCode 模型读取

**Files:**

- Modify: `apps/server/src/services/CliModelDiscovery.ts`
- Test: `apps/server/src/services/CliModelDiscovery.test.ts`

**Kimi 来源：** `KIMI_CODE_HOME/config.toml` 或 `USERPROFILE/.kimi-code/config.toml`，解析 `[models."<id>"]` 区块中的 `display_name`。不读取 credentials。

**OpenCode 来源顺序：**

1. 若 `AGENTOS_OPENCODE_MODELS_FILE` 存在，读取该 JSON fixture/config。
2. 若 CLI 可执行，尝试 `opencode models --json`，限制超时 3 秒，只接受 JSON 标准输出。
3. 若两者都不可用，返回 fallback，并带 warning。

- [ ] **Step 1: 写 Kimi/OpenCode 失败测试**

```ts
test('reads Kimi model aliases from config.toml without reading credentials', async () => {
  const root = createFixtureRoot();
  writeFileSync(join(root, 'config.toml'), [
    'default_model = "kimi-code/kimi-for-coding"',
    '[models."kimi-code/kimi-for-coding"]',
    'display_name = "Kimi For Coding"',
    '[models."kimi-code/kimi-for-coding-highspeed"]',
    'display_name = "Kimi Highspeed"',
  ].join('\n'));
  const result = await new CliModelDiscovery({ env: { KIMI_CODE_HOME: root } }).discover(kimiInput());

  assert.equal(result.source, 'config');
  assert.deepEqual(result.models.map(model => model.id), [
    'kimi-code/kimi-for-coding',
    'kimi-code/kimi-for-coding-highspeed',
  ]);
});

test('returns fallback when OpenCode is unavailable', async () => {
  const result = await new CliModelDiscovery({ env: { PATH: '' } }).discover({
    ...opencodeInput(),
    fallbackModels: [{ id: 'fallback/model', label: 'Fallback model', thinkingEfforts: ['auto'], defaultThinkingEffort: 'auto' }],
  });

  assert.equal(result.source, 'fallback');
  assert.equal(result.stale, true);
  assert.equal(result.models[0].id, 'fallback/model');
  assert.match(result.warning ?? '', /OpenCode/i);
});
```

- [ ] **Step 2: 运行失败测试**

预期：Kimi 解析和 OpenCode fallback 测试均失败，失败原因是对应发现分支未实现。

- [ ] **Step 3: 实现 Kimi 配置解析和 OpenCode JSON 读取**

OpenCode JSON 只接受 `provider.<provider>.models` 下的键，模型 ID 规范化为 `<provider>/<model>`；不支持把任意配置值当成模型。

- [ ] **Step 4: 运行发现器全量测试**

```powershell
pnpm --filter @agentos/server test -- src/services/CliModelDiscovery.test.ts
```

预期：Codex、Kimi、OpenCode fixture、fallback、去重和未知思考强度过滤全部通过。

---

## Task 4：增加缓存、刷新接口和 Agent capability 合并

**Files:**

- Modify: `apps/server/src/routes/conversations.ts`
- Modify: `apps/server/src/index.ts`（仅当需要注入服务）
- Test: `apps/server/src/routes/conversations.test.ts`
- Test: `apps/server/src/routes/modelDiscovery.test.ts`

**接口：**

```text
GET  /api/workspaces/:workspaceId/agents
POST /api/workspaces/:workspaceId/agents/:agentId/models/refresh
```

响应中的 `agent.capability` 增加：

```ts
{
  models: string[];
  modelOptions: AgentModelOption[];
  modelSource: ModelDiscoverySource;
  modelSourceStale: boolean;
  modelSourceWarning?: string;
}
```

- [ ] **Step 1: 写 API 失败测试**

测试三个行为：

1. `GET /agents` 返回 Codex fixture 中的模型。
2. `POST /agents/:id/models/refresh` 强制读取修改后的 fixture，不使用旧缓存。
3. OpenCode 发现失败时仍返回原有 fallback 模型，HTTP 状态为 200，并带 warning。

- [ ] **Step 2: 运行 API 失败测试**

```powershell
pnpm --filter @agentos/server test -- src/routes/conversations.test.ts
```

预期：新增断言失败，既不能因为还没有动态字段而误通过，也不能因为 CLI 未安装而让测试依赖本机环境；测试必须注入临时 fixture/发现器。

- [ ] **Step 3: 接入发现服务和短缓存**

缓存键必须包含 `cliKind + 配置路径/命令`；默认 TTL 为 30 秒。普通 `GET` 使用未过期缓存，刷新接口传 `forceRefresh=true`。发现异常只转成 fallback result，不向聊天接口抛出未处理异常。

- [ ] **Step 4: 验证 API**

预期：普通列表、强制刷新、fallback、已有 `model`/`thinkingEffort` 持久化和不支持 effort 的 400 回归测试全部通过。

---

## Task 5：前端显示来源并支持刷新

**Files:**

- Modify: `apps/web/src/components/chat/AgentEditor.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Test: `apps/web/src/components/chat/AgentEditor.test.tsx`（若当前测试环境不支持组件测试，则用 `web build` 加 API 集成验收替代）

- [ ] **Step 1: 写前端行为测试**

必须覆盖：

- 模型下拉显示发现模型的 label，但提交其 id。
- 显示“来源：CLI 缓存/配置/回退”。
- 点击“刷新模型”后重新加载 Agent capability。
- 当前自定义模型不在发现列表时仍显示并可保存。
- 选择模型后思考强度只能显示该模型和当前 CLI 共同支持的四个公共值。

- [ ] **Step 2: 运行失败测试或构建检查**

```powershell
pnpm --filter @agentos/web build
```

预期：在 UI 尚未接入刷新字段时，组件断言或类型检查失败。

- [ ] **Step 3: 实现 UI 最小改动**

保留“使用默认模型”和“自定义模型”入口；刷新失败不清除当前已保存模型；保存仍提交空字符串作为显式清除信号。

- [ ] **Step 4: 运行 Web 构建和浏览器验收**

预期：模型下拉能看到本机 Codex cache 中的 `gpt-5.5`、`gpt-5.6-luna` 等模型；保存后刷新页面仍保持模型和思考强度；OpenCode 不可用时仍可手动填写模型。

---

## Task 6：CLI 最终参数和安全性回归

**Files:**

- Modify: `packages/agent-core/src/capabilities.ts`（仅在动态模型能力需要合并时）
- Modify: `packages/agent-core/src/executor.ts`（仅在动态模型能力需要合并时）
- Test: `packages/agent-core/src/executor.test.ts`
- Test: `packages/agent-core/src/runner.test.ts`

- [ ] **Step 1: 写失败回归测试**

必须验证：

- 选择发现的 Codex 模型后最终 argv 包含 `-m <model>`。
- `thinkingEffort=medium` 仍写入 `-c model_reasoning_effort=medium`。
- Kimi API Key 模式仍写入 `KIMI_MODEL_NAME`，不会把 key 写入日志。
- 发现模型列表变化不会修改原始 `cliArgs`。
- fallback 模型也能正常进入现有运行时解析。

- [ ] **Step 2: 运行失败测试**

```powershell
pnpm --filter @agentos/agent-core test
```

预期：若发现服务只改了 UI/API 而未经过 executor，最终参数断言必须失败。

- [ ] **Step 3: 仅在失败时调整运行时类型/映射**

不新增 prompt 模拟思考强度，不把未知 CLI 参数直接透传；只修复动态模型 ID 与既有 runtime resolver 的连接。

- [ ] **Step 4: 运行 agent-core 全量测试**

预期：所有原有测试及新增最终 argv/env 测试通过。

---

## Task 7：真实环境验收与文档回写

**Files:**

- Modify: `agent-memory/CLI_CAPABILITY_MATRIX.md`
- Modify: `agent-memory/MODEL_SWITCH_PLAN.md`
- Modify: `agent-memory/LOG.md`

### 自动化命令

```powershell
pnpm install --frozen-lockfile
pnpm -r run build
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server test
pnpm --filter @agentos/web build
```

通过条件：所有命令退出码为 `0`；agent-core、server 测试输出无失败用例；web 构建无 TypeScript 错误。

### 真实 CLI 验收

1. 使用本机 `CODEX_HOME/models_cache.json`，打开 Codex Agent 编辑器，确认出现至少两个当前缓存中的模型，并确认刷新后重新读取文件内容。
2. 使用本机 `~/.kimi-code/config.toml`，确认 Kimi 模型列表与配置中的模型区块一致，不显示 credentials 内容。
3. OpenCode CLI 不可执行时，确认 AgentOS 显示 fallback 和 warning，仍能保存自定义模型。
4. 选择模型和 `medium`，保存后重启 server，再次打开编辑器确认 SQLite 值仍存在。
5. 发送一次 direct conversation，用 fake CLI 捕获最终 argv/env，确认模型和思考强度不是只停留在 UI/API。
6. 选择不支持非 `auto` 的 Agent 提交 `high`，确认返回 400 且数据库原值不变。

### 验收标准

| 编号 | 标准 | 必须证据 |
|---|---|---|
| AC-1 | Codex 本地模型缓存可读取 | 发现器测试 + 浏览器下拉显示实际缓存模型 |
| AC-2 | Kimi 本地模型配置可读取 | TOML fixture 测试 + 本机配置核对 |
| AC-3 | OpenCode 不可用时安全回退 | fallback API 测试，HTTP 200 且带 warning |
| AC-4 | 刷新不是假刷新 | 修改 fixture 后 refresh 返回新模型，旧缓存不复用 |
| AC-5 | 模型 ID 真正传入 CLI | fake CLI 捕获最终 argv/env |
| AC-6 | 思考强度仍受 capability 校验 | 不支持值返回 400，数据库不改变 |
| AC-7 | 保存、重启、再读取一致 | SQLite 重启测试 + 浏览器刷新验收 |
| AC-8 | 全量回归通过 | build、agent-core、server、web 命令全部退出码 0 |

## 回滚规则

- 模型发现服务可以整体关闭，`GET /agents` 继续返回静态 capability，聊天执行不受影响。
- 发现缓存只存在内存，不需要数据库迁移；回滚不删除任何用户配置。
- 若某个 CLI 配置格式改变，先禁用该适配器并返回 fallback/warning，再更新 fixture、解析器和能力矩阵。
- 未完成 AC-1～AC-8 前，不将“动态读取模型”标记为完成。

## 执行顺序

`Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7`

每个 Task 都必须完成“写失败测试 → 观察正确失败 → 最小实现 → 测试通过”闭环；任何只通过 build、但没有最终 CLI argv/env 或真实 UI 证据的结果，都不能作为功能可用证明。

## 当前执行记录

| 项目 | 结果 | 证据 |
|---|---|---|
| 发现器单元测试 | 通过 | Codex、Kimi、OpenCode fixture、CLI JSON 数组、CLI 纯文本、缓存刷新、fallback 共 8 项通过 |
| Agent API 测试 | 通过 | `modelDiscovery.test.ts` 验证列表和强制刷新 |
| Server 全量测试 | 通过 | 39/39 |
| Agent-core 全量测试 | 通过 | 60/60 |
| Web 构建 | 通过 | Next.js 类型检查和生产构建通过 |
| 全仓构建 | 通过 | `pnpm -r run build` 退出码 0 |
| 本机 Codex 发现 | 通过 | 读取 7 个模型，包括 `gpt-5.5`、`gpt-5.6-luna` |
| 本机 Kimi 发现 | 通过 | 读取 2 个 `config.toml` 模型，不读取 credentials |
| 本机 OpenCode 发现 | 通过 | 使用工作区配置的 OpenCode 1.17.11 可执行文件读取 9 个模型，兼容纯文本 `models` 输出；不可执行时仍保留 fallback/warning |

浏览器自动化需要 Playwright CLI；当前环境的 Browser 插件未提供，且 `npx` 获取 Playwright 包受到 npm cache/网络权限限制。因此浏览器截图验收作为剩余手工步骤保留，API、构建和真实本机配置读取已经完成。

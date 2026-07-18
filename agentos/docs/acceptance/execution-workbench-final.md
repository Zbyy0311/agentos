# AgentOS 计划 B：执行工作台验收报告

## 范围

本阶段保留 `CLIExecutor → Adapter → EventBus/SQLite → SSE → React` 主链路，新增持久化执行序列、可恢复 RunStep、实时任务树、Markdown/GFM 消息、静态执行档案和 Artifact 预览。

## 已交付

| 模块 | 交付内容 | 自动验收 |
|---|---|---|
| B1 事件序列 | SQLite 原子分配 `AgentEvent.sequence`；schemaVersion 2；eventId 幂等；旧数据一次性回填；先持久化后广播；SSE cursor 与 sequence 分离 | EventBus、SQLite、迁移、并发 1000 事件测试 |
| B2 RunStep | stable key、父子/同级序号唯一、状态机、attempt、waiting resume、启动恢复、Run Details steps | RunStepService、ConversationService、recovery、runs 路由测试 |
| B3 工作台 | 当前动作、工具历史、统计、任务树、步骤实时 upsert、事件去重、刷新恢复 | runSteps、ExecutionInspector、Web build |
| B4 消息体验 | GFM 表格/任务列表/代码块/diff；原始 HTML 不执行；外链和图片限制；滚动锚点；composer 可调整高度；消息超过 100 条启用虚拟列表；消息关联 runId | Markdown、滚动、Web tests/build |
| B5 执行档案 | 按 persisted sequence 排序；静态类型/Agent/失败/文件/文本筛选；Artifact 图片和小文本内联预览，大文件降级；CSP、nosniff、MIME 降级 | archive、artifact route tests |
| B6 验收工具 | 大数据 fixture、性能门槛脚本、PowerShell 总验收入口、人工浏览器 Gate 说明 | `scripts/verify-execution-workbench.ps1` |

## 性能 fixture

`verify-execution-workbench.mjs` 构造 1000 个事件、100 个工具事件、20 个步骤、500 条消息规模所需的消息/执行数据、5 个 Artifact，并检查：

- `buildExecutionArchive` 小于 50ms；
- SSE 重放 300 个步骤事件不产生重复步骤；
- 设置 `AGENTOS_VERIFY_API_URL` 后，Run Details HTTP 查询必须小于 500ms；未设置时脚本明确输出跳过原因。

## 浏览器人工 Gate

自动化测试不替代真实浏览器确认。启动服务后，在实际工作区检查：

1. Markdown 表格、任务列表、代码块、diff 的显示；
2. 外部图片被隐藏，Artifact 图片可以预览；
3. 输入框拖动高度、Shift+Enter 换行、消息区域在用户滚离底部时不抢滚动；
4. 超过 100 条消息仍可滚动，刷新后 RunStep 和执行档案顺序保持一致；
5. Inspector 显示当前动作、任务树、工具历史和统计，不显示 reasoning 原文。

该人工 Gate 在计划 C 的 Playwright 固化前保持为明确的手工验收项。

## 运行命令

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
pnpm.cmd --filter @agentos/web exec node --import tsx ../../scripts/verify-execution-workbench.mjs
git diff --check
```

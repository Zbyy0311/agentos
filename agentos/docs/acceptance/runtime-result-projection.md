# Runtime Result Projection 验收记录

状态：R4 数据正确性工程验收通过；真实 Provider 新 Run 和人工 Visual Gate 仍待补验。

## 原则

Runtime Projection 只消费已有结构化 Run/Execution/Event/Step/File/Artifact 数据。模型 Markdown 是可读原文，不是执行事实来源；页面不会因为模型写出“测试通过”就覆盖服务端的 failed/cancelled/waiting 状态。

## 实施边界

- `apps/web/src/lib/runtimeProjection.ts`：workspace/conversation/run scope 校验、ID 归属过滤、事件/步骤/文件/产物去重、序号排序和 SSE 合并。
- `apps/web/src/components/chat/RuntimeResultProjection.tsx`：步骤、文件、产物、详情四个结构化视图。
- `apps/web/src/app/workspace/[id]/page.tsx`：按 workspace + run 缓存详情；切换会话后校验请求上下文；活动流只接受当前 run。
- `apps/web/src/components/runs/ArtifactPreviewDialog.tsx`：404/403/超大文件/metadata-only 明确反馈，不回退到其他 Run。
- 不新增 Server endpoint、不新增轮询、不改变发送/取消/API 契约。

## R4 验收矩阵

| 条目 | 等级 | 结果 | 证据 |
|---|---|---|---|
| R4-01 workspace/run/conversation/Agent 归属 | MUST | PASS | fixture 同时包含 run-a/run-b、foreign execution；projection 仅保留 run-a |
| R4-02 同一 Run 只展示一份结果 | MUST | PASS | `ChatPanel` 在存在 projection 时不再额外渲染 chat Artifact shelf；projection 组件仅挂载一次 |
| R4-03 Markdown 与 Runtime Truth 分离 | MUST | PASS | failed Run 的 `failureReason` 优先于模型原文；原文仍通过消息 Markdown 展示 |
| R4-04 SSE eventId/sequence 去重 | MUST | PASS | 同 eventId 的旧 sequence 被忽略，新 sequence 替换旧事件；foreign run 被忽略 |
| R4-05 文件/Artifact 受控展示 | MUST | PASS | modified+deleted 不跨 Run 合并；404/403/image error/超大文件分别给出可理解提示 |
| R4-06 详情接口与脱敏边界 | SHOULD | PASS | 复用既有 `/api/workspaces/{workspaceId}/runs/{runId}`，普通卡片不放 Provider stdout |
| R4-07 缓存、迟到响应、切会话 | MUST | PASS | 同一 workspace/run 的 pending Promise 复用；响应完成后再次校验当前 conversation；失败请求从 cache 移除 |
| R4-08 空/加载/错误/缺少观测 | MUST | PASS | Inspector 缺少执行证据时显示“尚未开始”；token/file 未提供时显示明确的“未提供/未记录” |

## 测试夹具覆盖

- 两个 Run、两个 Execution、同 Agent retry attempt。
- 重复 eventId、迟到旧 sequence、foreign run event。
- 同一路径 modified + deleted、重复 file change。
- 重复 Artifact ID、foreign Artifact、没有明确 execution 的 Run-level Artifact。
- workspace、conversation、run 任一 scope 不匹配时返回 `undefined`。

## 运行结果

- `pnpm --filter @agentos/web test`：228 passed，包含 `runtimeProjection.test.ts`。
- `pnpm --filter @agentos/web exec tsc --noEmit`：PASS。
- `pnpm --filter @agentos/web build`：PASS。
- 浏览器 DOM 检查：`[data-runtime-result]` 在当前 Run 只出现 1 个；布局矩阵页面无横向滚动。

## 未执行/限制

- 尚未使用真实 Provider 发起一次新的 running → completed/failed/cancelled 流式 Run；目前 R4 的乱序、重复、跨 Run 证明来自确定性测试夹具。
- 尚未完成 200 条消息的生产数据压测；缓存逻辑保证不按消息逐条取详情，但需真实数据量回归。
- 真实 Artifact 权限服务的 403/404 浏览器路径需要后端环境提供对应资源；组件逻辑已覆盖响应分支和 image `onError`。

## 回滚边界

删除/回滚 `runtimeProjection.ts`、`runtimeProjection.test.ts`、`RuntimeResultProjection.tsx` 及 workspace page/ChatPanel 中对应的 projection wiring 即可移除 R4 展示；不影响原有消息、执行流和 Inspector 的基础投影。提交 SHA 以最终 git log 为准。

# 计划 C6 验收：工具审批透传基础设施

## 已实现

- Shared 定义 `approval.requested` / `approval.resolved` 事件、审批请求、决策和授权 grant 类型。
- Adapter 接口声明可选 `encodeApprovalDecision`，不支持审批的 provider 不会被伪造为支持。
- `ApprovalRegistry` 对 request resolve 和 grant revoke 提供幂等语义。
- `ToolRiskClassifier` 对读取、写入和破坏性命令给出 low/high/critical 标签。
- Server 提供创建/resolve approval request、创建/revoke grant 的本地 API，UI 提供审批卡和授权面板。

## 验收命令

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/ApprovalRegistry.test.ts src/services/ToolRiskClassifier.test.ts
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/web test
```

## 边界

当前 provider 原生 stdin 审批等待仍由后续 provider-runtime 阶段接入；本阶段先完成类型、能力边界、风险分类、API 和 UI，不对不支持审批的 CLI 伪造等待能力。

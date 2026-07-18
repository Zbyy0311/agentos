# 计划 C5 验收：Run Intent 与工作区策略

## 已实现

- `ask`、`execute`、`review` 三种 intent 写入 `AgentRun`。
- Run 创建时保存完整 `RuntimePolicy` 快照，Run Details 展示 workspace、network、tool 和 enforcement。
- Codex 的 ask/review 使用 read-only CLI flag；无法证明只读能力的 provider 在 ask/review 启动前返回 409。
- execute 仍严格遵循 Agent permissions，不因为 UI 模式绕过权限。
- Composer 提供询问/执行/审查选择器，消息请求携带 `intent`。

## 验收命令

```powershell
pnpm.cmd --filter @agentos/agent-core test -- src/runtimePolicy.test.ts
pnpm.cmd --filter @agentos/server exec tsc --noEmit
pnpm.cmd --filter @agentos/web test
```

## 结果

策略矩阵和前端回归测试通过；旧 Run 缺失快照时按 execute 兼容读取。

# Codex Runtime 基线验收

- 日期：2026-07-17
- 分支：`codex/agentos-current`
- HEAD：`ca1313bc3b970f06e7ed83d30d32f519f8739eac`

## 源码基线

以下 v2 源码均存在：

- `apps/server/src/services/ConversationService.ts`
- `apps/server/src/store/SqliteStore.ts`
- `apps/web/src/components/runs/RunDetails.tsx`

## Streaming 基线

`ConversationAgentRunner` 已验证普通回复按非空 chunk 产生独立 `streaming_response` 事件；空 done 不产生空事件；跨 chunk 的 waiting-user marker 不泄漏为普通回复。

## 全仓基线命令

| 命令 | 结果 |
|---|---|
| `pnpm --filter @agentos/agent-core test` | PASS，101 tests |
| `pnpm --filter @agentos/server test` | PASS，104 tests |
| `pnpm --filter @agentos/web build` | PASS |
| `pnpm -r run build` | PASS |

## 外部 Codex 状态

`Get-Command codex` 找到：

```text
C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0\app\resources\codex.exe
```

`codex --version` 与 `codex exec --help` 均返回 `EPERM/Access denied`。因此真实 Codex 在本基线标记为 `UNAVAILABLE`，不能替代 Task 10 的真实 Gate。KimiCode/OpenCode 本阶段不验证。


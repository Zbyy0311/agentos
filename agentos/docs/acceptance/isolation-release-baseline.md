# Isolation Release Baseline

日期：2026-07-18

- 分支：`codex/agentos-isolation-release`
- HEAD：`d6deeb24940c79f54aa99cfe1864cb16bf432cad`
- Node：`v24.18.0`
- pnpm：`11.11.0`
- Git：`2.45.1.windows.1`
- 基线说明：从 C 阶段分支创建，保留此前未提交的 C/用户修改，不执行清理或 reset。
- D1 首个验证：`WorktreeManager.test.ts` 2/2 通过，server TypeScript 检查通过。

计划 D 后续必须继续使用临时 Git fixture 和显式 recovery bundle 验证；不得把绝对 Worktree 路径写入公开 API 或事件。

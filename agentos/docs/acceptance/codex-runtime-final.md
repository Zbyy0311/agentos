# AgentOS Codex Runtime 验收记录

- 日期：2026-07-17
- 分支：`codex/agentos-current`
- 基线 HEAD：`ca1313bc3b970f06e7ed83d30d32f519f8739eac`
- 范围：Codex-first Streaming、结构化工具事件、RuntimeArtifact、Artifact Shelf、逐字队列和 SSE 回放。

## 自动化结果

| 检查 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm -r test` | PASS（agent-core 101、server 105、web 64） |
| `pnpm -r run build` | PASS |
| `verify-next-optimization-acceptance.ps1` | PASS |
| `verify-codex-runtime-e2e.mjs` fixture/plain/server gate | PASS |
| `verify-real-codex-runtime-e2e.ps1` | PASS（真实 AgentOS + Codex 0.144.0-alpha.4） |
| `git diff --check` | PASS |

确定性 server gate 会启动隔离的已构建服务器，使用 Codex JSONL fixture 完成 workspace、conversation、SSE、工具事件、assistant 输出、usage、文件变化、diff、测试 report、PNG image、公开 log、RunDetails、Artifact content 和 cursor 重连验收。fixture 还覆盖 untracked directory 展开以及 `.cmd` Codex capability probe。

## 已验证的运行时行为

- Codex JSONL 只投影为公开的 status、assistant、tool、usage、diagnostic 事件；raw JSONL 和私有 reasoning 不进入持久化记录。
- 工具事件按 call id 合并为 started → completed/failed；断流时未闭合工具会生成失败终态。
- RuntimeArtifact 类型覆盖 `file`、`diff`、`report`、`image`、`log`，内容快照不可覆盖，带 SHA-256、大小限制、归属校验和 metadata-only 降级。
- 文件变化使用 `git status --porcelain -uall`，避免把新增目录误当成可读取文件。
- Artifact content 路由校验 workspace、realpath、MIME、大小和安全响应头；图片只接受 PNG/JPEG/WEBP/GIF 魔数。
- 前端 Artifact Shelf、Tool Timeline、逐字符队列和历史 RunDetails 已通过 web test/build。

## 真实 Codex Gate

状态：**PASS**。

当前 `Get-Command codex` 指向：

```text
C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0\app\resources\codex.exe
```

直接执行 WindowsApps 路径仍会因权限返回 `EPERM/Access denied`。本次 Gate 在临时目录复制了同一版本的 `codex.exe` 与配套 `codex-code-mode-host.exe`，未修改安装目录，然后通过 AgentOS 真实 HTTP/SSE 链路完成受控任务：

- `executor.ts`：`DEFAULT_TIMEOUT_MS` 从 1000 改为 2000
- `npm test`：通过，`1 passed`
- Artifact：`file`、`diff`、`report`、`log`
- SSE：真实 tool started/completed、assistant output、done
- 内容路由：所有可用 Artifact 均成功读取

## 浏览器 Smoke

使用 Playwright CLI 在隔离 fixture 工作区完成了真实 UI 流程：

- 发送受控任务后，聊天最终回复下方显示 6 个 Artifact：`file`（`executor.ts`、`architecture.md`）、`diff`、`report`、`image`、`log`。
- 展开“思考进度”可看到队列、上下文、CLI、生成回复、完成五个阶段；RunDetails 中的事件、CLI 调用、文件变化和同一组 6 个 Artifact 保持一致。
- 刷新页面后 Artifact 仍为 6 个且没有重复；1280×800 与 1440×900 均可读，深浅色切换正常。
- 控制台为 0 error、0 warning（仅 React DevTools/Fast Refresh info）；SSE/取消/等待用户的状态机由 server 与 web 回归测试覆盖。

浏览器 fixture 使用 Windows `cmd.exe /d /s /c npm test` 执行测试，避免 Node 直接 `spawnSync('npm.cmd')` 在本机返回 `EINVAL`，因此最终报告为 `npm test passed`。

复现命令（`AGENTOS_CODEX_CLI` 必须指向同时具备 CLI 与 code-mode host 的可执行目录）：

```powershell
$env:AGENTOS_CODEX_CLI = 'C:\path\to\codex.exe'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-real-codex-runtime-e2e.ps1
```

KimiCode/OpenCode 不在本计划内，仍保持 plain fallback，后续分别建立独立适配计划和真实 Gate。

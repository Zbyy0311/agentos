# AgentOS 图片输入功能验收报告

## 1. 验收范围

本次实现覆盖：

- 对话输入区通过“添加图片”选择 PNG、JPEG、GIF、WebP。
- 在输入框直接粘贴剪贴板图片。
- 图片缩略图预览、移除、图片-only 消息发送。
- 图片消息落盘、SQLite 关联、历史消息回显和安全下载。
- Codex 使用 `--image` 参数传图，并通过 stdin 发送非交互 prompt，避免图片模式下 CLI 误判为无 prompt。
- Kimi/OpenCode 使用工作区文件路径提示传图。
- 未识别或不支持图片输入的 CLI 在保存消息前明确拒绝，不静默丢图。

## 2. 限制和安全规则

| 规则 | 值 |
| --- | --- |
| 支持格式 | PNG、JPEG、GIF、WebP |
| 单张大小 | 不超过 10 MB |
| 单条消息数量 | 不超过 5 张 |
| 单条消息总大小 | 不超过 25 MB |
| 保存目录 | 工作区 `.agentos/attachments/<conversationId>/` |
| 下载路径 | 工作区范围内的公开附件 URL，不暴露本地绝对路径 |

服务端会再次校验 MIME、Data URL、大小和数量，不能仅依赖浏览器校验。

## 3. 自动化验证结果

| 验收项 | 命令/测试 | 结果 |
| --- | --- | --- |
| agent-core 全量测试 | `pnpm --filter @agentos/agent-core test` | 70/70 通过 |
| 图片传输适配器 | `src/imageInput.test.ts` | Codex 参数、Kimi/OpenCode 路径提示、不支持 CLI、无图片场景均通过 |
| server 全量测试 | `pnpm --filter @agentos/server test` | 47/47 通过 |
| 图片服务 | `ConversationAttachmentService.test.ts` | 保存、格式校验、大小校验、清理均通过 |
| 图片消息接口 | `conversations.test.ts` | 图片-only 发送、历史回显、下载、删除后不可访问均通过 |
| 前端纯逻辑测试 | `apps/web/src/lib/*.test.ts` | 24/24 通过 |
| 前端 TypeScript | `tsc --noEmit -p apps/web/tsconfig.json` | 通过 |
| 前端生产构建 | `next build` | 通过 |
| server 生产构建 | `pnpm --filter @agentos/server build` | 通过 |

## 4. 手工验收步骤

启动 AgentOS 后，在任一直接会话中执行：

1. 点击输入区左侧回形针按钮，选择一张 PNG。
2. 确认输入区出现缩略图；点击缩略图右上角 `×`，确认可以移除。
3. 再选择图片，清空文字后点击发送，确认图片-only 消息成功发送并在消息记录中显示。
4. 复制一张本地截图，在输入框按 `Ctrl+V`，确认出现缩略图后发送。
5. 刷新页面或重新打开会话，确认历史图片仍可显示，点击图片可打开附件 URL。
6. 选择 PDF 或超过 10 MB 的图片，确认显示错误提示且不会发送。
7. 在不支持图片输入的自定义 CLI Agent 上发送图片，确认消息不会写入历史，界面显示明确错误。

## 5. 当前环境说明

用户手工验收已复现一次真实 Codex 图片发送失败：附件上传、保存和回显均正常，失败点是 Codex 非交互进程的 stdin prompt 传输。修复后，Codex 图片调用会保留 `--image` 参数并通过 stdin 发送 prompt，新增 executor 回归测试已通过。当前环境没有可用的浏览器自动化工具，因此未生成浏览器截图；仍建议用户重新发送一次图片做最终人工确认。当前 PATH 中检测到 `codex.exe` 和 `kimi.exe`，未检测到 `opencode`。

## 6. 结论

功能链路已具备可执行实现，自动化验收全部通过。重新启动 AgentOS 后，按第 4 节重试 Codex 图片发送；若成功，即可关闭本功能验收项。OpenCode 的真实 CLI 冒烟测试仍需在 OpenCode 可用时补做。

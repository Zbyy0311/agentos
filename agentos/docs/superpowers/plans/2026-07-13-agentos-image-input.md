# AgentOS 图片输入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AgentOS 对话增加图片粘贴、图片选择、预览、持久化及 Codex/KimiCode/OpenCode 的可验证图片传递能力。

**Architecture:** 浏览器把图片作为受限 Data URL 随消息请求发送；服务端校验后写入工作区 `.agentos/attachments`，SQLite 通过 `message_attachments` 关联消息与文件。Agent runner 通过独立的图片输入适配器选择 CLI 参数、工作区路径 prompt 或明确拒绝，避免静默丢图。

**Tech Stack:** React/Next.js、Tailwind CSS、Express、Node `fs/promises`、Node SQLite、TypeScript、Node test runner、Vitest。

## Global Constraints

- 只允许 PNG、JPEG、GIF、WebP；单文件不超过 10 MB；单条消息最多 5 张、总量不超过 25 MB。
- 图片文件必须落在 `<workspaceRoot>/.agentos/attachments/<conversationId>/`，文件名使用 UUID，不接受客户端路径。
- 不把 Base64 写入 SQLite，不把未经验证的 CLI 参数拼入命令。
- 没有可验证图片能力的 Agent 必须在执行前返回明确错误，不能创建执行记录。
- 每个新增生产函数必须先有会失败的测试，再写最小实现。

---

### Task 1: 建立共享附件类型与纯校验规则

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/web/src/lib/imageAttachments.ts`
- Create: `apps/web/src/lib/imageAttachments.test.ts`

**Interfaces:**
- `ConversationAttachment { id, name, mimeType, size, url }`
- `ConversationMessage.attachments?: ConversationAttachment[]`
- `ImageDraft { id, name, mimeType, size, dataUrl, previewUrl }`
- `validateImageDrafts(drafts): { ok: true } | { ok: false; error: string }`
- `isImageClipboardItem(item): boolean`

- [ ] **Step 1: Write failing tests**

测试以下行为：允许 PNG/JPEG/GIF/WebP；拒绝 PDF；拒绝大于 10 MB；第 6 张拒绝；总量大于 25 MB 拒绝；无文本但有图片时 `canSendMessage('', drafts)` 为 true；普通文本粘贴不识别为图片。

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
& '.\\apps\\web\\node_modules\\.bin\\tsx.cmd' --test 'apps/web/src/lib/imageAttachments.test.ts'
```

Expected: FAIL because the new helper functions and attachment type do not exist.

- [ ] **Step 3: Implement the shared types and minimal pure helpers**

Use an explicit allowlist of four MIME types, constants `MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024`, `MAX_IMAGE_COUNT = 5`, and `MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024`. Do not inspect file names as a substitute for MIME validation.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run the same command; expected result is all image attachment tests passing.

---

### Task 2: 持久化附件文件及 SQLite 关联

**Files:**
- Create: `apps/server/src/services/ConversationAttachmentService.ts`
- Create: `apps/server/src/services/ConversationAttachmentService.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `packages/shared/src/types/index.ts`

**Interfaces:**
- `ConversationAttachmentInput { name: string; mimeType: string; dataUrl: string }`
- `StoredConversationAttachment { id; messageId; conversationId; workspaceId; name; mimeType; size; relativePath }`
- `ConversationAttachmentService.saveForMessage(input): Promise<StoredConversationAttachment[]>`
- `SqliteStore.createMessage(message)` persists attachment rows when `message.attachments` is present.
- `SqliteStore.listMessages()` hydrates public attachment metadata and controlled URLs.

- [ ] **Step 1: Write failing storage tests**

Cover successful Data URL decode and file write; invalid MIME; malformed Data URL; decoded bytes over 10 MB; path traversal in original name; cross-workspace/cross-conversation attachment lookup; list after reopening the SQLite store; deletion removes both rows and files.

- [ ] **Step 2: Run storage tests and confirm RED**

```powershell
pnpm --filter @agentos/server test -- apps/server/src/services/ConversationAttachmentService.test.ts
```

Expected: FAIL because the attachment service/table is absent.

- [ ] **Step 3: Add the schema and file service**

Add `message_attachments` with foreign keys to `messages` and `conversations`, indexes by conversation and attachment ID, and a migration-safe table creation path. Store files using `randomUUID()` and a fixed extension map. Never concatenate the original name into the filesystem path.

- [ ] **Step 4: Hydrate messages and implement cleanup**

Add store methods for attachment lookup and deletion. Return `url` as `/api/workspaces/<workspaceId>/attachments/<attachmentId>`; do not return `relativePath` to the browser.

- [ ] **Step 5: Run storage tests and confirm GREEN**

Run the focused test and `pnpm --filter @agentos/server test`; expected result is the new storage tests plus all existing server tests passing.

---

### Task 3: 扩展消息 API 和会话服务

**Files:**
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Modify: `apps/server/src/routes/conversations.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

**Interfaces:**
- `SendDirectMessageInput.attachments?: ConversationAttachmentInput[]`
- `SendGroupMessageInput.attachments?: ConversationAttachmentInput[]`
- `POST /messages/stream` accepts `attachments?: ConversationAttachmentInput[]`.
- `GET /attachments/:attachmentId` streams only an attachment belonging to the requested workspace.

- [ ] **Step 1: Write failing route tests**

Add tests for image-only messages, persisted attachment metadata, returned attachment bytes/content type, invalid attachment rejection before execution creation, and group message attachment propagation.

- [ ] **Step 2: Run route tests and confirm RED**

```powershell
pnpm --filter @agentos/server test -- apps/server/src/routes/conversations.test.ts
```

Expected: FAIL because the request body and download route do not yet handle attachments.

- [ ] **Step 3: Implement request validation and service plumbing**

Allow `content` to be empty only when attachments are present. Validate count, MIME and decoded size before writing anything. Save attachments before creating the user message, pass stored attachment paths to the runner, and delete newly written files if message creation or execution setup fails.

- [ ] **Step 4: Add the safe download route and JSON body limit**

Register `GET /attachments/:attachmentId` after workspace validation. Use `res.sendFile` only with the store-resolved absolute path. Change `express.json()` to an explicit 50 MB limit so the client receives a controlled validation response for oversized payloads.

- [ ] **Step 5: Update the web send body**

Pass `attachments` with each image's name, MIME and Data URL. Permit send when `draft.trim()` is empty but attachments exist. Keep the existing model/thinking override behavior unchanged.

- [ ] **Step 6: Run route and full server tests**

Run the focused route test and then `pnpm --filter @agentos/server test`; expected result is zero failures.

---

### Task 4: Agent CLI 图片输入适配器

**Files:**
- Modify: `packages/agent-core/src/types.ts`
- Create: `packages/agent-core/src/imageInput.ts`
- Create: `packages/agent-core/src/imageInput.test.ts`
- Modify: `packages/agent-core/src/conversationRunner.ts`
- Modify: `packages/agent-core/src/executor.ts`
- Modify: `packages/agent-core/src/conversationRunner.test.ts`

**Interfaces:**
- `AgentImageAttachment { name: string; mimeType: string; absolutePath: string }`
- `ImageInputTransport = 'cli-flag' | 'workspace-path' | 'unsupported'`
- `resolveImageInput(agent, attachments): ImageInputPlan`
- `ImageInputPlan { transport; cliArgs: string[]; promptSuffix?: string }`

- [ ] **Step 1: Write failing adapter tests**

Assert that Codex attachments produce one safe image argument per path; KimiCode/OpenCode use the declared workspace-path transport only; unknown CLI returns unsupported; a path containing spaces is passed as one argument; no file path is shell-interpolated into a command string.

- [ ] **Step 2: Run adapter tests and confirm RED**

```powershell
pnpm --filter @agentos/agent-core test -- src/imageInput.test.ts
```

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement the transport plan**

Keep transport selection separate from process spawning. For the Codex adapter, insert the image flag before the final prompt argument. For workspace-path transport, append a clearly delimited attachment section containing absolute paths and instruct the Agent to inspect those files with its supported tools. Return `unsupported` when the CLI kind is unknown; throw a user-readable error before spawning.

- [ ] **Step 4: Thread attachments through the runner and executor**

Add attachments to runner options and `AgentConfig`. Apply the plan once, preserve existing model/thinking flags, and ensure mock mode includes attachment names in deterministic output without reading binary contents. Existing cancellation, timeout and nonzero-exit behavior must remain unchanged.

- [ ] **Step 5: Run agent-core tests and build**

```powershell
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/agent-core build
```

Expected: all existing and new tests pass.

---

### Task 5: Web 粘贴、选择、预览和消息展示

**Files:**
- Create: `apps/web/src/components/chat/ImageAttachments.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Modify: `apps/web/src/lib/imageAttachments.ts`
- Modify: `apps/web/src/lib/imageAttachments.test.ts`

**Interfaces:**
- `ImageAttachments { drafts; disabled; onAdd; onRemove }`
- `ChatPanelProps.attachments: ImageDraft[]`
- `ChatPanelProps.onAttachmentsChange(value: ImageDraft[]): void`

- [ ] **Step 1: Extend pure tests for browser behavior**

Test conversion of a `File` to Data URL metadata, image-only send enablement, and preservation of text paste behavior. Keep browser APIs behind small functions so the existing Node test runner can test validation without a DOM dependency.

- [ ] **Step 2: Run the focused web tests and confirm RED**

Run the existing web test command plus the new focused test; expected new cases fail until the helpers are extended.

- [ ] **Step 3: Implement the attachment picker UI**

Add a visually consistent attachment button beside the existing model/thinking controls, hidden file input, `onPaste` handler on the textarea, thumbnail strip, file names, remove buttons, and accessible labels. Do not intercept plain text clipboard content.

- [ ] **Step 4: Render attachments in message bubbles**

Render image thumbnails from `attachment.url` for persisted messages and `previewUrl` for the optimistic local message. Keep `alt` text from the original filename and open the controlled URL in a new tab.

- [ ] **Step 5: Wire optimistic state and send lifecycle**

Add attachment drafts to page state, keep them on failed sends, clear them only after a successful send, and refresh conversation details after completion so the local preview is replaced by persisted attachment metadata. Preserve existing model and thinking selection state.

- [ ] **Step 6: Run Web type check and pure tests**

```powershell
& '.\\apps\\web\\node_modules\\.bin\\tsx.cmd' --test @(Get-ChildItem -LiteralPath 'apps/web/src/lib' -Filter '*.test.ts' | ForEach-Object FullName)
& '.\\apps\\web\\node_modules\\.bin\\tsc.cmd' --noEmit -p apps/web/tsconfig.json
```

Expected: all web tests pass and TypeScript reports no errors.

---

### Task 6: 集成回归与验收

**Files:**
- Modify: `apps/server/src/routes/conversations.test.ts` if integration assertions need completion.
- Modify: `apps/web/src/lib/imageAttachments.test.ts` if a discovered regression is isolated.
- Create: `docs/superpowers/reports/2026-07-13-agentos-image-input-verification.md`

- [ ] **Step 1: Run the complete automated suite**

```powershell
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server test
& '.\\apps\\web\\node_modules\\.bin\\tsx.cmd' --test @(Get-ChildItem -LiteralPath 'apps/web/src/lib' -Filter '*.test.ts' | ForEach-Object FullName)
& '.\\apps\\web\\node_modules\\.bin\\tsc.cmd' --noEmit -p apps/web/tsconfig.json
& '.\\apps\\web\\node_modules\\.bin\\next.cmd' build
```

- [ ] **Step 2: Run the image input manual flow**

Verify: paste image, select image, remove image, send image-only message, reload history, open thumbnail, reject invalid/oversized images, and verify unsupported CLI rejection creates no execution.

- [ ] **Step 3: Run real CLI smoke tests where binaries are available**

For each installed CLI, send a small test image with a deterministic instruction such as “只回答图片中主色，不要输出其他内容”。Record the actual command/transport and result. If a CLI binary or image-capable model is unavailable, record it as an environment limitation rather than claiming support.

- [ ] **Step 4: Write the verification report**

Record command outputs, manual cases, transport per CLI, known limitations, and a pass/fail result for every acceptance criterion. Do not claim visual browser QA unless a browser runtime or screenshot is actually available.

- [ ] **Step 5: Run final formatting checks**

```powershell
git -c safe.directory=E:/workspace/Multi-Agent diff --check
```

Expected: no whitespace errors in tracked changes. Note separately that untracked files are not covered by `git diff --check`.

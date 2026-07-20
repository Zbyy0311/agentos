# AgentOS 图片输入设计

## 目标

让 AgentOS 对话支持从剪贴板粘贴图片、通过文件选择器选择图片，并将图片可靠地传递给 Codex、KimiCode、OpenCode。图片不能只停留在浏览器预览中；如果当前 CLI 或模型没有可验证的图片输入能力，发送必须明确失败并提示原因。

## 已确认现状

- `apps/web/src/components/chat/ChatPanel.tsx` 当前只有纯文本 `textarea`。
- `POST /messages/stream` 当前只接受 `content`、`model` 和 `thinkingEffort`。
- `ConversationMessage` 当前没有附件字段，SQLite `messages` 表也没有附件关联。
- `ConversationAgentRunner` 当前只把文本 prompt 传给 CLI。
- Kimi CLI 帮助未显示图片参数；OpenCode CLI 当前不在 PATH；Codex CLI 的本机帮助受 WindowsApps 权限限制。因此 CLI 图片传输采用适配器，不在未知情况下猜测参数。

## 用户体验

### 输入

- 输入框左下角增加回形针按钮，打开图片文件选择器。
- 输入框支持 `Ctrl+V` 粘贴剪贴板图片；粘贴普通文本仍保持原行为。
- 支持 PNG、JPEG、GIF、WebP。
- 单张最大 10 MB，单条消息最多 5 张，超过限制立即在输入区显示中文错误。
- 图片可以单独发送，消息文本为空但存在图片时发送按钮可用。

### 预览与消息

- 发送前显示缩略图、文件名和删除按钮。
- 发送后用户消息显示缩略图；历史记录重新加载后仍能显示。
- 点击缩略图在新标签页打开图片。
- 上传或发送失败时保留草稿和图片预览，用户可以重试或删除图片。

## 数据与存储

浏览器只提交短期传输用的 Data URL；服务端完成校验后写入：

```text
<workspaceRoot>/.agentos/attachments/<conversationId>/<attachmentId>.<ext>
```

SQLite 增加 `message_attachments` 表，保存附件 ID、消息 ID、工作区 ID、原始文件名、MIME、大小和相对文件路径。`ConversationMessage.attachments` 只暴露安全的公共元数据及受控下载 URL，不暴露任意本机路径。

服务端要求：

- 只允许图片 MIME，限制单文件 10 MB、单条消息总量 25 MB。
- 使用随机 UUID 文件名，拒绝路径穿越和未知附件 ID。
- 附件和消息必须属于同一个工作区及会话。
- 删除会话时同时删除附件记录和磁盘文件。
- 旧消息无附件时返回 `attachments: []` 或省略字段，保持向后兼容。

## API 与执行链路

消息请求扩展为：

```json
{
  "content": "请分析这张截图",
  "attachments": [
    {
      "name": "screen.png",
      "mimeType": "image/png",
      "dataUrl": "data:image/png;base64,..."
    }
  ],
  "model": "可选模型",
  "thinkingEffort": "可选思考强度"
}
```

服务端先校验并落盘附件，再创建带附件关联的用户消息，再启动 Agent。Agent runner 接收内部附件记录，并通过 `ImageInputAdapter` 生成 CLI 所需的参数或 prompt 信息。适配器必须返回明确的 transport：

- `cli-flag`：CLI 原生支持图片参数时传递图片路径。
- `workspace-path`：CLI 没有显式附件参数但已确认当前工作流可读取工作区文件时，向 prompt 提供受控路径。
- `unsupported`：无法证明 CLI/model 能读取图片时阻止执行并返回中文错误。

适配器不会把图片 Base64 注入 prompt，也不会在不支持时假装成功。Codex、KimiCode、OpenCode 各自使用独立的适配函数，后续可以在不改消息协议的情况下补充真实 CLI 参数。

## 测试与验收标准

### 自动化测试

- 前端纯逻辑：粘贴图片识别、MIME/大小/数量校验、图片发送条件、删除预览。
- 服务端：附件落盘、非法 MIME/大小/路径/跨会话 ID 拒绝、消息附件持久化及历史读取。
- Agent core：三种 CLI transport 的参数或 prompt 构造；unsupported transport 必须抛出可读错误。
- 现有直接会话、群聊、模型和思考强度测试全部回归通过。

### 手工验收

1. 在 Codex 会话中按 `Ctrl+V` 粘贴截图，能看到缩略图和文件名。
2. 删除预览后，消息中不再包含该图片。
3. 仅带图片发送，用户消息和 Agent 回复均可正常完成。
4. 刷新页面后，历史用户消息仍显示缩略图，点击可打开图片。
5. 选择非图片、超过 10 MB 或第 6 张图片时，发送被阻止且显示明确提示。
6. KimiCode/OpenCode 在当前 CLI 无法证明图片能力时，页面显示“当前 Agent 不支持图片输入”，不得创建执行记录。
7. 支持图片的真实 CLI smoke test 中，Agent 输出必须引用或正确描述测试图片；仅看到文件名不算通过。

## 非目标

- 不实现图片编辑、压缩、OCR 或图片转文字。
- 不把图片写入消息正文 Base64。
- 不修改已有模型发现、思考强度选择逻辑。
- 不要求群聊成员共享一份超出其 CLI 能力范围的图片；每个成员按适配器单独校验。

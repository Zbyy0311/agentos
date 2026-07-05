# Multi-Agent 代码记忆文档

更新时间: 2026-06-27
项目路径: `E:\workspace\Multi-Agent\multi-agent-collab-v1`

## 项目定位

这是一个 FastAPI + React 的多智能体协作系统。前端提供类似聊天 App 的群聊/私聊界面，用户可以在群聊中 `@Agent` 或进入某个 Agent 私聊来派发消息；后端将消息落库后异步调用本机 Agent CLI，并通过 WebSocket 把用户消息、Agent 状态和 Agent 回复推送到页面。

当前系统不是纯静态 demo，真实 Agent 调用入口在后端 `agent_engine.py`。但各 Agent 仍通过外部 CLI 冷启动/子进程调用，尚未实现真正常驻 Agent runtime。

## 技术栈

- 后端: Python, FastAPI, SQLAlchemy Async, SQLite, WebSocket。
- 前端: React 18, TypeScript, Vite, Tailwind CSS, Zustand, Axios。
- 可视化: Recharts, lucide-react, react-syntax-highlighter。
- 部署: Docker Compose，前端容器暴露 `80`，后端容器暴露 `8000`。

## 目录结构

- `multi-agent-collab-v1/backend/app/main.py`: FastAPI 应用入口、建表、默认 Agent 初始化、路由注册、SPA 静态文件 fallback。
- `multi-agent-collab-v1/backend/app/models.py`: SQLAlchemy 数据表模型。
- `multi-agent-collab-v1/backend/app/schemas.py`: Pydantic API schema。
- `multi-agent-collab-v1/backend/app/crud.py`: Agent、Task、Message、RepoFile、Metric 的数据库操作。
- `multi-agent-collab-v1/backend/app/routers/`: REST API 路由。
- `multi-agent-collab-v1/backend/app/services/agent_engine.py`: Agent persona、外部 CLI 路径、模型配置、调用和回复解析。
- `multi-agent-collab-v1/backend/app/services/agent_service.py`: 默认 5 个 Agent 的种子数据。
- `multi-agent-collab-v1/backend/app/services/demo_service.py`: 手动 demo 数据生成；当前不再生成群聊演示对话。
- `multi-agent-collab-v1/backend/app/websocket/manager.py`: WebSocket 连接管理和广播。
- `multi-agent-collab-v1/frontend/src/pages/Dashboard.tsx`: 页面主布局，左侧会话列表、中间聊天区、右侧工具栏。
- `multi-agent-collab-v1/frontend/src/components/ChatSidebar.tsx`: 群聊和 Agent 私聊入口。
- `multi-agent-collab-v1/frontend/src/components/ChatRoom.tsx`: 聊天消息展示、代码块渲染、思考中状态。
- `multi-agent-collab-v1/frontend/src/components/ChatInput.tsx`: 消息发送、`@` 提及、`/task` 命令。
- `multi-agent-collab-v1/frontend/src/stores/useStore.ts`: Zustand 全局状态。
- `multi-agent-collab-v1/frontend/src/api/client.ts`: Axios REST API 封装。
- `multi-agent-collab-v1/frontend/src/hooks/useWebSocket.ts`: WebSocket 自动重连和增量状态更新。

## 后端启动流程

1. `main.py` 的 `lifespan` 启动时调用 `Base.metadata.create_all` 创建缺失表。
2. 同一启动周期调用 `seed_default_agents(db)`，数据库为空时创建默认 5 个 Agent。
3. 注册 REST 路由: `/agents`, `/tasks`, `/messages`, `/files`, `/metrics`, `/demo`。
4. 注册 WebSocket: `/ws`。
5. 添加 `StripAPIPrefix` 中间件，直接访问后端时可以兼容前端的 `/api/*` 请求。
6. 如果 `frontend/dist` 存在，后端会挂载 `/assets` 并对任意 SPA 路径返回 `index.html`。

注意: 现在启动时不会再自动执行 `run_demo_scenario`，所以不会自动往群聊写入演示对话。

## 数据模型

- `Agent`: name, role, avatar, status, skills, current_task_id, progress, last_active_at, created_at。
- `Task`: title, description, status, priority, assignee_id, dependencies, created_at, updated_at。
- `Message`: agent_id, agent_name, role, action, target, room, content, deliverables, next_steps, created_at。
- `RepoFile`: path, content, agent_id, agent_name, version, created_at, updated_at。
- `Metric`: agent_id, response_time_ms, lines_of_code, warnings, errors, health_score, recorded_at。

重要约定:

- 群聊 room 固定为 `group`。
- Agent 私聊 room 格式为 `agent_{id}`。
- 用户消息的 `agent_name` 固定为 `用户`，后端据此触发 Agent 异步回复。
- Agent 状态主要使用 `idle`, `working`, `waiting`。

## 消息和 Agent 调用流程

1. 前端 `ChatInput` 调用 `messagesApi.create` 创建消息。
2. 后端 `POST /messages/` 先写入 `messages` 表，并广播 `message.created`。
3. 如果消息 `agent_name == "用户"`，后端解析目标 Agent:
   - 私聊优先按 `room=agent_{id}` 查 Agent 名称。
   - 群聊按 `@(Codex|KimiCode|MimoCode|OpenCode|Reasonix)` 匹配第一个提及。
   - 没有命中时默认交给 `Codex`。
4. 后端把目标 Agent 状态更新为 `working`，并广播 `agent.updated`。
5. 后端 `asyncio.create_task` 后台调用 `_trigger_agent_response`。
6. `_trigger_agent_response` 会读取当前房间最近 10 条消息作为上下文。
7. `call_agent_cli` 根据 persona 的 `cli` 字段调用对应外部 CLI。
8. `parse_agent_reply` 优先解析 ```json 代码块，其次解析纯 JSON，失败则把原始文本作为 `content`。
9. 后端保存 Agent 回复，广播 `message.created`，再把 Agent 状态改回 `idle`。

## Agent 配置

默认 Agent 在 `agent_engine.py` 中定义:

- `Codex`: 总指挥 / 系统架构师，CLI 为 `codex`。
- `KimiCode`: 后端工程师，CLI 为 `opencode`，模型为 `kimi-for-coding/k2p7`。
- `MimoCode`: 前端工程师，CLI 为 `mimo`，模型为 `xiaomi/mimo-v2.5-pro`。
- `OpenCode`: DevOps 工程师，CLI 为 `opencode`，模型为 `deepseek/deepseek-v4-flash`。
- `Reasonix`: 技术分析师，CLI 为 `reasonix`。

本机 CLI 路径和工作目录:

- Codex: `C:\Users\Administrator\AppData\Roaming\QClaw\npm-global\codex.cmd`
- OpenCode: `E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe`
- OpenCode home: `E:\software\opencode\.opencode-home`
- MimoCode cwd: `E:\mimocode\packages\opencode`
- MimoCode home: `E:\mimocode\.dev-home`
- Reasonix node: `D:\Reasonix\node.exe`
- Reasonix entry: `D:\Reasonix\dist\cli\index.js`

CLI 调用形式:

- Codex: `codex.cmd exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral <prompt>`
- OpenCode/KimiCode: `opencode.exe --pure run --model <model> <prompt>`
- MimoCode: `bun --cwd E:\mimocode\packages\opencode src/index.ts run --pure --model xiaomi/mimo-v2.5-pro <prompt>`
- Reasonix: `D:\Reasonix\node.exe D:\Reasonix\dist\cli\index.js run <prompt>`

已知限制:

- 每次 Agent 回复都会创建外部子进程，当前不是长驻服务。
- 每个 CLI 调用超时时间是 180 秒。
- Kimi Code API 此前验证过可认证但可能返回 `429` 限额。
- CLI stdout 清洗逻辑比较简单，可能误过滤或保留 CLI 噪声。

## 前端架构

`App.tsx` 已移除登录保护，任何路由都进入 `Dashboard`。

`Dashboard` 布局:

- 外层使用 `h-screen w-screen`，页面全屏铺满。
- 左侧是 `ChatSidebar`。
- 中间默认显示 `ChatRoom`。
- 右侧工具栏可以切换 `tasks`, `files`, `metrics` 面板。
- `loadAll` 会按当前 `activeRoom` 拉取 agents、tasks、messages、files、metrics。
- 页面每 15 秒轮询一次，同时使用 WebSocket 接收实时增量。

Zustand store:

- 保存 `agents`, `tasks`, `messages`, `files`, `metrics`。
- 保存 `selectedAgent`, `selectedFile`, `activeRoom`, `chatRooms`。
- 提供 `set*`, `upsert*`, `remove*` 方法。

WebSocket:

- 默认地址: `ws://${window.location.host}/ws`。
- 可通过 `VITE_WS_URL` 覆盖。
- 支持消息类型: `agent.created`, `agent.updated`, `agent.deleted`, `task.created`, `task.updated`, `task.deleted`, `message.created`, `file.updated`, `metric.updated`。
- 断开后 3 秒自动重连。

## 聊天 UI 行为

- `ChatSidebar` 左侧固定显示群聊入口和所有 Agent 私聊入口。
- 群聊入口 room 是 `group`。
- Agent 私聊入口 room 是 `agent_{agent.id}`。
- `ChatRoom` 根据 `activeRoom` 过滤消息。
- 群聊显示所有 `room === "group"` 的消息。
- 私聊只显示对应 `room === "agent_{id}"` 的消息。
- `ChatRoom` 会把 markdown 风格 ``` 代码块交给 `react-syntax-highlighter` 渲染。
- `@xxx` 片段会高亮显示。
- `workingAgents` 在群聊显示所有 working Agent，在私聊只显示当前 Agent 的 working 状态。

## 输入框行为

- Enter 发送，Shift+Enter 换行。
- 输入 `@` 后显示 Agent 列表，点击可插入 `@AgentName`。
- 普通消息发送成功后立即 `upsertMessage`，所以用户能看到即时反馈。
- 群聊中第一个有效 `@AgentName` 会作为 `target`，后端也会按相同规则选择目标 Agent。
- 私聊中不需要 `@`，目标 Agent 由 `room=agent_{id}` 决定。
- `/task <标题> @AgentName` 会创建任务，并额外发送一条系统消息确认任务创建。

## 任务、文件、指标面板

任务看板:

- `KanbanBoard` 使用四列: `todo`, `in_progress`, `in_review`, `done`。
- 支持新建、拖拽改状态、删除。
- 将任务拖到 `in_progress` 时，会把 Codex 状态更新为 `working`。

代码仓库视图:

- `RepoView` 按文件 path 的目录分组展示。
- 支持选择文件、编辑内容、保存。
- 保存调用 `filesApi.upsert`，后端按 path create-or-update，并递增 version。

性能指标:

- `MetricsPanel` 展示响应时间柱状图、健康度折线图、LOC/警告/错误/健康度统计。
- 后端 `MetricCRUD.get_latest` 试图按 Agent 返回最新指标。

## API 速查

- `GET /health`: 健康检查。
- `GET /agents/`: Agent 列表。
- `POST /agents/`: 新建 Agent。
- `PATCH /agents/{id}`: 更新 Agent 状态、进度、当前任务。
- `DELETE /agents/{id}`: 删除 Agent。
- `GET /tasks/`: 任务列表。
- `POST /tasks/`: 新建任务。
- `PATCH /tasks/{id}`: 更新任务。
- `DELETE /tasks/{id}`: 删除任务。
- `GET /messages/?limit=100&room=group`: 按 room 拉取消息。
- `POST /messages/`: 创建消息；当 `agent_name` 为 `用户` 时会触发 Agent 回复。
- `GET /files/`: 文件列表。
- `POST /files/`: 按 path 创建或更新文件。
- `GET /metrics/`: 最新指标。
- `POST /metrics/`: 写入指标。
- `POST /demo/run`: 清空消息/指标/文件/任务并生成 demo 任务、文件、指标；当前不生成群聊对话。
- `WS /ws`: 实时广播通道。

前端 Axios 默认 `baseURL` 是 `/api`，后端 `StripAPIPrefix` 会把 `/api/messages/` 改写为 `/messages/`。

## 本地运行

后端:

```powershell
cd E:\workspace\Multi-Agent\multi-agent-collab-v1\backend
python -m uvicorn app.main:app --port 8000
```

前端:

```powershell
cd E:\workspace\Multi-Agent\multi-agent-collab-v1\frontend
npm run dev
```

构建前端并由后端托管:

```powershell
cd E:\workspace\Multi-Agent\multi-agent-collab-v1\frontend
npm run build
cd ..\backend
python -m uvicorn app.main:app --port 8000
```

后端批处理:

```powershell
E:\workspace\Multi-Agent\multi-agent-collab-v1\backend\start_server.bat
```

注意: `start_server.bat` 当前第 3 行会删除 `collab.db`，所以每次用它启动都会重置本地数据库。

测试:

```powershell
cd E:\workspace\Multi-Agent\multi-agent-collab-v1\backend
python -m pytest tests/ -v
```

前端构建校验:

```powershell
cd E:\workspace\Multi-Agent\multi-agent-collab-v1\frontend
npm run build
```

## 近期变更记忆

- 移除了启动时自动注入演示群聊对话。
- `/demo/run` 保留 demo 任务、文件、指标生成，但不再创建演示聊天记录。
- 本地 `backend/collab.db` 已清理 10 条认证系统演示群聊消息。
- 登录路由已经不再使用，`App.tsx` 所有路径进入 `Dashboard`。
- 页面布局已改为全屏铺满。
- 普通消息发送成功后会立刻更新本地 store，避免“发送后无反馈”。
- 后端 Agent 选择规则已支持私聊按 room 路由，群聊按 `@AgentName` 路由。

## 已知风险和后续建议

- 需要新增 Agent runtime 状态层，区分 UI 的 `idle/working` 和真实 CLI 可用性。
- 如果要避免 Agent 冷启动，需要确认 Codex/OpenCode/Mimo/Reasonix 是否支持常驻 server/session，再设计 runtime manager。
- `start_server.bat` 会删除数据库，如要保留历史消息应去掉 `if exist collab.db del collab.db`。
- `MetricCRUD.get_latest` 使用 `distinct(models.Metric.agent_id)`，SQLite 下行为可能不稳定，建议后续用窗口函数或子查询按 `recorded_at` 明确取最新。
- Pydantic schema 中若干 list 默认值使用 `[]`，Pydantic v2 通常可处理，但更稳妥写法是 `Field(default_factory=list)`。
- WebSocket 目前没有鉴权、房间订阅或服务端消息类型校验，适合本地协作，不适合直接公网暴露。
- `/demo/run` 会清空任务、文件、指标、消息，适合重置演示数据，不适合生产数据环境。
- 外部 CLI 路径写死在 `agent_engine.py`，如果迁移机器需要改路径或改为环境变量。

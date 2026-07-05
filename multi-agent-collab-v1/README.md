# Multi-Agent 协作系统 v1.0

一个支持多智能体实时协同的可视化工作平台。

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3.11 + FastAPI + SQLAlchemy + SQLite + WebSocket |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS + Zustand |
| 部署 | Docker + docker-compose |
| CI/CD | GitHub Actions |

## 功能模块

- **Agent 状态卡片**：展示各 Agent 状态、进度、技能标签
- **对话流时间线**：按时间顺序展示消息，支持 @ 高亮与代码折叠
- **任务看板**：拖拽式 Kanban，支持任务增删改
- **代码仓库视图**：文件树、在线编辑、版本号
- **系统架构图**：动态节点与数据流动画
- **性能监控面板**：响应时间、代码行数、健康度图表

## 快速启动

### 本地开发

```bash
# 后端
cd backend
python -m venv venv
venv\Scripts\activate  # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload

# 前端（新终端）
cd frontend
npm install
npm run dev
```

### Docker 部署

```bash
docker-compose up --build -d
```

访问 http://localhost 即可使用前端，后端 API 位于 http://localhost:8000。

## 测试

```bash
cd backend
pytest
```

## API 文档

启动后端后访问 http://localhost:8000/docs 查看 Swagger UI。

## 项目结构

```
multi-agent-collab-v1/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── models.py
│   │   ├── schemas.py
│   │   ├── crud.py
│   │   ├── routers/
│   │   ├── websocket/
│   │   └── services/
│   ├── tests/
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── stores/
│   │   ├── api/
│   │   └── types/
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
└── README.md
```

## 默认 Agent

系统启动时会自动创建 5 个默认 Agent：Codex、KimiCode、MimoCode、OpenCode、Reasonix。

## 许可证

MIT

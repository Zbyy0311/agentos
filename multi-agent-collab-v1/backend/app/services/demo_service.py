from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from app import models, crud, schemas


def now_iso():
    return datetime.now(timezone.utc).isoformat()


async def run_demo_scenario(db: AsyncSession):
    agents = await crud.AgentCRUD.get_all(db)
    if not agents:
        return {"error": "No agents found. Run seed first."}
    agent_map = {a.name: a for a in agents}

    existing_msgs = await crud.MessageCRUD.get_all(db, limit=1)
    if existing_msgs:
        await _clear_existing(db)

    tasks = await _create_tasks(db, agent_map)
    await _create_files(db, agent_map)
    await _record_metrics(db, agent_map)

    return {"ok": True, "messages": await crud.MessageCRUD.get_all(db, limit=200)}


async def _clear_existing(db: AsyncSession):
    from sqlalchemy import delete
    await db.execute(delete(models.Message))
    await db.execute(delete(models.Metric))
    await db.execute(delete(models.RepoFile))
    await db.execute(delete(models.Task))
    await db.commit()


async def _create_tasks(db: AsyncSession, agent_map):
    c = Codex = agent_map.get("Codex")
    k = agent_map.get("KimiCode")
    m = agent_map.get("MimoCode")
    o = agent_map.get("OpenCode")
    r = agent_map.get("Reasonix")

    task_defs = [
        {"title": "用户认证系统 —— 整体架构设计", "status": "done", "priority": "high", "assignee": c},
        {"title": "JWT 认证 API 接口实现", "status": "done", "priority": "high", "assignee": k},
        {"title": "登录/注册页面 UI 开发", "status": "done", "priority": "high", "assignee": m},
        {"title": "代码审查：后端 API 安全性", "status": "done", "priority": "medium", "assignee": r},
        {"title": "Docker 容器化与 CI/CD 配置", "status": "done", "priority": "medium", "assignee": o},
        {"title": "前端 API 对接与错误处理", "status": "in_progress", "priority": "medium", "assignee": m},
        {"title": "单元测试覆盖", "status": "in_review", "priority": "medium", "assignee": k},
        {"title": "API 限流与安全加固", "status": "todo", "priority": "low", "assignee": k},
        {"title": "E2E 端到端测试", "status": "todo", "priority": "low", "assignee": o},
    ]

    created = []
    for td in task_defs:
        t = await crud.TaskCRUD.create(db, schemas.TaskCreate(
            title=td["title"], status=td["status"], priority=td["priority"],
            assignee_id=td["assignee"].id if td["assignee"] else None,
        ))
        created.append(t)

    return created


async def _create_files(db: AsyncSession, agent_map):
    files = [
        {"path": "backend/auth/models.py", "content": "# Auth data models\nfrom pydantic import BaseModel\n\n\nclass LoginRequest(BaseModel):\n    username: str\n    password: str\n    captcha: str | None = None\n\n\nclass TokenResponse(BaseModel):\n    access_token: str\n    refresh_token: str\n    token_type: str = \"bearer\"\n    expires_in: int = 3600\n\n\nclass RegisterRequest(BaseModel):\n    username: str\n    email: str\n    password: str\n", "agent": "KimiCode"},
        {"path": "backend/auth/jwt_handler.py", "content": "# JWT token handler\nimport jwt\nfrom datetime import datetime, timedelta\n\nSECRET_KEY = \"change-me-in-production\"\nALGORITHM = \"HS256\"\n\n\ndef create_access_token(data: dict, expires_delta: int = 3600) -> str:\n    to_encode = data.copy()\n    expire = datetime.utcnow() + timedelta(seconds=expires_delta)\n    to_encode.update({\"exp\": expire})\n    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)\n\n\ndef verify_token(token: str) -> dict | None:\n    try:\n        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])\n    except jwt.PyJWTError:\n        return None\n", "agent": "KimiCode"},
        {"path": "frontend/src/pages/LoginPage.tsx", "content": "import { useState } from 'react';\n\n\nexport default function LoginPage() {\n  const [username, setUsername] = useState('');\n  const [password, setPassword] = useState('');\n\n  const handleLogin = async (e: React.FormEvent) => {\n    e.preventDefault();\n    const res = await fetch('/api/auth/login', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ username, password }),\n    });\n    if (res.ok) {\n      const data = await res.json();\n      localStorage.setItem('token', data.access_token);\n      window.location.href = '/dashboard';\n    }\n  };\n\n  return (\n    <div className=\"min-h-screen flex items-center justify-center bg-slate-50\">\n      <form onSubmit={handleLogin} className=\"bg-white p-8 rounded-xl shadow-lg w-96\">\n        <h1 className=\"text-2xl font-bold mb-6\">用户登录</h1>\n        <input\n          className=\"w-full border rounded px-3 py-2 mb-4\"\n          placeholder=\"用户名\"\n          value={username}\n          onChange={(e) => setUsername(e.target.value)}\n        />\n        <input\n          className=\"w-full border rounded px-3 py-2 mb-4\"\n          type=\"password\"\n          placeholder=\"密码\"\n          value={password}\n          onChange={(e) => setPassword(e.target.value)}\n        />\n        <button\n          type=\"submit\"\n          className=\"w-full bg-indigo-600 text-white rounded py-2 hover:bg-indigo-700\"\n        >\n          登录\n        </button>\n      </form>\n    </div>\n  );\n}\n", "agent": "MimoCode"},
        {"path": "frontend/src/pages/RegisterPage.tsx", "content": "import { useState } from 'react';\n\n\nexport default function RegisterPage() {\n  const [username, setUsername] = useState('');\n  const [email, setEmail] = useState('');\n  const [password, setPassword] = useState('');\n\n  const handleRegister = async (e: React.FormEvent) => {\n    e.preventDefault();\n    const res = await fetch('/api/auth/register', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ username, email, password }),\n    });\n    if (res.ok) {\n      window.location.href = '/login';\n    }\n  };\n\n  return (\n    <div className=\"min-h-screen flex items-center justify-center bg-slate-50\">\n      <form onSubmit={handleRegister} className=\"bg-white p-8 rounded-xl shadow-lg w-96\">\n        <h1 className=\"text-2xl font-bold mb-6\">用户注册</h1>\n        <input className=\"w-full border rounded px-3 py-2 mb-4\" placeholder=\"用户名\" value={username} onChange={e => setUsername(e.target.value)} />\n        <input className=\"w-full border rounded px-3 py-2 mb-4\" type=\"email\" placeholder=\"邮箱\" value={email} onChange={e => setEmail(e.target.value)} />\n        <input className=\"w-full border rounded px-3 py-2 mb-4\" type=\"password\" placeholder=\"密码（至少8位）\" value={password} onChange={e => setPassword(e.target.value)} />\n        <button type=\"submit\" className=\"w-full bg-indigo-600 text-white rounded py-2 hover:bg-indigo-700\">注册</button>\n      </form>\n    </div>\n  );\n}\n", "agent": "MimoCode"},
        {"path": ".github/workflows/auth-ci.yml", "content": "name: Auth Service CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.11'\n      - run: pip install -r requirements.txt\n      - run: pytest tests/ --cov=auth --cov-report=xml\n      - uses: codecov/codecov-action@v3\n        with:\n          file: ./coverage.xml\n\n  build:\n    needs: test\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: docker build -t auth-service:latest -f Dockerfile.auth .\n", "agent": "OpenCode"},
        {"path": "Dockerfile.auth", "content": "FROM python:3.11-slim\n\nWORKDIR /app\n\nENV PYTHONDONTWRITEBYTECODE=1 \\\n    PYTHONUNBUFFERED=1\n\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\n\nCOPY . .\n\nEXPOSE 8000\n\nCMD [\"uvicorn\", \"app.main:app\", \"--host\", \"0.0.0.0\", \"--port\", \"8000\"]\n", "agent": "OpenCode"},
    ]
    for f in files:
        a = agent_map.get(f["agent"])
        await crud.RepoFileCRUD.create_or_update(db, schemas.RepoFileCreate(
            path=f["path"], content=f["content"],
            agent_id=a.id if a else None, agent_name=f["agent"],
        ))


async def _record_metrics(db: AsyncSession, agent_map):
    metrics_data = [
        ("Codex", 320, 150, 0, 0, 98.5),
        ("KimiCode", 210, 420, 2, 0, 95.0),
        ("MimoCode", 280, 380, 1, 1, 92.5),
        ("OpenCode", 450, 180, 0, 0, 97.0),
        ("Reasonix", 180, 80, 0, 0, 99.0),
    ]
    for name, rt, loc, warn, err, health in metrics_data:
        a = agent_map.get(name)
        await crud.MetricCRUD.create(db, schemas.MetricCreate(
            agent_id=a.id if a else None,
            response_time_ms=float(rt),
            lines_of_code=loc,
            warnings=warn,
            errors=err,
            health_score=float(health),
        ))

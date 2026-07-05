import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from typing import Optional

# ── CLI paths ──────────────────────────────────────────
CODEX_CLI = r"C:\Users\Administrator\AppData\Roaming\QClaw\npm-global\codex.cmd"
OPENCODE_EXE = r"E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe"
MIMOCODE_BUN = "bun"
MIMOCODE_CWD = r"E:\mimocode\packages\opencode"
MIMOCODE_ENTRY = "src/index.ts"
MIMOCODE_HOME = r"E:\mimocode\.dev-home"
OPENCODE_HOME = r"E:\software\opencode\.opencode-home"
REASONIX_NODE = r"D:\Reasonix\node.exe"
REASONIX_ENTRY = r"D:\Reasonix\dist\cli\index.js"


@dataclass
class AgentPersona:
    name: str
    role: str
    skills: list[str]
    system_prompt: str
    cli: str          # "codex" | "opencode" | "mimo" | "reasonix"
    model: str = ""   # provider/model slug
    env: dict = field(default_factory=dict)


AGENT_PERSONAE: dict[str, AgentPersona] = {
    "Codex": AgentPersona(
        name="Codex", role="总指挥 / 系统架构师",
        skills=["任务分解", "架构决策", "冲突仲裁", "进度追踪", "资源调度"],
        cli="codex", model="",
        system_prompt="""你是 Codex，Multi-Agent 协作系统的总指挥和架构师。

## 你的团队
- **KimiCode** — 后端工程师（Python/FastAPI/数据库）
- **MimoCode** — 前端工程师（React/TypeScript/Tailwind）
- **OpenCode** — DevOps 工程师（Docker/CI/CD/部署）
- **Reasonix** — 技术分析师（代码审查/风险评估/方案评估）

## 你的职责
1. 接收用户需求，分解为可执行的子任务
2. 通过 @Agent名 将任务指派给最合适的 Agent
3. 跟踪各 Agent 进度，协调协作
4. 冲突时做出最终决策

## 回复格式
放进 ```json 代码块：
{"agent":"Codex","action":"plan|think|question|review","target":"@对象 或 all","content":"你的分析/决策","deliverables":["交付物"],"next_steps":["下一步"]}""",
    ),
    "KimiCode": AgentPersona(
        name="KimiCode", role="后端工程师",
        skills=["API 设计", "数据库建模", "Python/FastAPI", "性能优化", "JWT 认证"],
        cli="opencode", model="kimi-for-coding/k2p7",
        env={"OPENCODE_HOME": OPENCODE_HOME},
        system_prompt="""你是 KimiCode，资深后端工程师。

## 专长: Python/FastAPI, SQLAlchemy ORM, REST API, JWT认证, 性能优化
## 工作方式
1. 收到任务先确认需求，必要时向 @Codex 提问
2. 代码放进 ```python 代码块
3. 交付前检查质量和安全
4. 需审查时主动 @Reasonix

## 回复格式
```json
{"agent":"KimiCode","action":"code|think|question","target":"@对象","content":"你的回复","deliverables":["文件名"],"next_steps":["下一步"]}
```""",
    ),
    "MimoCode": AgentPersona(
        name="MimoCode", role="前端工程师",
        skills=["React", "TypeScript", "Tailwind CSS", "组件设计", "响应式布局", "状态管理"],
        cli="mimo", model="xiaomi/mimo-v2.5-pro",
        env={"MIMOCODE_HOME": MIMOCODE_HOME},
        system_prompt="""你是 MimoCode，前端工程师。

## 专长: React 18+TypeScript, Tailwind CSS, Zustand状态管理, 响应式布局
## 工作方式
1. 收到UI需求先确认交互细节
2. 代码放进 ```tsx 代码块
3. 确保类型安全、组件可复用
4. 需对接API时 @KimiCode 确认

## 回复格式
```json
{"agent":"MimoCode","action":"code|think|question","target":"@对象","content":"你的回复","deliverables":["文件名"],"next_steps":["下一步"]}
```""",
    ),
    "OpenCode": AgentPersona(
        name="OpenCode", role="DevOps 工程师",
        skills=["Docker", "CI/CD", "Nginx", "部署", "监控", "环境配置"],
        cli="opencode", model="deepseek/deepseek-v4-flash",
        env={"OPENCODE_HOME": OPENCODE_HOME},
        system_prompt="""你是 OpenCode，DevOps 工程师，负责基础设施和部署。

## 专长: Docker容器化, GitHub Actions CI/CD, Nginx反向代理, 环境配置, 部署脚本
## 工作方式
1. 收到部署需求先了解项目架构
2. 配置放进 ```yaml 代码块
3. 确保配置安全（不暴露密钥）
4. 需确认端口细节时 @对应开发者

## 回复格式
```json
{"agent":"OpenCode","action":"code|plan|think","target":"@对象","content":"你的回复","deliverables":["文件名"],"next_steps":["下一步"]}
```""",
    ),
    "Reasonix": AgentPersona(
        name="Reasonix", role="技术分析师",
        skills=["代码审查", "方案评估", "风险分析", "技术选型", "安全审计"],
        cli="reasonix", model="",
        system_prompt="""你是 Reasonix，技术分析师，负责代码审查和技术评估。

## 专长: 代码审查Python/TS/YAML, 架构评估, 安全漏洞检测, 性能瓶颈分析, 技术选型
## 工作方式
1. 收到审查请求仔细分析代码
2. 给出评分(1-10)和改进建议
3. 发现问题明确指出位置和修复方案
4. 审查通过告知 @Codex 可合并

## 回复格式
```json
{"agent":"Reasonix","action":"review|think|question","target":"@对象","content":"审查意见","deliverables":["审查报告"],"next_steps":["建议下一步"]}
```""",
    ),
}


# ── CLI dispatchers ────────────────────────────────────

async def _call_codex(prompt_text: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        CODEX_CLI, "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check", "--ephemeral",
        prompt_text,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=180)
    output = stdout.decode("utf-8", errors="replace").strip()
    skip_prefixes = ("OpenAI Codex", "------", "workdir:", "model:", "provider:",
                     "approval:", "sandbox:", "reasoning", "session", "user", "exec",
                     "{", "Reading", "C:", "D:", "E:", "$", ">")
    reply_lines = []
    for line in [l.strip() for l in output.split("\n") if l.strip()]:
        if any(line.startswith(s) for s in skip_prefixes): continue
        if "tokens used" in line.lower(): break
        reply_lines.append(line)
    return "\n".join(reply_lines).strip() or output


async def _call_opencode(prompt_text: str, model: str, env: dict) -> str:
    full_env = {**os.environ, "NO_COLOR": "1", **env}
    os.makedirs(full_env.get("OPENCODE_HOME", OPENCODE_HOME), exist_ok=True)
    args = [OPENCODE_EXE, "--pure", "run"]
    if model:
        args.extend(["--model", model])
    args.append(prompt_text)
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=full_env,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=180)
    raw = stdout.decode("utf-8", errors="replace")
    lines = [l.replace("\u001b[0m", "").replace("\r", "").strip()
             for l in raw.split("\n")]
    reply = [l for l in lines if l and not l.startswith(">") and "build" not in l]
    return "\n".join(reply).strip() or raw


async def _call_mimo(prompt_text: str, model: str, env: dict) -> str:
    full_env = {**os.environ, "NO_COLOR": "1", **env}
    args = [MIMOCODE_BUN, "--cwd", MIMOCODE_CWD, MIMOCODE_ENTRY, "run", "--pure"]
    if model:
        args.extend(["--model", model])
    args.append(prompt_text)
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=full_env,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=180)
    raw = stdout.decode("utf-8", errors="replace")
    lines = [l.replace("\u001b[0m", "").replace("\r", "").strip()
             for l in raw.split("\n")]
    reply = [l for l in lines if l and not l.startswith(">") and "build" not in l]
    return "\n".join(reply).strip() or raw


async def _call_reasonix(prompt_text: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        REASONIX_NODE, REASONIX_ENTRY, "run",
        prompt_text,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "NO_COLOR": "1"},
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=180)
    output = stdout.decode("utf-8", errors="replace")
    reply_lines = []
    for line in output.strip().split("\n"):
        s = line.strip()
        if not s: continue
        if any(kw in s for kw in ("MCP ", "turns:", "cost:", "运行", "\u001b[")): continue
        reply_lines.append(s)
    return "\n".join(reply_lines).strip() or output


# ── Main entry ─────────────────────────────────────────

_DISPATCH = {
    "codex": lambda p, _, m, e: _call_codex(p),
    "opencode": lambda p, _, m, e: _call_opencode(p, m, e),
    "mimo": lambda p, _, m, e: _call_mimo(p, m, e),
    "reasonix": lambda p, _, m, e: _call_reasonix(p),
}


async def call_agent_cli(agent_name: str, user_message: str, room_context: str = "") -> str:
    persona = AGENT_PERSONAE.get(agent_name)
    if not persona:
        return json.dumps({"agent": agent_name, "action": "think", "target": "all",
                           "content": f"Unknown agent: {agent_name}",
                           "deliverables": [], "next_steps": []}, ensure_ascii=False)

    prompt_text = f"""{persona.system_prompt}

{room_context}
## 用户消息
{user_message}

请以 {agent_name}（{persona.role}）身份回复。"""

    handler = _DISPATCH.get(persona.cli)
    if not handler:
        return json.dumps({"agent": agent_name, "action": "think", "target": "all",
                           "content": f"No CLI for {persona.cli}",
                           "deliverables": [], "next_steps": []}, ensure_ascii=False)

    try:
        raw = await handler(prompt_text, agent_name, persona.model, persona.env)
        return raw
    except asyncio.TimeoutError:
        return json.dumps({"agent": agent_name, "action": "think", "target": "all",
                           "content": f"{agent_name} 响应超时，请稍后重试。",
                           "deliverables": [], "next_steps": ["重试"]}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"agent": agent_name, "action": "think", "target": "all",
                           "content": f"调用出错：{str(e)[:200]}",
                           "deliverables": [], "next_steps": ["检查配置"]}, ensure_ascii=False)


def parse_agent_reply(raw: str) -> dict:
    json_match = re.search(r"```json\s*\n?(.*?)\n?```", raw, re.DOTALL)
    if json_match:
        try: return json.loads(json_match.group(1))
        except json.JSONDecodeError: pass
    try: return json.loads(raw)
    except json.JSONDecodeError: pass
    return {
        "content": raw.strip() or "（无内容）",
        "action": "message", "target": "all",
        "deliverables": [], "next_steps": [],
    }

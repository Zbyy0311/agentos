import asyncio
import re
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List
from app.database import get_db, AsyncSessionLocal
from app import schemas, crud
from app.websocket.manager import manager
from app.services.agent_engine import call_agent_cli, parse_agent_reply

router = APIRouter(prefix="/messages", tags=["messages"])


def _extract_mentioned_agent(content: str) -> str | None:
    """Extract the first @AgentName from message content."""
    match = re.search(r"@(Codex|KimiCode|MimoCode|OpenCode|Reasonix)\b", content)
    return match.group(1) if match else None


async def _resolve_target_agent(content: str, room: str) -> str:
    if room and room != "group":
        agent_id = room.replace("agent_", "")
        return await _get_agent_name_by_id(agent_id) or "Codex"
    return _extract_mentioned_agent(content) or "Codex"


async def _trigger_agent_response(user_msg: schemas.MessageOut):
    """Background task: let the appropriate agent respond to a user message."""
    content = user_msg["content"]
    room = user_msg.get("room", "group")
    agent_name = await _resolve_target_agent(content, room)

    # Build context from recent messages
    context = ""
    try:
        async with AsyncSessionLocal() as db:
            recent = await crud.MessageCRUD.get_all(db, limit=10, room=room)
            if recent:
                context = "## 最近对话记录\n"
                for m in recent:
                    context += f"[{m.agent_name or '系统'}] ({m.action or 'message'}): {m.content[:200]}\n"
    except Exception:
        pass

    print(f"[AgentEngine] Calling {agent_name} for message in room {room}")

    try:
        raw = await call_agent_cli(agent_name, content, context)
        parsed = parse_agent_reply(raw)

        reply_content = parsed.get("content", raw)
        reply_action = parsed.get("action", "message")
        reply_target = parsed.get("target", "all")
        reply_deliverables = parsed.get("deliverables", [])
        reply_next_steps = parsed.get("next_steps", [])

        async with AsyncSessionLocal() as db:
            agent_record = await crud.AgentCRUD.get_by_name(db, agent_name)
            reply = await crud.MessageCRUD.create(db, schemas.MessageCreate(
                agent_id=agent_record.id if agent_record else None,
                agent_name=agent_name,
                role=agent_name,
                action=reply_action,
                target=reply_target,
                room=room,
                content=reply_content,
                deliverables=reply_deliverables,
                next_steps=reply_next_steps,
            ))
            payload = schemas.MessageOut.model_validate(reply).model_dump()
            await manager.broadcast({"type": "message.created", "payload": payload})

            # Update agent status
            if agent_record:
                updated = await crud.AgentCRUD.update(db, agent_record.id, schemas.AgentUpdate(
                    status="idle",
                ))
                await manager.broadcast({
                    "type": "agent.updated",
                    "payload": schemas.AgentOut.model_validate(updated).model_dump(),
                })

        print(f"[AgentEngine] {agent_name} responded ({len(reply_content)} chars)")

    except Exception as e:
        print(f"[AgentEngine] Error calling {agent_name}: {e}")
        # Send error message to chat
        try:
            async with AsyncSessionLocal() as db:
                error_msg = await crud.MessageCRUD.create(db, schemas.MessageCreate(
                    agent_name=agent_name,
                    role=agent_name,
                    action="think",
                    target="all",
                    room=room,
                    content=f"抱歉，我暂时无法响应：{str(e)[:200]}",
                    deliverables=[],
                    next_steps=["请重试或 @Codex 寻求帮助"],
                ))
                payload = schemas.MessageOut.model_validate(error_msg).model_dump()
                await manager.broadcast({"type": "message.created", "payload": payload})
        except Exception:
            pass


async def _get_agent_name_by_id(agent_id: str) -> str | None:
    try:
        async with AsyncSessionLocal() as db:
            agent = await crud.AgentCRUD.get(db, int(agent_id))
            return agent.name if agent else None
    except Exception:
        return None


@router.post("/", response_model=schemas.MessageOut)
async def create_message(message: schemas.MessageCreate, db: AsyncSession = Depends(get_db)):
    created = await crud.MessageCRUD.create(db, message)
    payload = schemas.MessageOut.model_validate(created).model_dump()
    await manager.broadcast({"type": "message.created", "payload": payload})

    # Trigger agent response in background if message is from user
    if message.agent_name == "用户":
        # Update agent status before calling
        agent_to_call = await _resolve_target_agent(message.content, message.room)
        agent_record = await crud.AgentCRUD.get_by_name(db, agent_to_call)
        if agent_record:
            updated_agent = await crud.AgentCRUD.update(db, agent_record.id, schemas.AgentUpdate(
                status="working",
            ))
            await manager.broadcast({
                "type": "agent.updated",
                "payload": schemas.AgentOut.model_validate(updated_agent).model_dump(),
            })

        asyncio.create_task(_trigger_agent_response(payload))

    return created


@router.get("/", response_model=List[schemas.MessageOut])
async def list_messages(limit: int = 100, room: str | None = None, db: AsyncSession = Depends(get_db)):
    return await crud.MessageCRUD.get_all(db, limit=limit, room=room)

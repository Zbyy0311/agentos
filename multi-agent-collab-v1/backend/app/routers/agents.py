from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List
from app.database import get_db
from app import schemas, crud
from app.websocket.manager import manager

router = APIRouter(prefix="/agents", tags=["agents"])


@router.post("/", response_model=schemas.AgentOut)
async def create_agent(agent: schemas.AgentCreate, db: AsyncSession = Depends(get_db)):
    created = await crud.AgentCRUD.create(db, agent)
    await manager.broadcast({"type": "agent.created", "payload": schemas.AgentOut.model_validate(created).model_dump()})
    return created


@router.get("/", response_model=List[schemas.AgentOut])
async def list_agents(db: AsyncSession = Depends(get_db)):
    return await crud.AgentCRUD.get_all(db)


@router.get("/{agent_id}", response_model=schemas.AgentOut)
async def get_agent(agent_id: int, db: AsyncSession = Depends(get_db)):
    agent = await crud.AgentCRUD.get(db, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.patch("/{agent_id}", response_model=schemas.AgentOut)
async def update_agent(agent_id: int, data: schemas.AgentUpdate, db: AsyncSession = Depends(get_db)):
    agent = await crud.AgentCRUD.update(db, agent_id, data)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    await manager.broadcast({"type": "agent.updated", "payload": schemas.AgentOut.model_validate(agent).model_dump()})
    return agent


@router.delete("/{agent_id}")
async def delete_agent(agent_id: int, db: AsyncSession = Depends(get_db)):
    ok = await crud.AgentCRUD.delete(db, agent_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Agent not found")
    await manager.broadcast({"type": "agent.deleted", "payload": {"id": agent_id}})
    return {"ok": True}

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List
from app.database import get_db
from app import schemas, crud
from app.websocket.manager import manager

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.post("/", response_model=schemas.TaskOut)
async def create_task(task: schemas.TaskCreate, db: AsyncSession = Depends(get_db)):
    created = await crud.TaskCRUD.create(db, task)
    await manager.broadcast({"type": "task.created", "payload": schemas.TaskOut.model_validate(created).model_dump()})
    return created


@router.get("/", response_model=List[schemas.TaskOut])
async def list_tasks(db: AsyncSession = Depends(get_db)):
    return await crud.TaskCRUD.get_all(db)


@router.get("/{task_id}", response_model=schemas.TaskOut)
async def get_task(task_id: int, db: AsyncSession = Depends(get_db)):
    task = await crud.TaskCRUD.get(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.patch("/{task_id}", response_model=schemas.TaskOut)
async def update_task(task_id: int, data: schemas.TaskUpdate, db: AsyncSession = Depends(get_db)):
    task = await crud.TaskCRUD.update(db, task_id, data)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    await manager.broadcast({"type": "task.updated", "payload": schemas.TaskOut.model_validate(task).model_dump()})
    return task


@router.delete("/{task_id}")
async def delete_task(task_id: int, db: AsyncSession = Depends(get_db)):
    ok = await crud.TaskCRUD.delete(db, task_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Task not found")
    await manager.broadcast({"type": "task.deleted", "payload": {"id": task_id}})
    return {"ok": True}

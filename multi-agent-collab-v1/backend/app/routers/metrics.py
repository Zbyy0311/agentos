from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List
from app.database import get_db
from app import schemas, crud
from app.websocket.manager import manager

router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.post("/", response_model=schemas.MetricOut)
async def record_metric(metric: schemas.MetricCreate, db: AsyncSession = Depends(get_db)):
    created = await crud.MetricCRUD.create(db, metric)
    await manager.broadcast({"type": "metric.updated", "payload": schemas.MetricOut.model_validate(created).model_dump()})
    return created


@router.get("/", response_model=List[schemas.MetricOut])
async def list_metrics(db: AsyncSession = Depends(get_db)):
    return await crud.MetricCRUD.get_latest(db)

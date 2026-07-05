from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.services.demo_service import run_demo_scenario

router = APIRouter(prefix="/demo", tags=["demo"])


@router.post("/run")
async def run_demo(db: AsyncSession = Depends(get_db)):
    result = await run_demo_scenario(db)
    return result

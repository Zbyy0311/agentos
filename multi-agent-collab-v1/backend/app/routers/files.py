from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List
from app.database import get_db
from app import schemas, crud
from app.websocket.manager import manager

router = APIRouter(prefix="/files", tags=["files"])


@router.post("/", response_model=schemas.RepoFileOut)
async def upsert_file(data: schemas.RepoFileCreate, db: AsyncSession = Depends(get_db)):
    created = await crud.RepoFileCRUD.create_or_update(db, data)
    await manager.broadcast({"type": "file.updated", "payload": schemas.RepoFileOut.model_validate(created).model_dump()})
    return created


@router.get("/", response_model=List[schemas.RepoFileOut])
async def list_files(db: AsyncSession = Depends(get_db)):
    return await crud.RepoFileCRUD.get_all(db)


@router.get("/{file_id}", response_model=schemas.RepoFileOut)
async def get_file(file_id: int, db: AsyncSession = Depends(get_db)):
    file = await crud.RepoFileCRUD.get(db, file_id)
    if not file:
        raise HTTPException(status_code=404, detail="File not found")
    return file

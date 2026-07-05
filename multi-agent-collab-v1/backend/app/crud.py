from datetime import datetime, timezone
from typing import List, Optional
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession
from app import models, schemas


class AgentCRUD:
    @staticmethod
    async def create(db: AsyncSession, agent: schemas.AgentCreate) -> models.Agent:
        db_agent = models.Agent(**agent.model_dump())
        db.add(db_agent)
        await db.commit()
        await db.refresh(db_agent)
        return db_agent

    @staticmethod
    async def get_all(db: AsyncSession) -> List[models.Agent]:
        result = await db.execute(select(models.Agent).order_by(models.Agent.id))
        return result.scalars().all()

    @staticmethod
    async def get(db: AsyncSession, agent_id: int) -> Optional[models.Agent]:
        result = await db.execute(select(models.Agent).where(models.Agent.id == agent_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def get_by_name(db: AsyncSession, name: str) -> Optional[models.Agent]:
        result = await db.execute(select(models.Agent).where(models.Agent.name == name))
        return result.scalar_one_or_none()

    @staticmethod
    async def update(db: AsyncSession, agent_id: int, data: schemas.AgentUpdate) -> Optional[models.Agent]:
        db_agent = await AgentCRUD.get(db, agent_id)
        if not db_agent:
            return None
        for key, value in data.model_dump(exclude_unset=True).items():
            setattr(db_agent, key, value)
        db_agent.last_active_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(db_agent)
        return db_agent

    @staticmethod
    async def delete(db: AsyncSession, agent_id: int) -> bool:
        db_agent = await AgentCRUD.get(db, agent_id)
        if not db_agent:
            return False
        await db.delete(db_agent)
        await db.commit()
        return True


class TaskCRUD:
    @staticmethod
    async def create(db: AsyncSession, task: schemas.TaskCreate) -> models.Task:
        db_task = models.Task(**task.model_dump())
        db.add(db_task)
        await db.commit()
        await db.refresh(db_task)
        return db_task

    @staticmethod
    async def get_all(db: AsyncSession) -> List[models.Task]:
        result = await db.execute(select(models.Task).order_by(models.Task.id))
        return result.scalars().all()

    @staticmethod
    async def get(db: AsyncSession, task_id: int) -> Optional[models.Task]:
        result = await db.execute(select(models.Task).where(models.Task.id == task_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def update(db: AsyncSession, task_id: int, data: schemas.TaskUpdate) -> Optional[models.Task]:
        db_task = await TaskCRUD.get(db, task_id)
        if not db_task:
            return None
        for key, value in data.model_dump(exclude_unset=True).items():
            setattr(db_task, key, value)
        await db.commit()
        await db.refresh(db_task)
        return db_task

    @staticmethod
    async def delete(db: AsyncSession, task_id: int) -> bool:
        db_task = await TaskCRUD.get(db, task_id)
        if not db_task:
            return False
        await db.delete(db_task)
        await db.commit()
        return True


class MessageCRUD:
    @staticmethod
    async def create(db: AsyncSession, message: schemas.MessageCreate) -> models.Message:
        db_message = models.Message(**message.model_dump())
        db.add(db_message)
        await db.commit()
        await db.refresh(db_message)
        return db_message

    @staticmethod
    async def get_all(db: AsyncSession, limit: int = 100, room: Optional[str] = None) -> List[models.Message]:
        stmt = select(models.Message)
        if room:
            stmt = stmt.where(models.Message.room == room)
        stmt = stmt.order_by(desc(models.Message.created_at)).limit(limit)
        result = await db.execute(stmt)
        return list(reversed(result.scalars().all()))


class RepoFileCRUD:
    @staticmethod
    async def create_or_update(db: AsyncSession, data: schemas.RepoFileCreate) -> models.RepoFile:
        result = await db.execute(select(models.RepoFile).where(models.RepoFile.path == data.path))
        existing = result.scalar_one_or_none()
        if existing:
            existing.content = data.content
            existing.agent_id = data.agent_id
            existing.agent_name = data.agent_name
            existing.version += 1
            await db.commit()
            await db.refresh(existing)
            return existing
        db_file = models.RepoFile(**data.model_dump())
        db.add(db_file)
        await db.commit()
        await db.refresh(db_file)
        return db_file

    @staticmethod
    async def get_all(db: AsyncSession) -> List[models.RepoFile]:
        result = await db.execute(select(models.RepoFile).order_by(models.RepoFile.path))
        return result.scalars().all()

    @staticmethod
    async def get(db: AsyncSession, file_id: int) -> Optional[models.RepoFile]:
        result = await db.execute(select(models.RepoFile).where(models.RepoFile.id == file_id))
        return result.scalar_one_or_none()


class MetricCRUD:
    @staticmethod
    async def create(db: AsyncSession, metric: schemas.MetricCreate) -> models.Metric:
        db_metric = models.Metric(**metric.model_dump())
        db.add(db_metric)
        await db.commit()
        await db.refresh(db_metric)
        return db_metric

    @staticmethod
    async def get_latest(db: AsyncSession) -> List[models.Metric]:
        subq = (
            select(models.Metric.agent_id, models.Metric.id)
            .order_by(desc(models.Metric.recorded_at))
            .distinct(models.Metric.agent_id)
            .subquery()
        )
        result = await db.execute(select(models.Metric).join(subq, models.Metric.id == subq.c.id))
        return result.scalars().all()

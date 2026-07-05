import enum
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Enum, Float, JSON
from sqlalchemy.orm import relationship
from app.database import Base


def utc_now():
    return datetime.now(timezone.utc)


class AgentStatus(str, enum.Enum):
    IDLE = "idle"
    WORKING = "working"
    WAITING = "waiting"


class TaskStatus(str, enum.Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    DONE = "done"


class Agent(Base):
    __tablename__ = "agents"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(64), nullable=False)
    role = Column(String(64), nullable=False)
    avatar = Column(String(256), nullable=True)
    status = Column(Enum(AgentStatus), default=AgentStatus.IDLE)
    skills = Column(JSON, default=list)
    current_task_id = Column(Integer, ForeignKey("tasks.id", use_alter=True), nullable=True)
    progress = Column(Integer, default=0)
    last_active_at = Column(DateTime, default=utc_now)
    created_at = Column(DateTime, default=utc_now)

    current_task = relationship("Task", foreign_keys=[current_task_id], back_populates="assignees")


class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(256), nullable=False)
    description = Column(Text, nullable=True)
    status = Column(Enum(TaskStatus), default=TaskStatus.TODO)
    priority = Column(String(16), default="medium")
    assignee_id = Column(Integer, ForeignKey("agents.id"), nullable=True)
    dependencies = Column(JSON, default=list)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    assignees = relationship("Agent", foreign_keys=[Agent.current_task_id], back_populates="current_task")


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(Integer, ForeignKey("agents.id"), nullable=True)
    agent_name = Column(String(64), nullable=True)
    role = Column(String(64), nullable=True)
    action = Column(String(32), default="message")
    target = Column(String(64), default="all")
    room = Column(String(64), default="group", index=True)
    content = Column(Text, nullable=False)
    deliverables = Column(JSON, default=list)
    next_steps = Column(JSON, default=list)
    created_at = Column(DateTime, default=utc_now)


class RepoFile(Base):
    __tablename__ = "repo_files"

    id = Column(Integer, primary_key=True, index=True)
    path = Column(String(512), nullable=False, unique=True)
    content = Column(Text, nullable=True)
    agent_id = Column(Integer, ForeignKey("agents.id"), nullable=True)
    agent_name = Column(String(64), nullable=True)
    version = Column(Integer, default=1)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class Metric(Base):
    __tablename__ = "metrics"

    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(Integer, ForeignKey("agents.id"), nullable=True)
    response_time_ms = Column(Float, default=0.0)
    lines_of_code = Column(Integer, default=0)
    warnings = Column(Integer, default=0)
    errors = Column(Integer, default=0)
    health_score = Column(Float, default=100.0)
    recorded_at = Column(DateTime, default=utc_now)

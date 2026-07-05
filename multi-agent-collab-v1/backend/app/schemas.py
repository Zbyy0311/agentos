from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, ConfigDict


class AgentBase(BaseModel):
    name: str
    role: str
    avatar: Optional[str] = None
    status: str = "idle"
    skills: List[str] = []
    progress: int = 0


class AgentCreate(AgentBase):
    pass


class AgentUpdate(BaseModel):
    status: Optional[str] = None
    progress: Optional[int] = None
    current_task_id: Optional[int] = None


class AgentOut(AgentBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    current_task_id: Optional[int] = None
    last_active_at: datetime
    created_at: datetime


class TaskBase(BaseModel):
    title: str
    description: Optional[str] = None
    status: str = "todo"
    priority: str = "medium"
    assignee_id: Optional[int] = None
    dependencies: List[int] = []


class TaskCreate(TaskBase):
    pass


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    assignee_id: Optional[int] = None
    dependencies: Optional[List[int]] = None


class TaskOut(TaskBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    updated_at: datetime


class MessageBase(BaseModel):
    agent_id: Optional[int] = None
    agent_name: Optional[str] = None
    role: Optional[str] = None
    action: str = "message"
    target: str = "all"
    room: str = "group"
    content: str
    deliverables: List[str] = []
    next_steps: List[str] = []


class MessageCreate(MessageBase):
    pass


class MessageOut(MessageBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime


class RepoFileBase(BaseModel):
    path: str
    content: Optional[str] = None
    agent_id: Optional[int] = None
    agent_name: Optional[str] = None


class RepoFileCreate(RepoFileBase):
    pass


class RepoFileOut(RepoFileBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    version: int
    created_at: datetime
    updated_at: datetime


class MetricBase(BaseModel):
    agent_id: Optional[int] = None
    response_time_ms: float = 0.0
    lines_of_code: int = 0
    warnings: int = 0
    errors: int = 0
    health_score: float = 100.0


class MetricCreate(MetricBase):
    pass


class MetricOut(MetricBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    recorded_at: datetime


class WSMessage(BaseModel):
    type: str
    payload: dict

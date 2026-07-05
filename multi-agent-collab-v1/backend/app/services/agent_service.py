from sqlalchemy.ext.asyncio import AsyncSession
from app import models
from app.crud import AgentCRUD


async def seed_default_agents(db: AsyncSession):
    existing = await AgentCRUD.get_all(db)
    if existing:
        return

    defaults = [
        models.Agent(name="Codex", role="总指挥 / 系统架构师", status="idle",
                     skills=["任务分解", "架构决策", "冲突仲裁", "进度追踪"]),
        models.Agent(name="KimiCode", role="后端工程师", status="idle",
                     skills=["API 设计", "数据库建模", "服务端逻辑", "性能优化"]),
        models.Agent(name="MimoCode", role="前端工程师", status="idle",
                     skills=["React", "Tailwind", "组件设计", "响应式布局"]),
        models.Agent(name="OpenCode", role="DevOps 工程师", status="idle",
                     skills=["Docker", "CI/CD", "Kubernetes", "监控告警"]),
        models.Agent(name="Reasonix", role="技术分析师", status="idle",
                     skills=["代码审查", "方案评估", "风险分析", "技术选型"]),
    ]
    db.add_all(defaults)
    await db.commit()

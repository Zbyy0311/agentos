import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from app.main import app
from app.database import Base, get_db

DATABASE_URL = "sqlite+aiosqlite:///./test.db"
engine = create_async_engine(DATABASE_URL, echo=False, future=True)
TestSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture(scope="function")
async def db_session():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with TestSessionLocal() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture(scope="function")
async def client(db_session):
    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_create_and_list_agents(client):
    r = await client.post("/agents/", json={"name": "TestAgent", "role": "tester"})
    assert r.status_code == 200
    assert r.json()["name"] == "TestAgent"

    r = await client.get("/agents/")
    assert r.status_code == 200
    assert any(a["name"] == "TestAgent" for a in r.json())


@pytest.mark.asyncio
async def test_create_and_update_task(client):
    r = await client.post("/tasks/", json={"title": "Test Task", "status": "todo"})
    assert r.status_code == 200
    task_id = r.json()["id"]

    r = await client.patch(f"/tasks/{task_id}", json={"status": "in_progress"})
    assert r.status_code == 200
    assert r.json()["status"] == "in_progress"


@pytest.mark.asyncio
async def test_messages(client):
    r = await client.post("/messages/", json={"content": "hello", "agent_name": "Codex"})
    assert r.status_code == 200
    assert r.json()["content"] == "hello"

    r = await client.get("/messages/")
    assert r.status_code == 200
    assert len(r.json()) >= 1

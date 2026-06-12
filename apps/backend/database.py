from sqlmodel import SQLModel, create_engine, Session
from config import settings

# If we are using SQLite, we need to configure it to allow multi-threaded access
connect_args = {}
if settings.DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

# 1. Create the Database Engine
engine = create_engine(
    settings.DATABASE_URL, 
    echo=False,  # Set to True if you want to see raw SQL logs in the terminal
    connect_args=connect_args
)

# 2. Database Initializer (Runs when the server starts)
def init_db():
    # This reads all tables defined in models.py and creates them in SQL
    SQLModel.metadata.create_all(engine)

# 3. Session Dependency (Used by FastAPI routes to query the DB)
def get_session():
    with Session(engine) as session:
        yield session

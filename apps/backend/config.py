# Application configuration settings
import os
from dotenv import load_dotenv

load_dotenv()

# Explicitly set credentials for Vertex AI SDKs (google-genai and langchain)
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = os.path.join(os.path.dirname(__file__), "google-credentials.json")

class Setting:
    GEMINI_API_KEY=os.getenv("GEMINI_API_KEY")
    OPENAI_KEY=os.getenv("OPENAI_KEY")
    DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./interview.db")
    PROXY_URL=os.getenv("PROXY_URL")
    PORT: int=int(os.getenv("PORT","3001"))

settings=Setting()
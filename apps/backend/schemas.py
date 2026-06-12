from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel

# 1. Response returned after uploading a resume
class PreInterviewResponse(BaseModel):
    id: str

# 2. Request body received when saving a user's spoken answer
class UserResponseRequest(BaseModel):
    message: str

# 3. Response returned after saving a user's spoken answer
class UserResponseResponse(BaseModel):
    message: str

# 4. A single message item in the final transcript list
class TranscriptItem(BaseModel):
    type: str  # "User" or "Assistant"
    content: str
    createdAt: datetime

# 5. Full response returned when fetching the interview score & feedback
class ResultResponse(BaseModel):
    score: int
    feedback: Optional[str] = None
    status: str
    transcript: List[TranscriptItem]

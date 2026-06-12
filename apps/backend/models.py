from datetime import datetime
from enum import Enum
from typing import List, Optional
from uuid import uuid4
# pyrefly: ignore [missing-import]
from sqlmodel import Field, Relationship, SQLModel, JSON

# Define the status states of an interview
class InterviewStatus(str, Enum):
    PRE = "Pre"
    IN_PROGRESS = "InProgress"
    DONE = "Done"

# Define the message sender types
class MessageType(str, Enum):
    USER = "User"
    ASSISTANT = "Assistant"

# The Interview Table
class Interview(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid4()), primary_key=True)
    
    # Store the parsed resume info (Name, Skills, GitHub/LinkedIn URLs, etc.) as JSON
    candidate_metadata: dict = Field(default_factory=dict, sa_type=JSON)
    
    status: InterviewStatus = Field(default=InterviewStatus.PRE)
    score: int = Field(default=0)
    feedback: Optional[str] = Field(default=None)
    
    # Link back to the messages in this interview
    messages: List["Message"] = Relationship(back_populates="interview")


# The Message Table (Transcript)
class Message(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid4()), primary_key=True)
    message: str
    type: MessageType
    created_at: datetime = Field(default_factory=datetime.utcnow)
    
    # Foreign key to associate the message with a specific interview
    interview_id: str = Field(foreign_key="interview.id")
    interview: Optional[Interview] = Relationship(back_populates="messages")

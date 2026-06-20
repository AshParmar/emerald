from contextlib import asynccontextmanager
import asyncio
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, Depends, File, UploadFile, HTTPException, WebSocket, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from database import init_db, get_session, engine
from models import Interview, Message, MessageType, InterviewStatus
from schemas import UserResponseRequest, UserResponseResponse, ResultResponse, TranscriptItem
from resume_parser import extract_text_from_pdf, parse_resume_with_gemini
from sideband import handle_gemini_live_session
from result import calculate_result

# Thread pool for running blocking LangGraph grading off the async event loop
_grading_executor = ThreadPoolExecutor(max_workers=4)
# Track which interviews are currently being graded (avoid duplicate runs)
_grading_in_progress: set[str] = set()

# 1. Setup Lifespan to initialize the DB tables on server start
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()  # Automatically creates SQLite database & tables if they don't exist
    yield

# 2. Initialize FastAPI app
app = FastAPI(lifespan=lifespan)

# 3. Configure CORS (Cross-Origin Resource Sharing)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Endpoint 1: Upload Resume & Extract Profile ---
@app.post("/api/v1/pre-interview")
async def pre_interview(
    file: UploadFile = File(...), 
    db: Session = Depends(get_session)
):
    try:
        # Read the file bytes
        file_bytes = await file.read()
        
        # Extract the raw text from the PDF
        resume_text = extract_text_from_pdf(file_bytes)
        
        # Send the text to Gemini to parse it into structured info
        profile_metadata = parse_resume_with_gemini(resume_text)
        
        # Create a new Interview record in our database
        interview = Interview(
            candidate_metadata=profile_metadata,
            status=InterviewStatus.PRE
        )
        db.add(interview)
        db.commit()
        db.refresh(interview)
        
        return {"id": interview.id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process resume: {str(e)}")

# --- Endpoint 2: Bidirectional WebSocket Proxy for Gemini Live Voice ---
@app.websocket("/api/v1/session/live/{interview_id}")
async def session_live(
    websocket: WebSocket, 
    interview_id: str, 
    db: Session = Depends(get_session)
):
    # Delegate the WebSocket connection proxy handling to sideband.py
    await handle_gemini_live_session(websocket, interview_id, db)

# --- Endpoint 3: Save User Spoken Answer ---
@app.post("/api/v1/session/user/response/{interview_id}", response_model=UserResponseResponse)
async def save_user_response(
    interview_id: str,
    payload: UserResponseRequest,
    db: Session = Depends(get_session)
):
    # Create and commit the user spoken message to the transcript table
    message = Message(
        interview_id=interview_id,
        type=MessageType.USER,
        message=payload.message
    )
    db.add(message)
    db.commit()
    return {"message": "Message saved"}

def _run_grading(interview_id: str):
    """Blocking grading task — runs in a thread pool so it doesn't block the event loop."""
    import time
    # Wait for sideband.py's finally block to finish saving profile summary / transcript
    # (browser navigates to results page before the WebSocket session fully tears down)
    time.sleep(4)

    with Session(engine) as db:
        interview = db.get(Interview, interview_id)
        if not interview or interview.status == InterviewStatus.DONE:
            _grading_in_progress.discard(interview_id)
            return
        try:
            statement = select(Message).where(Message.interview_id == interview_id).order_by(Message.created_at)
            messages = db.exec(statement).all()
            print(f"[grading] Found {len(messages)} messages for {interview_id[:8]}")
            evaluation = calculate_result(messages)
            interview.score = evaluation["score"]
            interview.feedback = evaluation["feedback"]
            interview.status = InterviewStatus.DONE
            db.add(interview)
            db.commit()
            print(f"[grading] Completed for {interview_id[:8]}: score={evaluation['score']}")
        except Exception as e:
            print(f"[grading] Error for {interview_id}: {e}")
        finally:
            _grading_in_progress.discard(interview_id)


# --- Endpoint 4: Fetch Grading Results & Transcript ---
@app.get("/api/v1/result/{interview_id}", response_model=ResultResponse)
async def get_result(
    interview_id: str,
    db: Session = Depends(get_session)
):
    interview = db.get(Interview, interview_id)
    if not interview:
        raise HTTPException(status_code=404, detail="Interview not found")

    # Kick off background grading if not yet done and not already running
    if interview.status != InterviewStatus.DONE and interview_id not in _grading_in_progress:
        _grading_in_progress.add(interview_id)
        loop = asyncio.get_event_loop()
        loop.run_in_executor(_grading_executor, _run_grading, interview_id)
        print(f"[grading] Started background grading for {interview_id}")

    # Gather transcript (available immediately, even while grading is in progress)
    statement = select(Message).where(Message.interview_id == interview_id).order_by(Message.created_at)
    db_messages = db.exec(statement).all()

    transcript = [
        TranscriptItem(
            type=msg.type.value if hasattr(msg.type, "value") else str(msg.type),
            content=msg.message,
            createdAt=msg.created_at
        ) for msg in db_messages
    ]

    # Re-read interview to get latest status (grading may have finished)
    db.refresh(interview)

    return ResultResponse(
        score=interview.score or 0,
        feedback=interview.feedback or "",
        status=interview.status.value if hasattr(interview.status, "value") else str(interview.status),
        transcript=transcript
    )

import json
import asyncio
import base64
import sys
from fastapi import WebSocket, WebSocketDisconnect
from sqlmodel import Session
from database import engine
from models import Interview, Message, MessageType, InterviewStatus
from config import settings

from google import genai
from google.genai import types

import os

# Fix Windows console encoding crash when AI returns Unicode (arrows, em-dashes etc)
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

async def handle_gemini_live_session(websocket: WebSocket, interview_id: str, db: Session):
    await websocket.accept()
    
    interview = db.get(Interview, interview_id)
    if not interview:
        await websocket.close(code=4000, reason="Interview not found")
        return
        
    metadata = interview.candidate_metadata
    name = metadata.get("name", "Candidate")
    skills = ", ".join(metadata.get("skills", []))
    summary = metadata.get("summary", "")
    
    instructions = (
        "You are a professional AI technical interviewer. Your goal is to interview the candidate "
        "on their software engineering capabilities. Ask around 2-3 detailed technical questions based on their resume.\n"
        "Keep your questions/replies relatively brief (1-3 sentences) as this is a voice conversation.\n"
        "Please speak in English only.\n\n"
        f"Candidate Name: {name}\n"
        f"Technical Skills: {skills}\n"
        f"Resume Summary: {summary}\n"
    )
    
    interview.status = InterviewStatus.IN_PROGRESS
    db.add(interview)
    db.commit()

    try:
        client = genai.Client(
            vertexai=True,
            project=os.environ.get("GOOGLE_CLOUD_PROJECT", "gen-lang-client-0120163642"),
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        )
        print("Connecting to Vertex AI Live API...")
        
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Puck"
                    )
                )
            ),
            system_instruction=types.Content(
                parts=[types.Part.from_text(text=instructions)]
            )
        )
        
        async with client.aio.live.connect(
            model="gemini-live-2.5-flash-native-audio",
            config=config
        ) as session:
            print("Connected to Vertex AI Live API!")
            
            # Kick off the interview using send_realtime_input text
            await session.send_realtime_input(
                text="Hello, I am ready. Please start the interview by introducing yourself and asking the first question."
            )
            print("[sideband] Sent initial text prompt")
            
            current_assistant_text = []
            stop_event = asyncio.Event()
            
            # Task A: Browser -> Gemini
            async def client_to_gemini():
                print("[client_to_gemini] Started")
                try:
                    async for message in websocket.iter_json():
                        if stop_event.is_set():
                            break
                        msg_type = message.get("type")
                        
                        if msg_type == "activity_end":
                            print("[client_to_gemini] Sending activity_end to Vertex AI")
                            await session.send_realtime_input(activity_end=types.ActivityEnd())
                            continue
                        
                        if "audio" in message:
                            audio_bytes = base64.b64decode(message["audio"])
                            await session.send_realtime_input(
                                audio=types.Blob(
                                    mime_type="audio/pcm;rate=16000",
                                    data=audio_bytes
                                )
                            )
                            
                except WebSocketDisconnect:
                    print("[client_to_gemini] Browser disconnected.")
                except Exception as e:
                    safe = str(e).encode('ascii', errors='replace').decode('ascii')
                    print(f"[client_to_gemini] Error: {safe}")
                finally:
                    stop_event.set()

            # Task B: Gemini -> Browser
            async def gemini_to_client():
                print("[gemini_to_client] Started")
                try:
                    async for response in session.receive():
                        if stop_event.is_set():
                            break
                        server_content = response.server_content
                        if server_content is None:
                            continue
                            
                        model_turn = server_content.model_turn
                        if model_turn is not None:
                            for part in model_turn.parts:
                                if part.inline_data:
                                    audio_b64 = base64.b64encode(part.inline_data.data).decode('utf-8')
                                    if not stop_event.is_set():
                                        await websocket.send_json({"audio": audio_b64})
                                    
                                if part.text:
                                    current_assistant_text.append(part.text)
                                    if not stop_event.is_set():
                                        await websocket.send_json({"transcript": part.text})
                                    safe = part.text.encode('ascii', errors='replace').decode('ascii')
                                    print(f"[gemini_to_client] Transcript: {safe}")
                                        
                        if server_content.turn_complete:
                            print("[gemini_to_client] turn_complete received")
                            # Notify browser that AI finished speaking
                            if not stop_event.is_set():
                                await websocket.send_json({"turn_complete": True})
                            if current_assistant_text:
                                full_text = "".join(current_assistant_text)
                                with Session(engine) as db_sess:
                                    db_message = Message(
                                        interview_id=interview_id,
                                        type=MessageType.ASSISTANT,
                                        message=full_text
                                    )
                                    db_sess.add(db_message)
                                    db_sess.commit()
                                current_assistant_text.clear()
                                    
                except Exception as e:
                    safe = str(e).encode('ascii', errors='replace').decode('ascii')
                    print(f"[gemini_to_client] Error: {safe}")
                finally:
                    stop_event.set()

            await asyncio.gather(client_to_gemini(), gemini_to_client())
            
    except Exception as e:
        print(f"Session failed: {e}")
    finally:
        try:
            await websocket.close()
        except:
            pass

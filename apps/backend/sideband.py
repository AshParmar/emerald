import asyncio
import base64
import sys
from fastapi import WebSocket, WebSocketDisconnect
from sqlmodel import Session
from database import engine
from models import Interview, Message, MessageType, InterviewStatus

from google import genai
from google.genai import types

import os

# Fix Windows console encoding crash
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except AttributeError:
    pass


async def handle_gemini_live_session(websocket: WebSocket, interview_id: str, db: Session):
    await websocket.accept()
    print(f"[sideband] WebSocket accepted for interview {interview_id[:8]}")

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
        "on their software engineering capabilities. Ask around 3 detailed technical questions based on their resume.\n"
        "Keep your questions/replies relatively brief (1-3 sentences) as this is a voice conversation.\n"
        "Please speak in English only.\n\n"
        f"Candidate Name: {name}\n"
        f"Technical Skills: {skills}\n"
        f"Resume Summary: {summary}\n"
    )

    interview.status = InterviewStatus.IN_PROGRESS
    db.add(interview)
    db.commit()

    ai_turn_count = 0

    try:
        client = genai.Client(
            vertexai=True,
            project=os.environ.get("GOOGLE_CLOUD_PROJECT", "gen-lang-client-0120163642"),
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        )
        print("[sideband] Connecting to Vertex AI Live API...")

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Puck"
                    )
                )
            ),
            # Disable automatic VAD — frontend sends explicit activity_end after user stops speaking
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=True,
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
            print("[sideband] Connected to Vertex AI Live API!")

            await session.send_realtime_input(
                text="Hello, I am ready. Please start the interview by introducing yourself and asking the first question."
            )
            print("[sideband] Sent initial text prompt")

            current_assistant_text = []
            current_user_text = []
            stop_event = asyncio.Event()
            MAX_TURNS = 10

            # ── Task A: Browser → Gemini ───────────────────────────────────────
            async def client_to_gemini():
                print("[client_to_gemini] Started")
                try:
                    async for message in websocket.iter_json():
                        if stop_event.is_set():
                            break
                        msg_type = message.get("type")
                        if msg_type == "activity_start":
                            print("[client_to_gemini] activity_start → Vertex AI")
                            await session.send_realtime_input(activity_start=types.ActivityStart())
                            continue
                        if msg_type == "activity_end":
                            print("[client_to_gemini] activity_end → Vertex AI")
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
                    print(f"[client_to_gemini] Error: {str(e)[:200]}")
                finally:
                    stop_event.set()

            # ── Task B: Gemini → Browser ───────────────────────────────────────
            async def gemini_to_client():
                nonlocal ai_turn_count
                print("[gemini_to_client] Started")
                try:
                    while not stop_event.is_set():
                        async for response in session.receive():
                            if stop_event.is_set():
                                return

                            server_content = response.server_content
                            if server_content is None:
                                continue

                            # User speech transcription
                            input_tr = getattr(server_content, 'input_audio_transcription', None)
                            if input_tr:
                                text = getattr(input_tr, 'text', None)
                                if text and text.strip():
                                    current_user_text.append(text.strip())
                                    print(f"[transcript] User: {text.strip()[:80]}")

                            # AI speech transcription
                            output_tr = getattr(server_content, 'output_audio_transcription', None)
                            if output_tr:
                                text = getattr(output_tr, 'text', None)
                                if text and text.strip():
                                    current_assistant_text.append(text.strip())
                                    print(f"[transcript] AI: {text.strip()[:80]}")
                                    await websocket.send_json({"transcript": text.strip()})

                            # Audio chunks → browser for playback
                            model_turn = server_content.model_turn
                            if model_turn is not None:
                                for part in model_turn.parts:
                                    if part.inline_data:
                                        audio_b64 = base64.b64encode(part.inline_data.data).decode('utf-8')
                                        await websocket.send_json({"audio": audio_b64})
                                    # Fallback: text parts from non-native models
                                    if part.text and part.text.strip():
                                        current_assistant_text.append(part.text.strip())
                                        await websocket.send_json({"transcript": part.text.strip()})

                            # Turn complete
                            if server_content.turn_complete:
                                ai_turn_count += 1
                                print(f"[gemini_to_client] turn_complete — AI turn #{ai_turn_count}")

                                # Save user text if available
                                if current_user_text:
                                    msg = " ".join(current_user_text)
                                    with Session(engine) as s:
                                        s.add(Message(interview_id=interview_id, type=MessageType.USER, message=msg))
                                        s.commit()
                                    print(f"[db] Saved user msg ({len(msg)} chars)")
                                    current_user_text.clear()

                                # Save AI text if available
                                if current_assistant_text:
                                    msg = " ".join(current_assistant_text)
                                    with Session(engine) as s:
                                        s.add(Message(interview_id=interview_id, type=MessageType.ASSISTANT, message=msg))
                                        s.commit()
                                    print(f"[db] Saved AI msg ({len(msg)} chars)")
                                    current_assistant_text.clear()
                                else:
                                    print(f"[db] No transcription text this turn (model may not support it)")

                                # End after MAX_TURNS
                                if ai_turn_count >= MAX_TURNS:
                                    print("[sideband] Max turns reached — ending session")
                                    await websocket.send_json({"interview_complete": True})
                                    stop_event.set()
                                    return

                                await websocket.send_json({"turn_complete": True})
                                break  # re-enter session.receive() for next turn

                except Exception as e:
                    if not stop_event.is_set():
                        print(f"[gemini_to_client] Error: {str(e)[:200]}")
                finally:
                    stop_event.set()

            await asyncio.gather(client_to_gemini(), gemini_to_client())

    except Exception as e:
        print(f"[sideband] Session failed: {str(e)[:300]}")
    finally:
        # If transcription returned nothing (native-audio model limitation),
        # save a profile-based summary so the grader has context
        try:
            with Session(engine) as s:
                from sqlmodel import select
                msg_count = len(s.exec(
                    select(Message).where(Message.interview_id == interview_id)
                ).all())

            if msg_count == 0 and ai_turn_count > 0:
                print(f"[sideband] No messages saved after {ai_turn_count} turns — saving profile summary for grader")
                summary_msg = (
                    f"[Voice interview completed — transcription unavailable for this model]\n"
                    f"Candidate: {name}\n"
                    f"Skills assessed: {skills}\n"
                    f"Background: {summary}\n"
                    f"Interview duration: {ai_turn_count} AI turns completed.\n"
                    f"The interview covered technical questions based on the candidate's background."
                )
                with Session(engine) as s:
                    s.add(Message(interview_id=interview_id, type=MessageType.ASSISTANT, message=summary_msg))
                    s.commit()
                print("[db] Saved profile summary for grading context")
        except Exception as e:
            print(f"[sideband] Finally block error: {e}")

        try:
            await websocket.close()
        except Exception:
            pass

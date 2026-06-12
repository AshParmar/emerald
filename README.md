# AI Interview Kickstart

A full-stack AI-powered mock interview platform that conducts real-time voice interviews using Google's Gemini Live API.

## What it does

Upload your resume and get interviewed in real-time by an AI interviewer that listens to your voice and responds naturally with speech. After the session, receive an AI-generated score and written feedback on your performance.

## Tech Stack

- **Frontend** — React + TypeScript, served via Bun, styled with Tailwind CSS
- **Backend** — Python FastAPI, SQLite via SQLModel
- **AI** — Google Gemini Live 2.5 Flash (Native Audio) via Vertex AI — real-time bidirectional voice streaming
- **Monorepo** — Turborepo with Bun workspaces

## Project Structure

```
emerald/
├── apps/
│   ├── frontend/   # React SPA — resume upload, live interview UI, results page
│   └── backend/    # FastAPI — resume parsing, Vertex AI WebSocket bridge, scoring
└── packages/       # Shared TypeScript configs and UI components
```

## Features

- Resume parsing to extract candidate skills and experience
- Live voice interview powered by Gemini native audio
- Real-time audio streaming via WebSocket (browser ↔ backend ↔ Vertex AI)
- Post-interview scoring and structured written feedback
- SQLite persistence for sessions and transcripts

## Getting Started

**Backend:**
```bash
cd apps/backend
uvicorn main:app --port 3001 --reload
```

**Frontend:**
```bash
cd apps/frontend
bun --hot src/index.ts
```

Set up your Google Cloud credentials in `apps/backend/.env` before running.
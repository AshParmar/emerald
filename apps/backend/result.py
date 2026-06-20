from typing import List, TypedDict, Optional
from pydantic import BaseModel, Field
from langchain_google_vertexai import ChatVertexAI
import os
from langgraph.graph import StateGraph, START, END

# 1. Define the LangGraph State dictionary
class GradingState(TypedDict):
    transcript_text: str
    technical_feedback: str
    communication_feedback: str
    final_score: int
    final_feedback: str

# 2. Define the Pydantic schema for the final compiled grade
class FinalGrade(BaseModel):
    score: int = Field(description="Technical interview score out of 10")
    feedback: str = Field(description="Cohesive, professional feedback summarizing the candidate's performance and areas of improvement")

# Helper to load the Gemini model
def get_llm():
    return ChatVertexAI(
        model="gemini-2.5-flash",
        project=os.environ.get("GOOGLE_CLOUD_PROJECT", "gen-lang-client-0120163642"),
        location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1"),
        temperature=0.2
    )

# --- Node 1: Technical Knowledge Evaluation ---
def evaluate_technical_correctness(state: GradingState) -> dict:
    llm = get_llm()
    prompt = f"""You are an expert technical interviewer evaluating a candidate.

Below is the interview content. It may be a full conversation transcript, or it may be a candidate
profile summary when live transcription was unavailable.

Interview Content:
{state['transcript_text']}

Based on the above, evaluate the candidate's technical capabilities. Consider their listed skills,
background, and any answers they gave. If only a profile summary is available, give a fair assessment
based on the depth of their skill set and experience.

Provide a concise technical evaluation (2-3 sentences)."""
    response = llm.invoke(prompt)
    return {"technical_feedback": response.content}

# --- Node 2: Communication Skills Evaluation ---
def evaluate_communication_skills(state: GradingState) -> dict:
    llm = get_llm()
    prompt = f"""You are an expert evaluator assessing a candidate after a voice technical interview.

Interview Content:
{state['transcript_text']}

Based on the above, evaluate communication and presentation skills. If only a profile summary is
available (transcription unavailable), base your assessment on the breadth and presentation of their
documented experience and skill diversity.

Provide a concise communication evaluation (2-3 sentences)."""
    response = llm.invoke(prompt)
    return {"communication_feedback": response.content}

# --- Node 3: Final Grading Compiler (Structured Output) ---
def compile_final_result(state: GradingState) -> dict:
    llm = get_llm()
    structured_llm = llm.with_structured_output(FinalGrade)

    prompt = f"""You are a final panel evaluator compiling interview results.

Interview Content:
{state['transcript_text']}

Technical Evaluation:
{state['technical_feedback']}

Communication Evaluation:
{state['communication_feedback']}

Compile a final score (1-10) and cohesive written feedback for the candidate.
Even if only a profile summary is available, give a score reflecting their apparent skill level.
A score of 0 means "transcript not provided" — NEVER return 0; always return at least 1.
Be constructive and specific."""

    result: FinalGrade = structured_llm.invoke(prompt)
    return {
        "final_score": max(1, result.score),  # ensure never 0
        "final_feedback": result.feedback
    }

# 3. Construct the LangGraph State Graph
workflow = StateGraph(GradingState)
workflow.add_node("tech_eval", evaluate_technical_correctness)
workflow.add_node("comm_eval", evaluate_communication_skills)
workflow.add_node("compiler", compile_final_result)

workflow.add_edge(START, "tech_eval")
workflow.add_edge("tech_eval", "comm_eval")
workflow.add_edge("comm_eval", "compiler")
workflow.add_edge("compiler", END)

grading_graph = workflow.compile()

# --- External facing function ---
def calculate_result(messages) -> dict:
    """Formats messages from DB, runs them through the LangGraph, and returns the score and feedback."""
    if not messages:
        return {
            "score": 0,
            "feedback": "No interview data available to grade."
        }

    formatted_transcript = ""
    for msg in messages:
        sender = msg.type.value if hasattr(msg.type, "value") else str(msg.type)
        content = msg.message
        formatted_transcript += f"{sender}: {content}\n\n"

    initial_state = {
        "transcript_text": formatted_transcript,
        "technical_feedback": "",
        "communication_feedback": "",
        "final_score": 0,
        "final_feedback": ""
    }
    final_output = grading_graph.invoke(initial_state)

    return {
        "score": final_output["final_score"],
        "feedback": final_output["final_feedback"]
    }

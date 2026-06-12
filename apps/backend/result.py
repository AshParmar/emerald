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
    prompt = f"""
    You are an expert technical interviewer. Analyze the following transcript of an interview.
    Evaluate the candidate's technical correctness. Note what concepts they explained well, where they had mistakes,
    and any major knowledge gaps in software engineering or coding.
    
    Transcript:
    {state['transcript_text']}
    
    Provide a concise technical evaluation summary.
    """
    response = llm.invoke(prompt)
    return {
        "technical_feedback": response.content
    }

# --- Node 2: Communication Skills Evaluation ---
def evaluate_communication_skills(state: GradingState) -> dict:
    llm = get_llm()
    prompt = f"""
    You are an expert evaluator. Analyze the following transcript of an interview.
    Evaluate the candidate's communication skills. Note their explanation structure, clarity, 
    confidence, and whether they answered questions directly or beat around the bush.
    
    Transcript:
    {state['transcript_text']}
    
    Provide a concise communication evaluation summary.
    """
    response = llm.invoke(prompt)
    return {
        "communication_feedback": response.content
    }

# --- Node 3: Final Grading Compiler (Structured Output) ---
def compile_final_result(state: GradingState) -> dict:
    llm = get_llm()
    # Enforce Pydantic structured output
    structured_llm = llm.with_structured_output(FinalGrade)
    
    prompt = f"""
    You are a final panel evaluator. Compile the following technical and communication evaluation notes into a final score (0 to 10)
    and a cohesive summary of feedback for the candidate.
    
    Transcript:
    {state['transcript_text']}
    
    Technical Notes:
    {state['technical_feedback']}
    
    Communication Notes:
    {state['communication_feedback']}
    
    Provide the output matching the requested schema.
    """
    result: FinalGrade = structured_llm.invoke(prompt)
    return {
        "final_score": result.score,
        "final_feedback": result.feedback
    }

# 3. Construct the LangGraph State Graph
workflow = StateGraph(GradingState)

# Add our evaluation steps as nodes
workflow.add_node("tech_eval", evaluate_technical_correctness)
workflow.add_node("comm_eval", evaluate_communication_skills)
workflow.add_node("compiler", compile_final_result)

# Connect the nodes with directional edges
workflow.add_edge(START, "tech_eval")
workflow.add_edge("tech_eval", "comm_eval")
workflow.add_edge("comm_eval", "compiler")
workflow.add_edge("compiler", END)

# Compile the workflow graph
grading_graph = workflow.compile()

# --- External facing function ---
def calculate_result(messages) -> dict:
    """Formats messages from DB, runs them through the LangGraph, and returns the score and feedback."""
    formatted_transcript = ""
    for msg in messages:
        sender = msg.type.value if hasattr(msg.type, "value") else str(msg.type)
        content = msg.message
        formatted_transcript += f"{sender}: {content}\n"
    
    # Run the graph
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

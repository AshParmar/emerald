import io
from pypdf import PdfReader
from langchain_google_genai import ChatGoogleGenerativeAI
from pydantic import BaseModel, Field
from config import settings

# 1. Define the structure we want Gemini to return
class ExtractedProfile(BaseModel):
    name: str = Field(description="The full name of the candidate")
    skills: list[str] = Field(description="List of key technical skills, programming languages, and frameworks")
    github_url: str = Field(description="GitHub profile URL if found in the resume, otherwise an empty string")
    linkedin_url: str = Field(description="LinkedIn profile URL if found in the resume, otherwise an empty string")
    summary: str = Field(description="A brief 2-3 sentence summary of the candidate's professional background")

# 2. Extract plain text from PDF bytes
def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    pdf_file = io.BytesIO(pdf_bytes)
    reader = PdfReader(pdf_file)
    text = ""
    for page in reader.pages:
        page_text = page.extract_text()
        if page_text:
            text += page_text + "\n"
    return text

import os
from google import genai
from google.genai import types
import json

# 3. Use google-genai SDK's structured output capability to parse the resume
def parse_resume_with_gemini(resume_text: str) -> dict:
    # Initialize Vertex AI client
    client = genai.Client(
        vertexai=True,
        project=os.environ.get("GOOGLE_CLOUD_PROJECT", "gen-lang-client-0120163642"),
        location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
    )
    
    prompt = f"""
    You are an expert resume parsing AI. Analyze the following resume text and extract the candidate's profile.
    Locate their name, skills, and any URLs linking to GitHub or LinkedIn.
    
    Resume Text:
    {resume_text}
    """
    
    # Run the model with structured JSON output matching the Pydantic schema
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ExtractedProfile,
            temperature=0,
        )
    )
    
    # The response is guaranteed to be a JSON string matching ExtractedProfile
    return json.loads(response.text)

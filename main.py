import os
import json
import wave 
import io
import uuid
import tempfile
import edge_tts
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from groq import Groq


# =========================================================
# 1. CONFIGURATION
# =========================================================

BASE_DIR = Path(__file__).resolve().parent

HISTORY_FILE = BASE_DIR / "chat_history.json"
BACKUP_FILE = BASE_DIR / "chat_history_backup.json"

load_dotenv(BASE_DIR / ".env")

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

CHAT_MODEL = "openai/gpt-oss-20b"
STT_MODEL = "whisper-large-v3-turbo"

# Edge TTS configuration
TTS_MODEL = "edge-tts"
TTS_VOICE = "en-US-AriaNeural"

MAX_CONTEXT_MESSAGES = 20
MAX_UPLOAD_SIZE = 25 * 1024 * 1024

SYSTEM_PROMPT = """
You are Second Voice, a friendly and helpful AI voice assistant.

YOUR RESPONSIBILITIES:

1. Understand the user's intended meaning, even when their English
   grammar, pronunciation, or sentence structure is incorrect.

2. If the user's sentence contains grammatical mistakes, gently
   provide a corrected version when appropriate.

3. If the user's sentence is incomplete, infer the likely meaning
   when possible and help complete it.

4. Answer the user's actual question after providing a correction
   when appropriate.

5. If the user asks how to express something in English, provide
   a natural and commonly used English sentence.

6. Use simple English and concise explanations.

7. Do not unnecessarily correct sentences that are already correct.

8. If the user's meaning is unclear, ask a short clarifying question.

9. Be friendly, patient, and supportive.

10. Use available conversation history to answer follow-up questions.

11. Never claim to remember information that is not available.

12. Answer general questions normally. Do not turn every conversation
    into an English lesson.

13. When speaking, make your answers natural and conversational.

14. Avoid unnecessary headings, markdown tables, and long lists
    unless the user asks for them.

15. Answer the user's actual question directly.
"""


# =========================================================
# 2. FASTAPI APPLICATION
# =========================================================

app = FastAPI(
    title="Second Voice AI",
    description=(
        "AI voice and text assistant with conversation history, "
        "speech-to-text, and text-to-speech."
    ),
    version="2.0.0",
)


# =========================================================
# 3. CORS CONFIGURATION
# =========================================================

# =========================================================
# 3. CORS CONFIGURATION
# =========================================================

ALLOWED_ORIGINS = [
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://127.0.0.1:5501",
    "http://localhost:5501",

    # Add your actual Vercel frontend URL here.
    "https://second-voice-ai.vercel.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =========================================================
# 4. THREAD-SAFE LOCKS AND CONVERSATION CONTEXTS
# =========================================================

history_lock = RLock()
contexts_lock = RLock()

conversation_contexts = {}


# =========================================================
# 5. GROQ CLIENT
# =========================================================

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


def get_groq_client():
    """
    Return the Groq client or raise an error if the API key
    has not been configured.
    """

    if client is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "GROQ_API_KEY is missing. "
                "Add it to your .env file and restart the server."
            ),
        )

    return client


# =========================================================
# 6. CHAT HISTORY FUNCTIONS
# =========================================================

def read_history():
    """
    Read the saved conversation history from the JSON file.
    """

    with history_lock:
        if not HISTORY_FILE.exists():
            return []

        try:
            with HISTORY_FILE.open(
                "r",
                encoding="utf-8",
            ) as file:
                data = json.load(file)

            if not isinstance(data, list):
                raise HTTPException(
                    status_code=500,
                    detail="Chat history must contain a JSON list.",
                )

            return data

        except json.JSONDecodeError as error:
            raise HTTPException(
                status_code=500,
                detail=(
                    "Chat history contains invalid JSON. "
                    "Check chat_history.json."
                ),
            ) from error

        except OSError as error:
            raise HTTPException(
                status_code=500,
                detail=f"Could not read chat history: {error}",
            ) from error


def write_history(history):
    """
    Save conversation history safely using a temporary file.
    """

    with history_lock:
        temp_path = None

        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                suffix=".tmp",
                prefix="history_",
                dir=BASE_DIR,
                delete=False,
            ) as temp_file:

                json.dump(
                    history,
                    temp_file,
                    indent=4,
                    ensure_ascii=False,
                )

                temp_path = temp_file.name

            os.replace(
                temp_path,
                HISTORY_FILE,
            )

        except OSError as error:

            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass

            raise HTTPException(
                status_code=500,
                detail=f"Unable to save chat history: {error}",
            ) from error


def save_conversation(
    conversation_id: str,
    user_message: str,
    assistant_reply: str,
):
    """
    Save one user message and its corresponding AI response.
    """

    entry = {
        "id": str(uuid.uuid4()),
        "conversation_id": conversation_id,
        "timestamp": datetime.now().isoformat(
            timespec="seconds"
        ),
        "user_message": user_message,
        "assistant_reply": assistant_reply,
    }

    with history_lock:
        history = read_history()
        history.append(entry)
        write_history(history)

    return entry


def get_conversation_history(conversation_id: str):
    """
    Return messages belonging to one conversation.
    """

    history = read_history()

    return [
        item
        for item in history
        if item.get("conversation_id") == conversation_id
    ]


# =========================================================
# 7. CONVERSATION CONTEXT FUNCTIONS
# =========================================================

def get_context(conversation_id: str):
    """
    Get the context list for a conversation.
    """

    with contexts_lock:

        if conversation_id not in conversation_contexts:
            conversation_contexts[conversation_id] = []

        return conversation_contexts[conversation_id]


def build_messages(
    conversation_id: str,
    user_message: str,
):
    """
    Build the messages sent to the Groq chat model.
    """

    context = get_context(conversation_id)

    messages = [
        {
            "role": "system",
            "content": SYSTEM_PROMPT,
        }
    ]

    messages.extend(
        context[-MAX_CONTEXT_MESSAGES:]
    )

    messages.append(
        {
            "role": "user",
            "content": user_message,
        }
    )

    return messages


def update_context(
    conversation_id: str,
    user_message: str,
    assistant_reply: str,
):
    """
    Store the latest user and assistant messages in memory.
    """

    with contexts_lock:

        if conversation_id not in conversation_contexts:
            conversation_contexts[conversation_id] = []

        context = conversation_contexts[conversation_id]

        context.extend(
            [
                {
                    "role": "user",
                    "content": user_message,
                },
                {
                    "role": "assistant",
                    "content": assistant_reply,
                },
            ]
        )

        conversation_contexts[conversation_id] = (
            context[-MAX_CONTEXT_MESSAGES:]
        )


def load_context_from_history(conversation_id: str):
    """
    Restore conversation context from saved history after
    the server restarts.
    """

    history = get_conversation_history(conversation_id)

    context = []

    for entry in history:

        user_message = entry.get("user_message", "")
        assistant_reply = entry.get("assistant_reply", "")

        if user_message:
            context.append(
                {
                    "role": "user",
                    "content": user_message,
                }
            )

        if assistant_reply:
            context.append(
                {
                    "role": "assistant",
                    "content": assistant_reply,
                }
            )

    with contexts_lock:
        conversation_contexts[conversation_id] = (
            context[-MAX_CONTEXT_MESSAGES:]
        )


# =========================================================
# 8. REQUEST MODELS
# =========================================================

class ChatRequest(BaseModel):

    conversation_id: Optional[str] = None

    message: str = Field(
        ...,
        min_length=1,
        max_length=20000,
    )


class SpeakRequest(BaseModel):

    text: str = Field(
        ...,
        min_length=1,
        max_length=10000,
    )


# =========================================================
# 9. ROOT ENDPOINT
# =========================================================

@app.get("/")
def root():

    return {
        "success": True,
        "message": "Second Voice AI backend is running.",
        "docs": "/docs",
        "health": "/api/health",
    }


# =========================================================
# 10. HEALTH CHECK
# =========================================================

@app.get("/api/health")
def health_check():

    return {
        "success": True,
        "status": "online",
        "service": "Second Voice AI",
        "api_key_configured": bool(GROQ_API_KEY),
        "chat_model": CHAT_MODEL,
        "stt_model": STT_MODEL,
        "tts_model": TTS_MODEL,
    }


# =========================================================
# 11. CREATE NEW CHAT
# =========================================================

@app.post("/api/new-chat")
def create_new_chat():

    conversation_id = str(uuid.uuid4())

    with contexts_lock:
        conversation_contexts[conversation_id] = []

    return {
        "success": True,
        "conversation_id": conversation_id,
        "message": "New conversation created.",
    }


# =========================================================
# 12. CHAT ENDPOINT
# =========================================================

@app.post("/api/chat")
def chat(request: ChatRequest):

    groq_client = get_groq_client()

    user_message = request.message.strip()

    if not user_message:
        raise HTTPException(
            status_code=400,
            detail="Message cannot be empty.",
        )

    conversation_id = (
        request.conversation_id or str(uuid.uuid4())
    )

    with contexts_lock:
        context_exists = (
            conversation_id in conversation_contexts
        )

    if not context_exists:
        load_context_from_history(conversation_id)

    messages = build_messages(
        conversation_id,
        user_message,
    )

    try:

        response = groq_client.chat.completions.create(
            model=CHAT_MODEL,
            messages=messages,
            temperature=0.7,
            max_completion_tokens=2048,
        )

        assistant_reply = (
            response.choices[0].message.content or ""
        ).strip()

        if not assistant_reply:
            assistant_reply = (
                "I couldn't generate a response. Please try again."
            )

    except Exception as error:

        print(f"Groq chat error: {error}")

        raise HTTPException(
            status_code=502,
            detail=(
                "The AI service could not generate a response. "
                "Check your Groq API access and model availability."
            ),
        ) from error

    try:

        entry = save_conversation(
            conversation_id,
            user_message,
            assistant_reply,
        )

    except HTTPException:
        raise

    except Exception as error:

        print(f"Conversation save error: {error}")

        raise HTTPException(
            status_code=500,
            detail="The response was generated but could not be saved.",
        ) from error

    update_context(
        conversation_id,
        user_message,
        assistant_reply,
    )

    return {
        "success": True,
        "conversation_id": conversation_id,
        "user_message": user_message,
        "reply": assistant_reply,
        "entry": entry,
    }


# =========================================================
# 13. GET CHAT HISTORY
# =========================================================

@app.get("/api/history")
def get_history():

    history = read_history()

    return {
        "success": True,
        "count": len(history),
        "history": history,
    }


# =========================================================
# 14. CLEAR CHAT HISTORY
# =========================================================

@app.delete("/api/history")
def clear_history():

    with history_lock:

        history = read_history()

        if history:

            try:
                with BACKUP_FILE.open(
                    "w",
                    encoding="utf-8",
                ) as backup:

                    json.dump(
                        history,
                        backup,
                        indent=4,
                        ensure_ascii=False,
                    )

            except OSError as error:

                raise HTTPException(
                    status_code=500,
                    detail=(
                        "Could not create history backup: "
                        f"{error}"
                    ),
                ) from error

        write_history([])

    with contexts_lock:
        conversation_contexts.clear()

    return {
        "success": True,
        "message": "Chat history cleared successfully.",
        "backup_created": bool(history),
        "backup_file": (
            BACKUP_FILE.name if history else None
        ),
    }


# =========================================================
# 15. SPEECH-TO-TEXT
# =========================================================

async def transcribe_audio_file(file: UploadFile):

    groq_client = get_groq_client()

    allowed_extensions = {
        ".wav",
        ".mp3",
        ".mp4",
        ".mpeg",
        ".mpga",
        ".m4a",
        ".ogg",
        ".webm",
        ".flac",
    }

    filename = file.filename or "recording.webm"

    extension = Path(filename).suffix.lower()

    if extension not in allowed_extensions:

        await file.close()

        raise HTTPException(
            status_code=400,
            detail=(
                "Unsupported audio format: "
                f"{extension or 'unknown'}."
            ),
        )

    temp_path = None

    try:

        audio_data = await file.read(
            MAX_UPLOAD_SIZE + 1
        )

        if not audio_data:
            raise HTTPException(
                status_code=400,
                detail="The uploaded audio file is empty.",
            )

        if len(audio_data) > MAX_UPLOAD_SIZE:
            raise HTTPException(
                status_code=413,
                detail="Audio file exceeds the 25 MB limit.",
            )

        with tempfile.NamedTemporaryFile(
            suffix=extension,
            delete=False,
        ) as temp_file:

            temp_file.write(audio_data)
            temp_path = temp_file.name

        with open(temp_path, "rb") as audio_file:

            result = (
                groq_client.audio.transcriptions.create(
                    file=(
                        filename,
                        audio_file.read(),
                    ),
                    model=STT_MODEL,
                    response_format="json",
                )
            )

        transcribed_text = (
            getattr(result, "text", "") or ""
        ).strip()

        return {
            "success": True,
            "text": transcribed_text,
        }

    except HTTPException:
        raise

    except Exception as error:

        print(f"Groq transcription error: {error}")

        raise HTTPException(
            status_code=502,
            detail=(
                "Audio transcription failed. Check your Groq API "
                "access and the uploaded audio format."
            ),
        ) from error

    finally:

        await file.close()

        if temp_path and os.path.exists(temp_path):

            try:
                os.remove(temp_path)
            except OSError:
                pass


@app.post("/api/stt")
async def stt_audio(
    file: UploadFile = File(...),
):
    return await transcribe_audio_file(file)


@app.post("/api/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
):
    return await transcribe_audio_file(file)


# =========================================================
# 16. TEXT-TO-SPEECH
# =========================================================

# =========================================================
# 16. TEXT-TO-SPEECH USING EDGE TTS
# =========================================================

@app.post("/api/speak")
async def speak(request: SpeakRequest):
    text = request.text.strip()

    if not text:
        raise HTTPException(
            status_code=400,
            detail="Text cannot be empty."
        )

    try:
        communicate = edge_tts.Communicate(
            text=text,
            voice="en-US-AriaNeural"
        )

        audio_chunks = []

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        audio_content = b"".join(audio_chunks)

        if not audio_content:
            raise HTTPException(
                status_code=502,
                detail="Edge TTS returned empty audio."
            )

        print("Generated audio bytes:", len(audio_content))

        return Response(
            content=audio_content,
            media_type="audio/mpeg",
            headers={
                "Content-Disposition": 'inline; filename="response.mp3"',
                "Cache-Control": "no-store"
            }
        )

    except HTTPException:
        raise

    except Exception as error:
        print("Edge TTS error:", repr(error))

        raise HTTPException(
            status_code=502,
            detail="Speech generation failed."
        ) from error

# =========================================================
# 17. RUN SERVER
# =========================================================

if __name__ == "__main__":

    import uvicorn

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )
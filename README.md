# 🎙️ Second Voice AI

Second Voice AI is a voice-enabled AI assistant that allows users to interact with an AI using both text and voice. It uses FastAPI for the backend, Groq for AI-powered responses and speech transcription, and Edge TTS to convert AI responses into speech.

The goal of this project is to create a personal voice assistant that can listen to the user, understand their questions, generate intelligent responses.

## ✨ Features

- 💬 **AI Chat:** Ask questions and receive AI-generated responses.
- 🎤 **Speech Recognition:** Convert spoken input into text using Groq Whisper.
- 🧠 **AI-Powered Responses:** Generate answers using a Groq-hosted language model.
- 📝 **Chat History:** Store conversations locally in a JSON file.
- 🔄 **Voice Interaction:** Support a voice-based interaction workflow.
- 🌐 **REST API:** Use FastAPI to connect the frontend and backend.
- 🖥️ **Web Interface:** Interact with the assistant through HTML, CSS, and JavaScript.
- ⏹️ **Voice Controls:** Control voice interaction through the frontend.

## 🛠️ Tech Stack

### Frontend
- HTML5
- CSS
- JavaScript

### Backend
- Python
- FastAPI
- Uvicorn
- Pydantic

### AI and Voice
- Groq API
- Groq Whisper (`whisper-large-v3-turbo`) for speech transcription
- Groq-hosted language model (`openai/gpt-oss-20b`) for AI responses

### Storage
- JSON file for local chat history

## 📁 Project Structure

```text
Second Voice/
│
├── main.py
├── .env
├── requirements.txt
├── chat_history.json
├── chat_history_backup.json
│
└── Frontend/
    ├── index.html
    ├── style.css
    ├── script.js
    │
    └── assets/
        └── logo.svg
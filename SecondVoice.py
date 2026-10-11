from dotenv import load_dotenv
import os
import json
from datetime import datetime
import sounddevice as sd
import soundfile as sf
from groq import Groq
from langchain_groq import ChatGroq
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

load_dotenv()

api_key = os.getenv("GROQ_API_KEY")

if not api_key:
    raise ValueError(
        "GROQ_API_KEY was not found. "
        "Please check your .env file."
    )

client = Groq(api_key=api_key)
llm = ChatGroq(
    model="openai/gpt-oss-20b",
    api_key=api_key
)

DURATION = 5
SAMPLE_RATE = 16000
HISTORY_FILE = "chat_history.json"
MEMORY_LIMIT = 10
MAX_CONTEXT_MESSAGES = 20

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

8. If the user's meaning is unclear, ask a short clarifying question
   rather than making an unsupported guess.

9. Be friendly, patient, and supportive.

10. Use relevant information from the available conversation
    history to answer follow-up questions.

11. Never claim to remember information that is not available
    in the conversation context.

12. Answer general questions normally. Do not turn every conversation
    into an English lesson.

EXAMPLE 1:

User: How I can improve my English?

Assistant: A natural way to say this is, "How can I improve my
English?" You can improve by practising a little every day.

EXAMPLE 2:

User: Yesterday I go to college.

Assistant: You can say, "Yesterday, I went to college."
We use "went" because the action happened in the past.

EXAMPLE 3:

User: What is machine learning?

Assistant: Machine learning is a type of AI that helps computers
learn patterns from data.
"""

chat_history = []

def load_history():
    global chat_history

    if not os.path.exists(HISTORY_FILE):
        chat_history = []
        return

    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as file:
            data = json.load(file)

        if isinstance(data, list):
            chat_history = [
                item
                for item in data
                if isinstance(item, dict)
                and isinstance(item.get("user"), str)
                and isinstance(item.get("assistant"), str)
            ]
        else:
            print("Warning: Chat history format is invalid.")
            chat_history = []

    except (json.JSONDecodeError, OSError) as error:
        print("Warning: Could not load chat history:", error)
        chat_history = []

def save_history():
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as file:
            json.dump(
                chat_history,
                file,
                indent=4,
                ensure_ascii=False
            )
    except OSError as error:
        print("Could not save chat history:", error)

def save_conversation(user_text, assistant_text):
    chat_history.append({
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "user": user_text,
        "assistant": assistant_text
    })
    save_history()

load_history()

messages = [SystemMessage(content=SYSTEM_PROMPT)]

def restore_memory():
    recent_chats = chat_history[-MEMORY_LIMIT:]

    for chat in recent_chats:
        user_text = chat.get("user", "")
        assistant_text = chat.get("assistant", "")

        if user_text and assistant_text:
            messages.append(HumanMessage(content=user_text))
            messages.append(AIMessage(content=assistant_text))

def limit_memory():
    global messages

    system_message = messages[0]
    recent_messages = messages[1:]
    recent_messages = recent_messages[-MAX_CONTEXT_MESSAGES:]

    messages = [system_message] + recent_messages

restore_memory()

def view_history():
    if not chat_history:
        print("\nNo saved conversations found.")
        return

    print("\n" + "=" * 45)
    print("             CHAT HISTORY")
    print("=" * 45)

    for index, chat in enumerate(chat_history, start=1):
        print(f"\nConversation {index}")
        print("Time:", chat.get("timestamp", "Unknown"))
        print("You:", chat.get("user", ""))
        print("Second Voice:", chat.get("assistant", ""))

    print("\n" + "=" * 45)

def clear_history():
    global chat_history, messages

    confirmation = input(
        "\nDelete all saved chat history? (yes/no): "
    ).strip().lower()

    if confirmation == "yes":
        chat_history = []
        messages = [SystemMessage(content=SYSTEM_PROMPT)]
        save_history()
        print("Chat history has been cleared.")
    else:
        print("Chat history was not deleted.")

def speak(text):
    response = client.audio.speech.create(
        model="canopylabs/orpheus-v1-english",
        voice="troy",
        input=text,
        response_format="wav"
    )

    response.write_to_file("response.wav")

    audio, sample_rate = sf.read(
        "response.wav",
        dtype="float32"
    )

    sd.play(audio, sample_rate)
    sd.wait()

def get_voice_input():
    print("\nListening... Speak now.")

    audio_data = sd.rec(
        int(DURATION * SAMPLE_RATE),
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32"
    )

    sd.wait()

    sf.write("recording.wav", audio_data, SAMPLE_RATE)

    print("Transcribing your speech...")

    with open("recording.wav", "rb") as audio_file:
        transcription = client.audio.transcriptions.create(
            file=audio_file,
            model="whisper-large-v3-turbo",
            response_format="json"
        )

    return transcription.text.strip()

def detect_command(user_text):
    command = " ".join(user_text.lower().strip().split())
    command = command.strip(" .,!?:;")

    command_map = {
        "voice": [
            "/voice",
            "switch to voice mode",
            "change to voice mode",
            "start voice mode"
        ],
        "text": [
            "/text",
            "switch to text mode",
            "change to text mode",
            "start text mode"
        ],
        "history": [
            "/history",
            "show chat history",
            "view chat history",
            "show my chat history",
            "show conversation history"
        ],
        "clear_history": [
            "/clearhistory",
            "clear chat history",
            "delete chat history"
        ],
        "bye": [
            "/bye",
            "bye",
            "goodbye",
            "exit assistant",
            "stop assistant",
            "quit assistant"
        ]
    }

    for action, phrases in command_map.items():
        if command in phrases:
            return action

    return None

def get_ai_response(user_text):
    messages.append(HumanMessage(content=user_text))
    print("\nSecond Voice is thinking...")

    try:
        ai_msg = llm.invoke(messages)
        ai_text = ai_msg.content

        if not isinstance(ai_text, str):
            ai_text = str(ai_text)

        messages.append(AIMessage(content=ai_text))
        limit_memory()

        return ai_text

    except Exception:
        if messages and isinstance(messages[-1], HumanMessage):
            messages.pop()
        raise

def end_conversation(voice_mode):
    farewell = "Goodbye! It was nice talking to you."

    print("\nSecond Voice:", farewell)

    if voice_mode:
        try:
            speak(farewell)
        except Exception as error:
            print("Speech generation error:", error)

def run_conversation(start_voice_mode):
    voice_mode = start_voice_mode

    print("\nSecond Voice is ready!")
    print("\nCommands:")
    print("  /voice   - Switch to voice mode")
    print("  /text    - Switch to text mode")
    print("  /history - View saved conversations")
    print("  /clearhistory - Delete saved history")
    print("  /bye     - End the conversation")
    print("\nRecent conversation memory has been loaded.")
    print("You can also say commands while using voice mode.")

    while True:
        try:
            if voice_mode:
                user_text = get_voice_input()
            else:
                user_text = input("\nYou: ").strip()

            if not user_text:
                print("No input detected. Please try again.")
                continue

            print("\nYou:", user_text)

            action = detect_command(user_text)

            if action == "voice":
                voice_mode = True
                print("\nSwitched to Voice Mode.")
                continue

            if action == "text":
                voice_mode = False
                print("\nSwitched to Text Mode.")
                continue

            if action == "history":
                view_history()
                continue

            if action == "clear_history":
                clear_history()
                continue

            if action == "bye":
                end_conversation(voice_mode)
                break

            ai_text = get_ai_response(user_text)
            print("\nSecond Voice:", ai_text)

            if voice_mode:
                try:
                    speak(ai_text)
                except Exception as error:
                    print("\nSpeech generation error:", error)
                    print(
                        "You can continue using voice mode "
                        "or switch to text mode."
                    )

            save_conversation(user_text, ai_text)

            if voice_mode:
                print("\n" + "-" * 40)
                print("1. Continue Voice Mode")
                print("2. Switch to Text Mode")
                print("3. View Chat History")
                print("4. End Conversation")

                choice = input("\nChoose an action: ").strip()

                if choice == "2":
                    voice_mode = False
                    print("\nSwitched to Text Mode.")
                elif choice == "3":
                    view_history()
                elif choice == "4":
                    print("\nEnding conversation.")
                    break
                else:
                    print("\nContinuing Voice Mode...")

        except KeyboardInterrupt:
            print("\nConversation interrupted by user.")
            break

        except Exception as error:
            print("\nAn error occurred:", error)
            print("Please try again.")

    print("\nConversation ended.")
    print("Chat history saved to:", HISTORY_FILE)

def main():
    while True:
        print("\n" + "=" * 40)
        print("          SECOND VOICE AI")
        print("=" * 40)
        print("1. Start Voice Mode")
        print("2. Start Text Mode")
        print("3. View Chat History")
        print("4. Clear Chat History")
        print("5. Exit")

        choice = input("\nChoose an option: ").strip()

        if choice == "1":
            run_conversation(True)
        elif choice == "2":
            run_conversation(False)
        elif choice == "3":
            view_history()
        elif choice == "4":
            clear_history()
        elif choice == "5":
            print("\nThank you for using Second Voice!")
            break
        else:
            print("\nInvalid option. Please choose 1 to 5.")

if __name__ == "__main__":
    main()
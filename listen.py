import sounddevice as sd
import soundfile as sf
from groq import Groq
import os 

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

duration = 5  # seconds
samplerate = 16000  # Hz

print("Recording...")
audio_data = sd.rec(
    int(duration * samplerate), 
    samplerate=samplerate, 
    channels=1, 
    dtype='float32'
    )

sd.wait()  # Wait until recording is finished

sf.write("recording.wav", audio_data, samplerate)
print("processing your voice...")

with open("recording.wav", "rb") as audio_file:
    transcription = client.audio.transcriptions.create(
        file=audio_file,
        model="whisper-large-v3-turbo",
        response_format="json"
    )

print("you said: ", transcription.text)

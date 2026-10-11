import os 
from groq import Groq

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

text = "hello! i am second voice , your persinal ai assistasnt."

response = client.audio.speech.create(
    model="canopylabs/orpheus-v1-english",
    voice="troy",
    input=text,
    response_format="wav"
)

response.write_to_file("response.wav")

print("speech generated successfully!")
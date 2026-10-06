# A small sample project for this repository's own workflow (.github/workflows/check.yml): it calls Cartesia's
# current model, so the check finds the company but nothing being retired, and the step passes.
from cartesia import Cartesia

client = Cartesia()
audio = client.tts.bytes(model_id="sonic-3.6", transcript="Hello from YakBarber.", voice={"mode": "id", "id": "example"})

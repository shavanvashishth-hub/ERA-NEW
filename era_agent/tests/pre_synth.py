import asyncio
import os
import sys
import edge_tts

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from tests.test_100_voice_dataset import DATASET

cache_dir = os.path.join(os.path.dirname(__file__), "benchmark_audio_cache")
os.makedirs(cache_dir, exist_ok=True)

async def synth(item):
    item_id = item["id"]
    wav = os.path.join(cache_dir, f"cmd_{item_id:03d}.wav")
    if not os.path.exists(wav):
        try:
            c = edge_tts.Communicate(item["spoken"], item["voice"])
            await c.save(wav)
        except Exception as e:
            print(f"Error on {item_id}: {e}")

async def main():
    print("Pre-synthesizing all 100 audio files in batches of 15...")
    for k in range(0, len(DATASET), 15):
        chunk = DATASET[k:k+15]
        await asyncio.gather(*(synth(i) for i in chunk))
        print(f"Batch {k} to {min(k+15, len(DATASET))} complete.")
    print("All audio files ready.")

if __name__ == "__main__":
    asyncio.run(main())

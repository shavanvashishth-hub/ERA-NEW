"""Real-recording evaluation. Skipped unless ERA_VOICE_TEST_DATA points at a dataset (see evaluate.py).

Covers spec items 1,2,3,4,5,6,7,8 with GENUINE recordings; nothing is simulated here.
"""
import os
import pytest

DATA = os.environ.get("ERA_VOICE_TEST_DATA")
pytestmark = pytest.mark.skipif(not DATA, reason="set ERA_VOICE_TEST_DATA to a recordings folder")


def test_dataset_report_is_produced():
    from era_voice_identity.evaluate import evaluate
    rep = evaluate(DATA)
    assert "error" not in rep, rep
    print(rep)
    assert rep["genuine"] or rep["impostor"]

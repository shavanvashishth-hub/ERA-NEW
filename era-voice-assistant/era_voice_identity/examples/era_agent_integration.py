"""How ERA's existing Python local agent can consume voice-verification results.

Nothing here modifies ERA. Copy VoiceGuard into the agent (or import era_voice_identity as a package).
Run the demo:  python -m era_voice_identity.examples.era_agent_integration
"""
from __future__ import annotations

import logging
from typing import Callable, Dict

from era_voice_identity import Config, SecurityGate, Sensitivity, VoiceIdentityEngine

log = logging.getLogger("era.agent.voice")

# Map each local-agent command to how much identity it needs.
COMMAND_POLICY: Dict[str, Sensitivity] = {
    "get_time": Sensitivity.PUBLIC,
    "open_notepad": Sensitivity.OWNER_VOICE,
    "open_chrome": Sensitivity.OWNER_VOICE,
    "search_files": Sensitivity.OWNER_VOICE,
    "send_whatsapp": Sensitivity.SENSITIVE,
    "shutdown": Sensitivity.SENSITIVE,
    "restart": Sensitivity.SENSITIVE,
}


class VoiceGuard:
    """Keep ONE instance in the agent process."""

    def __init__(self, liveness: Callable[[], bool] | None = None,
                 second_factor: Callable[[], bool] | None = None):
        self.engine = VoiceIdentityEngine(Config())
        self.gate = SecurityGate(self.engine.cfg, liveness, second_factor)
        self.engine.initialize()

    def start(self):
        return self.engine.start_monitoring()      # keeps engine.last_result fresh

    def check(self, command: str) -> dict:
        policy = COMMAND_POLICY.get(command, Sensitivity.SENSITIVE)   # unknown command => strictest
        d = self.gate.authorize(policy, self.engine.last_result)
        return {"allowed": d.allowed, "reason": d.reason, "needs": d.needs}


def execute(agent_commands: Dict[str, Callable[[], object]], guard: VoiceGuard, command: str):
    """Wrap wherever the agent dispatches a command (e.g. the /execute handler)."""
    verdict = guard.check(command)
    if not verdict["allowed"]:
        return {"status": "denied", **verdict}          # fail closed
    return {"status": "ok", "result": agent_commands[command]()}


# FastAPI sketch (if the agent is FastAPI):
#   guard = VoiceGuard(liveness=my_challenge, second_factor=my_pin_prompt); guard.start()
#   @app.post("/execute")
#   def run(req: ExecuteRequest):
#       return execute(COMMANDS, guard, req.command)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    g = VoiceGuard()
    cmds = {"open_notepad": lambda: "notepad opened", "shutdown": lambda: "shutting down"}
    print(execute(cmds, g, "open_notepad"))
    print(execute(cmds, g, "shutdown"))

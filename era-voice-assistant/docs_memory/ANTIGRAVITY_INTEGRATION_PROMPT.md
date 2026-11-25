# Prompt for Antigravity: integrate ERA_HUMAN_MEMORY_ENGINE into ERA

You are integrating an existing, tested, standalone package (`ERA_HUMAN_MEMORY_ENGINE/era_memory`) into my ERA
desktop assistant. Work incrementally and keep ERA working at every step. Do NOT rewrite the memory engine.

## Hard rules
1. Do not modify or replace existing working ERA modules except the minimum hook lines in step 5. Show a diff
   before each edit to existing files and ask me before touching anything outside the files named below.
2. Do not invent ERA APIs: read the real code and reuse its real names, routes and config style.
3. Do not add dependencies. The engine is standard-library only. numpy / sentence-transformers are optional.
4. All memory data stays local. No telemetry, no cloud embeddings, no logging of memory text.
5. Memory output is context only. ERA's existing permission/confirmation flow must stay in control of actions.
6. Work on a git branch (or copy) so I can revert. Do not delete or migrate existing chat history without asking.

## Steps
1. **Inspect.** List ERA's folders. Report: language/runtime of the local agent, how the voice assistant, Mission
   Engine, Bridge, Vision system, desktop UI and autonomous agent communicate, where the reasoning/LLM call is made,
   where user transcripts and assistant replies pass through, existing routes/ports, existing storage and config
   conventions, and any existing "memory" code. Write the findings to `MEMORY_INTEGRATION_FINDINGS.md`. Stop and
   show me before continuing.
2. **Install the package.** Copy `era_memory/` (not tests) into ERA at a location that matches its structure, or
   add it to the Python path. Add a config entry for the storage directory using ERA's config convention
   (default: engine's per-user directory; never an absolute path).
3. **Run the engine's tests** from the package folder: `cd tests && python -m unittest discover -v`. All must pass
   on my machine before proceeding. Report failures; do not skip them.
4. **Create ONE adapter** `era_memory_adapter.py` in ERA exposing: `get_engine()` (lazy singleton, closed on app
   shutdown), `context_for(user_text, session_id, project_id=None) -> str` and
   `remember_turn(user_text, assistant_text, session_id, project_id=None)`. All calls must be wrapped so that a
   memory failure logs the error class only and ERA continues without memory (never crashes the voice loop).
   Run memory calls off the real-time voice path (thread or executor) and give `context_for` a ~250 ms budget
   fallback to "no context" if exceeded.
5. **Hook the reasoning layer** (minimum edits): before the model call, prepend `context_for(...)` output to the
   prompt as clearly delimited background data; after the turn completes, call `remember_turn(...)` with FINAL
   transcripts only. Pass a stable `session_id` per conversation. Add `idempotency_key` if the same transcript can
   be delivered twice.
6. **Optional HTTP.** Only if another ERA process (Bridge/UI) needs memory: run `python -m era_memory serve` with a
   non-conflicting port and prefix, loopback only, token auth on. Do not expose it beyond localhost.
7. **Tasks and procedures (optional, ask me first).** Surface `get_pending_tasks()` in the UI/voice summary and call
   `record_procedure(...)` when the Mission Engine finishes or fails a mission.
8. **Verify.** (a) Tell ERA "my name is X and I'm building a project called ERA", restart ERA and the PC if possible,
   ask "what am I building?" with the internet off; (b) say something in session 1 and refer to it with "that
   project" in session 2; (c) correct a fact ("I moved to Delhi") and confirm the old one is kept in history via
   `get_memory_versions`; (d) `python -m era_memory health` returns status ok; (e) take and restore a backup;
   (f) confirm voice latency, vision, Mission Engine, Bridge and UI behave exactly as before; (g) grep logs to
   confirm no memory text appears.
9. **Report** every file changed, every new file, how to roll back, and anything you could not verify.

## Acceptance criteria
Existing features unchanged; memories survive restart/offline; related memories are retrieved across sessions;
backup/restore works; no network access by the memory code; no memory content in logs; rollback documented.

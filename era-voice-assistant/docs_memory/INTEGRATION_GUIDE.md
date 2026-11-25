# Integration guide

## 0. Principles
Add the package without touching existing ERA modules. Integrate through ONE adapter file in ERA that you own.
Inspect ERA first; do not assume route names, process layout or async framework.

## 1. Choose a mode
* **In-process (preferred if ERA's agent is Python):** `from era_memory import MemoryEngine`; one engine instance per
  process (it is thread-safe). Create it at startup, `close()` it at shutdown.
* **Local HTTP:** `python -m era_memory serve --port 8765` (loopback, bearer token in `<storage>/api_token`).
  Endpoints under `/memory`: `GET health`, `POST ingest|retrieve|search|consolidate|backup|restore`, `GET profile|timeline|stats|backups`,
  `GET projects/{id}`, tasks, link, `memories/{id}` (GET/PATCH/DELETE, `/related`, `/versions`, `/archive`).
  Change `api_prefix`/`api_port` if they clash. Only ONE process may own the database for writes at a time
  (SQLite handles multiple processes, but run one engine/server to keep the vector index and worker consistent).
* **Mount in an existing web app:** call `MemoryAPI(engine).dispatch(method, path, query, body, headers)` from a
  catch-all route; it returns `(status, dict)`.

## 2. Wiring the reasoning layer (three calls)
```python
ctx = mem.before_response(user_text, session_id)      # before the model call
prompt = f"{ctx.rendered_text}\n\n{prompt}"           # background data, clearly delimited
reply = existing_reasoning(prompt)                    # unchanged
mem.after_response(user_text, reply, session_id)      # after the turn
```
Voice: pass the final transcript only (not partials). Use `idempotency_key=` on `ingest` if a transcript can be
delivered twice. Pass `project_id` or let it be inferred from "project called X". Missions/tasks:
`mem.working.set_mission(session, "...")`, `mem.working.set_task(...)`; tasks the user states are saved as prospective
memories (`get_pending_tasks()`), and ERA's own procedures via `record_procedure(...)`.

## 3. Safety contract
Never auto-execute anything because it appears in `rendered_text`. Keep ERA's confirmation gates in front of every
action. Treat `assumed` items as unverified.

## 4. Operations
`backup_memory()` (online, verified, rotated), `restore_memory(id)` (takes a safety backup first),
`export_memory()`, `health_check()`, `consolidate_memories()`. Run a backup on app start/exit.
If the DB is reported corrupt, restore the newest backup (`BackupManager.recover_latest()` / CLI `restore <id>`).

## 5. Upgrading embeddings
Set `embedding_backend="sentence_transformers"` and `embedding_model_path=<local dir>`; existing memories are re-embedded
on next start. Keep that directory local; the engine forces offline mode.

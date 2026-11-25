# ERA Human-Inspired Persistent Memory Engine

A fully local, offline memory engine for the ERA desktop assistant. Python 3.9+ standard library only
(SQLite with WAL + FTS5). Nothing is uploaded, no network calls are made, no API keys are needed.

## What it does
| Layer | Stored as | Examples |
|---|---|---|
| Episodic | `type=episodic` | conversations, decisions, outcomes (timestamped, sourced) |
| Semantic | `type=semantic` | user facts, preferences, project knowledge, entity digests |
| Associative | `links`, `entities`, `entity_relations` | shared-entity, similarity, topic, project, temporal links; multi-hop retrieval |
| Working | in RAM (`working_memory.py`) | current session entities, task, mission, recent retrievals |
| Procedural | `type=procedural` | how tasks were done, failures to avoid, recoveries |
| Prospective | `type=prospective` | pending tasks, deadlines, follow-ups |
| Importance | flags + scores | highly_important, personally_meaningful, repeated, temporary, project_critical, time_sensitive (heuristic, with confidence; not emotion detection) |

Facts that change (e.g. location) are **superseded, not overwritten**: the old value stays with `valid_to`, a
`supersedes` link and version history. Duplicates are merged into the older memory and archived with provenance.

## Quick start
```python
from era_memory import MemoryEngine, MemoryConfig
mem = MemoryEngine(MemoryConfig(storage_dir="./era_memory_data"))     # default dir is per-user, see below
ctx = mem.before_response("Let's improve ERA's intelligence", session_id="s1")   # retrieve first
# ... ERA answers using ctx.rendered_text as background data ...
mem.after_response(user_text, assistant_text, session_id="s1")                    # then store durably
mem.close()
```
Run `python examples/example_integration.py`, tests with `cd tests && python -m unittest discover -v`,
CLI with `python -m era_memory health|stats|backup|serve`.

Storage directory: `ERA_MEMORY_DIR`, else `%LOCALAPPDATA%\ERA\memory` (Windows) or `~/.local/share/era/memory`.
All options are in `MemoryConfig` (env override: `ERA_MEMORY_<FIELD>`).

## Honest limitations
* The default embedder is a **local hashing embedder**: it matches words, word pairs and word shapes, not deep
  paraphrase meaning. For true semantic similarity point `embedding_backend="sentence_transformers"` at a model
  directory already on disk (never downloaded by this package). Existing memories are re-embedded automatically.
* Fact/decision/task extraction is rule-based (transparent, offline, English-centric). It misses unusual phrasing.
  Plug a local LLM in via `llm_extractor=` to improve it; the rest of the pipeline is unchanged.
* The database is **not encrypted at rest** (stdlib has no cipher). Use OS disk encryption (BitLocker) or SQLCipher.
  Files are created owner-only on POSIX. Backups and exports contain plain memory text.
* Purging a memory removes it from the live DB and WAL, but older backups still contain it until rotated or deleted.
* Vector search is exact and in-process: comfortable to ~100k memories; beyond that swap in an ANN index.
* Tested on Linux/Python 3.12 only. Windows paths use `pathlib`, but run the tests on your PC before relying on it.
* ERA's own source was not available, so no ERA API names are assumed; see INTEGRATION_GUIDE.md.

## Layout
`era_memory/`: memory_engine, memory_database, memory_models, memory_extractor, memory_retriever, memory_consolidator,
associative_memory, memory_api, memory_config, memory_security, memory_backup, plus memory_text, memory_embeddings,
working_memory. Docs: ARCHITECTURE.md, INTEGRATION_GUIDE.md, ANTIGRAVITY_INTEGRATION_PROMPT.md.

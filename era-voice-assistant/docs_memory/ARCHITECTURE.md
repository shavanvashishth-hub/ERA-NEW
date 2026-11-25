# Architecture

## Lifecycle
Capture → Normalize → Extract → Validate → **Store (durable commit)** → Connect → Consolidate → Retrieve → Reason (ERA) → Verify → Update.

`ingest()` does everything up to Store inside ONE SQLite transaction (`BEGIN IMMEDIATE`, WAL, `synchronous=FULL`):
episodic row, derived semantic/prospective/procedural rows, entities, `derived_from` links, entity relations and a
durable job row (transactional outbox). Only after commit is the row count read back; `persisted_verified=True`
is returned only then. Connect/Consolidate run from the `jobs` table in a background thread; jobs interrupted by a
crash are re-queued at startup, failures retry up to `job_max_attempts` and are visible in `health_check()`.

## Storage (SQLite, schema v2, `PRAGMA user_version` migrations)
`memories` (+ FTS5 external-content index via triggers, `rid` integer key so VACUUM is safe), `memory_versions`
(every prior state), `entities`, `memory_entities`, `links` (typed, weighted), `entity_relations` (knowledge graph:
co-occurrence + typed triples like `ERA uses Gemini`), `jobs`, `audit_log` (ids only, never content), `meta`.
Migrations run in a transaction, take a `pre_migration_vN` backup first, and refuse databases newer than the code.

## Retrieval
1. Analyze query: intent, entities (including known lowercase mentions and working-memory references like "it"),
   time window ("yesterday", "last week"), history intent ("used to").
2. Candidates: FTS5 BM25, vector similarity, entity hits, entity-graph hop, time window, then spreading activation
   (multi-hop) from the strongest seeds.
3. Score = weighted sum of fts, vector, entity, graph, temporal (relevance, must clear a floor) + importance,
   recency (half-life), confidence. Weights are in `MemoryConfig.weights`.
4. Pack into a token budget: near-duplicate suppression, sections (profile, memories, tasks, lessons, history,
   relationships), explicit confirmed/assumed labels, ids for provenance.
5. Output is wrapped in delimiters and labelled as DATA; delimiter look-alikes inside memories are neutralised.

## Consolidation
Per new memory: restated fact → merged into older memory (mention count, confidence, confirmed upgrade);
changed single-valued fact → old one superseded (kept); retraction ("I no longer use X") → matching facts superseded;
near-duplicates (hash or vector) merged. Periodic pass: entity digests (versioned), importance recalibration,
archival of stale low-value never-recalled memories. Nothing is deleted except by explicit purge.

## Privacy and safety
Local only (`offline_guard` test proves no outbound sockets), secrets/cards redacted before storage, "don't remember
this" honoured, logs carry ids/counts only, API binds to loopback, bearer token, Host-header check (DNS rebinding),
restore confined to the backup directory and requires confirmation. The engine only returns context; it never
executes actions, so ERA's permission/confirmation systems stay in control.

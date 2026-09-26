# Plan 12: Call Copilot + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a scripted mock sales call, the audience watches a live overlay surface the right product fact, proof point, or discovery question within a couple seconds of a trigger (a question, a competitor name, an objection, a technical term) while the diagram animates transcript flowing from audio through streaming ASR, a trigger detector, TiDB hybrid retrieval, and a streaming Claude suggestion; after the call a summary and follow-up draft land back in TiDB. It proves TiDB as the real-time retrieval memory (vector + full-text hybrid search) behind an agent-assist tool, not just a vector store demo.

**Architecture:** A runner captures call audio (system + mic, via a virtual loopback device), streams it to a hosted ASR websocket, folds transcript turns into a rolling window, runs a pure trigger detector over each new turn, issues two parallel SQL queries against TiDB (`VEC_COSINE_DISTANCE` vector search and `FTS_MATCH_WORD` full-text search) fused with a hand-rolled Reciprocal Rank Fusion function, assembles a prompt from the fused top facts, and streams a suggestion from Claude Haiku. All of this emits `lab` events (`metric`, `flow`, `node`, `phase`, `check`, `log`) alongside the copilot's own suggestion-card UI, so the same run drives both the SE-facing overlay and the platform's diagram/metrics UI. After the call, Claude Sonnet writes a summary and follow-up draft back into TiDB.

**Tech Stack:** TypeScript (strict, Node 22), `@lab/runner-kit` + `mysql2`, AssemblyAI streaming WebSocket client, Anthropic TypeScript SDK (streaming), BlackHole (virtual audio loopback) + `sox` for audio capture, `macOS say` for synthetic mock-call audio generation, pnpm.

**Depends on:** Plan 00 (platform).

---

## 1. Why this demo

- **The question customers ask:** "Our SEs and AEs are on video calls all day - can an agent listen in and surface the right fact or proof point live, the way a human sales engineer whispers in a teammate's ear?"
- **Pattern:** sales engineers and account executives who want real-time help on live calls: the right product fact, proof point, or discovery question at the right moment.
- **What TiDB proves here:**
  - A single TiDB table serves both the vector query and the full-text query that feed one retrieval turn, with no second search system.
  - Hybrid fusion (vector + full-text, RRF) is measurably better than either alone on a labeled eval set of scripted triggers, tracked as one of this demo's checks.
  - Retrieval and the whole suggestion path are fast enough to happen inside a live call: the plan tracks p50/p99 for vector, full-text, and hybrid retrieval separately, plus end-to-end suggestion latency, all against measured targets.
  - The same TiDB store holds the knowledge base (facts, proof points, objection answers, past call notes) and the call history (summaries, follow-ups) - one database, not a vector DB plus a separate CRM store.
- **What this demo does not claim:** it does not claim production-grade turn detection or ASR accuracy (that's the vendor's job, not TiDB's); it does not claim the suggestion quality is better than a human SE; it does not process real customer audio - the featured trace is a scripted, synthetic two-person dialogue.

## 2. What the audience sees

### Flow diagram

```
 [mic]          [asr]                                    [claude-suggest]   [overlay]
(source)  --->  (service)  ---> [trigger]  --->  [tidb]  --->  (service)  --->  (client)
 x=8,y=20        x=24,y=20      (service)         (tidb)        x=68,y=18       x=90,y=18
                                 x=24,y=50        x=50,y=35            \
                                                                        \--->  [claude-summary]  --->  [store]
                                                                                (service) x=68,y=65     (sink) x=90,y=65
```

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 0 | consent | Consent | Runner logs the recorded consent statement before any capture starts; the `consent-given` check turns green. | "Before anything is captured, the copilot announces recording and waits for consent - that gate is not optional." |
| 1 | discovery | Discovery | The mock call's opening turns run through ASR with no triggers yet; the diagram shows plain transcript flow. | "The SE and prospect are just talking. Nothing fires until the copilot recognizes something worth surfacing." |
| 2 | question-trigger | Discovery question asked | The prospect asks a direct product question; the trigger detector fires `question`, hybrid retrieval and a Claude Haiku suggestion follow. | "A direct question just fired the trigger. Watch the suggestion card - TiDB found the fact, Claude worded it, in about a second." |
| 3 | competitor-trigger | Competitor named | The prospect names a competing database; the trigger detector fires `competitor`, retrieval switches to competitive-positioning facts. | "The moment a competitor's name is said, the retrieval scope shifts to battlecard content automatically." |
| 4 | objection-trigger | Objection raised | The `inject-objection` control (or the script) raises a cost/complexity objection; the trigger fires `objection`. | "This is the objection most SEs get asked and fumble - the copilot has the honest answer queued in under two seconds." |
| 5 | technical-trigger | Technical term used | A technical term (e.g., "HTAP", "TiFlash") is used; the trigger fires `technical-term` and pulls the matching doc fact. | "A technical term triggers a documentation-grounded answer, not a guess." |
| 6 | wrap-up | Call ends, summary written | Capture stops, transcript is redacted and retained per policy, Claude Sonnet writes a summary and follow-up draft into TiDB. | "When the call ends, the copilot writes the summary and follow-up back to the same TiDB store - no separate CRM sync step." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `start-mock-call` | Start mock call | Begins streaming the synthetic mock-call audio fixture (or live mic input if `AUDIO_SOURCE=mic`) into the ASR pipeline and advances to phase `discovery`. |
| `inject-objection` | Inject objection | Forces the objection trigger to fire immediately with the scripted objection line, independent of where the mock call's playback currently is. |
| `toggle-retrieval-mode` | Toggle retrieval mode | Cycles the next retrieval through `vector` -> `fulltext` -> `hybrid` -> back to `vector`, so the audience can compare suggestion quality across modes. |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `consent-given` | Consent recorded before capture | `pass` the instant the runner logs the consent statement and before the first audio chunk is sent to ASR; `fail` if capture starts first. |
| `no-raw-audio` | No raw audio persisted | After the run, a filesystem scan of `demos/call-copilot/` (excluding the committed synthetic fixture under `fixtures/`) finds zero `.wav`/`.pcm`/`.raw` files; `pass` if none, `fail` and lists the path otherwise. |
| `hybrid-eval` | Hybrid retrieval matches the labeled eval set | Runs the 8-row eval set (`test/eval/triggers.json`) against hybrid retrieval; `pass` if every trigger's top fused result is its labeled expected fact id, `observed` reports `n/8 matched`. |
| `suggestion-latency-p99` | Suggestion latency under target | `pass` if the run's p99 of `suggestion-latency-ms` is at or under `SUGGESTION_LATENCY_TARGET_MS` from `.env`; `fail` with the observed p99 otherwise. |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `asr-latency-ms` | Speech-end to transcript latency | ms | both | lower | Per finalized AssemblyAI `Turn` message (`end_of_turn: true`), `latencyMs = receivedAtMs - (turnStartedAtMs + lastWord.end)`, where `lastWord.end` is the last word's end offset (ms) from the same `Turn` payload and `turnStartedAtMs` is the wall-clock time the runner opened the ASR session; summarized per tick with `summarize()` from `@lab/runner-kit`. |
| `vector-latency-p50` | Vector search p50 | ms | tile | lower | `summarize(vectorLatencySamples).p50` where each sample is the `ms` returned by `timed()` wrapping the `SELECT ... ORDER BY VEC_COSINE_DISTANCE(embedding, ?) LIMIT 20` query. |
| `vector-latency-p99` | Vector search p99 | ms | tile | lower | Same sample set as `vector-latency-p50`, `summarize().p99`. |
| `fulltext-latency-p50` | Full-text search p50 | ms | tile | lower | `summarize(fulltextLatencySamples).p50` where each sample is the `ms` from `timed()` wrapping `SELECT ... WHERE FTS_MATCH_WORD(?, text) ORDER BY FTS_MATCH_WORD(?, text) DESC LIMIT 20`. |
| `fulltext-latency-p99` | Full-text search p99 | ms | tile | lower | Same sample set as `fulltext-latency-p50`, `summarize().p99`. |
| `hybrid-latency-p50` | Hybrid retrieval p50 | ms | both | lower | `summarize(hybridLatencySamples).p50` where each sample is `ms` from `timed()` wrapping `Promise.all([vectorQuery, fulltextQuery])` plus the synchronous `reciprocalRankFusion()` call. |
| `hybrid-latency-p99` | Hybrid retrieval p99 | ms | both | lower | Same sample set as `hybrid-latency-p50`, `summarize().p99`. |
| `llm-ttft-ms` | Claude time to first token | ms | both | lower | `firstDeltaMs - requestSentMs`, where `requestSentMs` is captured immediately before calling the Anthropic streaming API and `firstDeltaMs` is captured on the first `content_block_delta` event whose `delta.type` is `text_delta`. |
| `suggestion-latency-ms` | End-to-end suggestion latency | ms | both | lower | `firstDeltaMs - utteranceEndMs`, where `utteranceEndMs` is the same timestamp used for `asr-latency-ms` (the last word's end offset for the triggering turn) and `firstDeltaMs` is the same timestamp used for `llm-ttft-ms`. This is the number the presenter calls out live. |
| `suggestions-shown` | Suggestions shown | count | tile | higher | Cumulative count, incremented once per completed Claude suggestion stream (on that stream's `message_stop` event). |
| `suggestions-accepted` | Suggestions accepted | count | tile | higher | Cumulative count, incremented once per `control` event with id `accept-suggestion` recorded by the relay (only emitted when the demo runs live with the overlay UI; the featured trace records whatever the recording operator accepted). |
| `kb-rows` | Knowledge base size | rows | tile | neutral | `SELECT COUNT(*) FROM kb_facts`, executed once at startup after seeding and again at the end of the run. |

## 4. Verified facts and sources

Every product capability this demo relies on, with the official doc URL checked while writing this plan. Anything not confirmed is marked **UNVERIFIED** with the exact step to confirm it before building.

| Fact | Source | Status |
|---|---|---|
| TiDB vector search: `VECTOR(n)` column type, `VEC_COSINE_DISTANCE()` / `VEC_L2_DISTANCE()` distance functions, `CREATE TABLE ... VECTOR INDEX idx ((VEC_COSINE_DISTANCE(embedding)))` HNSW index syntax, available on TiDB Self-Managed (v8.4.0+, v8.5.0+ recommended) and TiDB Cloud Starter, feature is in public preview | https://docs.pingcap.com/ai/vector-search-overview/ and https://docs.pingcap.com/ai/vector-search-index/ and https://docs.pingcap.com/ai/quickstart-via-sql/ | Verified |
| Vector search index requires a TiFlash replica on the table; HNSW is the only supported algorithm; a distance function is mandatory at index-creation time | https://docs.pingcap.com/ai/vector-search-index/ | Verified |
| TiDB full-text search: `FULLTEXT INDEX (col) WITH PARSER STANDARD|MULTILINGUAL`, `FTS_MATCH_WORD(query, col)` function, BM25 (BM25Tantivy variant, `k1=1.2`, `b=0.75`) relevance scoring, OR-semantics tokenization, no phrase or prefix matching | https://docs.pingcap.com/ai/vector-search-full-text-search-sql/ | Verified |
| Full-text search is "still in the early stages" and, as of this writing, is **only available on TiDB Cloud Starter** in five specific AWS regions (Oregon us-west-2, N. Virginia us-east-1, Tokyo ap-northeast-1, Frankfurt eu-central-1, Singapore ap-southeast-1) - it is not listed as available on TiDB Self-Managed or the local `tiup playground` | https://docs.pingcap.com/ai/vector-search-full-text-search-sql/ and https://docs.pingcap.com/ai/vector-search-hybrid-search/ | Verified (see Task 8 gotcha) |
| TiDB has no built-in fusion of vector + full-text results; the documented pattern (via the Python `pytidb` SDK) is to run both searches and fuse client-side, with Reciprocal Rank Fusion (`k` default 60) or a weighted-sum method - this demo's runner is TypeScript, so it reimplements RRF itself rather than depending on `pytidb` | https://docs.pingcap.com/ai/vector-search-hybrid-search/ | Verified |
| Anthropic Messages API streaming: `stream: true`, SSE event flow is `message_start` -> repeated (`content_block_start`, one or more `content_block_delta`, `content_block_stop`) -> `message_delta` -> `message_stop`; a text delta has `delta.type: "text_delta"` and `delta.text` | https://platform.claude.com/docs/en/build-with-claude/streaming | Verified |
| Claude Haiku 4.5 model ID `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`), 200K token context window, fastest comparative latency in the Claude lineup | https://platform.claude.com/docs/en/models/haiku-4-5/overview | Verified |
| Claude Sonnet 5 model ID `claude-sonnet-5`, 1M token context window (this plan uses it for post-call summaries, well under that window) | https://platform.claude.com/docs/en/models/sonnet-5/overview | Verified |
| OpenAI `text-embedding-3-small` produces 1536-dimension embeddings by default (dimensions are reducible via the `dimensions` parameter); it is also the model used in TiDB's own hybrid-search tutorial (`EmbeddingFunction("openai/text-embedding-3-small")`) | https://platform.openai.com/docs/guides/embeddings and https://docs.pingcap.com/ai/vector-search-hybrid-search/ | Verified |
| macOS `ScreenCaptureKit` (`SCStreamConfiguration.capturesAudio`) can capture system audio output directly, gated only by the standard Screen Recording TCC permission, since macOS 13; it is a native Swift/Objective-C API only - there is no Node.js binding, so using it means shipping and code-signing a small Swift helper process | https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos | Verified |
| BlackHole is a free, open-source, kernel-extension-free virtual audio loopback driver for macOS (Intel and Apple Silicon); routing a Zoom/Teams/Meet call's output through a Multi-Output Device that includes BlackHole makes that audio available as a standard CoreAudio input device, capturable by any process (including a plain `sox`/`rec` command) without writing native code | https://github.com/ExistentialAudio/BlackHole/wiki/Capture-System-Audio-with-BlackHole and https://existential.audio/blackhole/ | Verified |
| This plan chooses **BlackHole + `sox`** over a ScreenCaptureKit Swift helper as the primary audio-capture path specifically to avoid Swift/Xcode/code-signing complexity for a first version; ScreenCaptureKit remains a documented, UNVERIFIED-for-this-plan future upgrade path | n/a (design decision) | Decision, not a vendor fact |
| AssemblyAI streaming (Universal-Streaming): WebSocket endpoint `wss://streaming.assemblyai.com/v3/ws`, connection params include `sample_rate` and `speech_model` (default `universal-3-6-pro`; `universal-streaming-english` is the cost/latency-optimized English-only option), returns partial and final `Turn` messages with `turn_is_formatted`, `end_of_turn`, `end_of_turn_confidence`, and a `words[]` array with per-word `start`/`end`/`confidence` | https://www.assemblyai.com/docs/streaming/universal-streaming and https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket | Verified |
| The exact full JSON schema of every AssemblyAI streaming message type (`Begin`, `Turn`, `Termination`, error payloads) beyond the `Turn` fields listed above | https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket | **UNVERIFIED** - confirm the full message schema by opening one real streaming session (Task 9's manual run) and logging every raw message before wiring the parser's types |
| Whether the local `infra/tidb/playground.sh` (`tiup playground`) build of TiDB supports `FULLTEXT INDEX` / `FTS_MATCH_WORD` at all, given the docs describe full-text search as Starter-only in specific regions | https://docs.pingcap.com/ai/vector-search-full-text-search-sql/ | **UNVERIFIED** - confirm in Task 8 by running `CREATE FULLTEXT INDEX` against a local playground cluster; if it fails, this demo's `.env` must point at a TiDB Cloud Starter instance in one of the five listed regions instead of local playground, and `LAB_ENV_TIDB` / `LAB_ENV_NOTES` must say so |
| Deepgram (`streaming.deepgram.com`, Nova-3 model family) as an alternative streaming ASR vendor: also WebSocket-based, also returns interim + final transcripts | https://developers.deepgram.com/docs/live-streaming-audio | Verified as an alternative; not chosen (see Task 9 rationale) |
| `whisper.cpp`'s `stream` example performs local, no-vendor-key streaming transcription via a sliding window or VAD mode, but requires SDL2 for audio capture and is CPU-bound on the presenter's machine | https://github.com/ggml-org/whisper.cpp/blob/master/examples/stream/README.md | Verified as an alternative; not chosen (see Task 9 rationale) |

## 5. Prerequisites, cost, and teardown

- Accounts and access:
  - A TiDB Cloud Starter instance in one of the five regions that currently support full-text search (see Section 4); confirm current region availability at the Full-Text Search doc URL above before creating the instance, since this list is explicitly called "early stages" and may change.
  - An AssemblyAI API key (streaming).
  - An Anthropic API key with access to `claude-haiku-4-5-20251001` and `claude-sonnet-5`.
  - An OpenAI API key for `text-embedding-3-small` (or any embedding provider swapped in later; the schema only cares about the vector's dimension).
- Local tools:
  - Node 22, pnpm, python3 (already required by the platform).
  - Xcode command line tools: **run `xcode-select -p` as the first step of Task 11** and record the result; they are "likely available" per this plan's brief but must be confirmed, since `sox` and BlackHole installation both assume a working Homebrew/CLT toolchain on this Mac.
  - `brew install sox blackhole-2ch` for audio capture (Task 11).
  - `say` (built into macOS) for synthesizing the mock-call fixture audio (Task 10).
- Cost model: TiDB Cloud Starter billing is usage-based; see the vendor's current pricing page (do not hardcode a number here - point to https://www.pingcap.com/pricing/ at build time). AssemblyAI streaming and Anthropic API calls are both metered per session-second / per-token respectively; see https://www.assemblyai.com/pricing and https://platform.claude.com/docs/en/about-claude/pricing for current rates. The featured trace is a single ~4-6 minute scripted run, so its own recording cost is negligible; the ongoing cost driver for someone re-running this demo live is Claude and AssemblyAI usage during rehearsal.
- Teardown:
  - `tiup clean lab` if a local playground was used for anything other than full-text search testing.
  - Drop the demo's TiDB Cloud Starter database: `DROP DATABASE lab;` (or delete the Starter instance from the console if it was created solely for this demo).
  - Revoke/rotate the AssemblyAI, Anthropic, and OpenAI API keys used during development if they were created solely for this plan.
  - Confirm nothing is left billing by checking the TiDB Cloud console's instance list and the AssemblyAI/Anthropic usage dashboards show no active sessions after teardown.

## 6. File structure

```
demos/call-copilot/
  manifest.json                     validated by DemoManifestSchema (Task 1)
  package.json                      "@lab/demo-call-copilot", depends on @lab/contract + @lab/runner-kit
  tsconfig.json                     extends ../../tsconfig.base.json
  README.md                         what it proves, prerequisites, run, record, teardown, cost notes (Task 16)
  TALK-TRACK.md                     presenter script, discovery questions, objections and answers (Task 16)
  .env.example                      standard block + AssemblyAI/Anthropic/OpenAI keys + demo-specific vars (Task 1)
  fixtures/
    mock-call-script.json           the scripted two-person dialogue, line by line, with speaker + trigger labels (Task 10)
    mock-call.wav                   synthesized audio of the script, generated once via `say` (Task 10, committed)
  runner/
    main.ts                         entry point: wires capture, ASR, retrieval, suggestion, summary, emits lab events (Task 12)
    src/
      redact.ts                     PII redaction pure function (Task 2)
      window.ts                     rolling transcript turn window (Task 3)
      triggers.ts                   trigger detector pure function (Task 4)
      fusion.ts                     Reciprocal Rank Fusion pure function (Task 5)
      prompt.ts                     prompt assembly pure functions (Task 6)
      timing.ts                     latency math helpers (ttft, suggestion latency) (Task 7)
      kb.ts                         TiDB knowledge base queries: vector, full-text, hybrid (Task 8)
      seed-kb.ts                    seeds kb_facts with public TiDB docs facts + synthetic call notes (Task 8)
      asr-client.ts                 AssemblyAI streaming WebSocket client (Task 9)
      audio-capture.ts              BlackHole/sox child_process audio source + mock-call file source (Task 11)
      suggest.ts                    Claude Haiku streaming suggestion call (Task 6, 12)
      summarize-call.ts             Claude Sonnet post-call summary + follow-up draft (Task 13)
      retention.ts                  transcript redaction-at-rest + retention purge (Task 14)
    test/
      redact.test.ts                Task 2
      window.test.ts                Task 3
      triggers.test.ts              Task 4
      fusion.test.ts                Task 5
      prompt.test.ts                Task 6
      timing.test.ts                Task 7
      eval/
        triggers.json               8-row labeled eval set: trigger text -> expected kb_facts.id (Task 15)
        hybrid-eval.test.ts         runs the eval set against fusion.ts with fixture retrieval results (Task 15)
  test/
    manifest.test.ts                 parses manifest.json with DemoManifestSchema (Task 1)
  traces/
    featured.json                    the recording the website plays (committed after capture, Task 17)
```

## 7. Tasks

### Task 1: Scaffold the demo folder and manifest

- [ ] Create `demos/call-copilot/package.json`:

```json
{
  "name": "@lab/demo-call-copilot",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run", "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "mysql2": "^3.11.0",
    "ws": "^8.18.0",
    "@anthropic-ai/sdk": "^0.32.0",
    "openai": "^4.68.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "vitest": "^3.2.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] Create `demos/call-copilot/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["runner", "test"]
}
```

- [ ] Create `demos/call-copilot/.env.example`:

```
TIDB_HOST=127.0.0.1
TIDB_PORT=4000
TIDB_USER=root
TIDB_PASSWORD=
TIDB_DATABASE=lab
TIDB_TLS=false
LAB_ENV_TIDB=tiup playground (local)
LAB_ENV_NOTES=

ASSEMBLYAI_API_KEY=
ASSEMBLYAI_SPEECH_MODEL=universal-streaming-english
ANTHROPIC_API_KEY=
ANTHROPIC_SUGGEST_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_SUMMARY_MODEL=claude-sonnet-5
OPENAI_API_KEY=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
AUDIO_SOURCE=fixture
TRANSCRIPT_RETENTION_DAYS=30
SUGGESTION_LATENCY_TARGET_MS=2500
```

- [ ] Create `demos/call-copilot/manifest.json`:

```json
{
  "id": "call-copilot",
  "number": 12,
  "title": "Call Copilot",
  "tagline": "Live retrieval-grounded suggestions for sales engineers, powered by TiDB hybrid search",
  "integrations": ["Claude", "AssemblyAI"],
  "pattern": "sales engineers and account executives who want real-time help on live calls: the right product fact, proof point, or discovery question at the right moment",
  "publish": true,
  "runner": {
    "command": ["node", "--import", "tsx", "runner/main.ts"],
    "cwd": "."
  },
  "nodes": [
    { "id": "mic", "label": "Call audio (mic + system)", "kind": "source", "x": 8, "y": 20 },
    { "id": "asr", "label": "Streaming ASR", "kind": "service", "x": 24, "y": 20 },
    { "id": "trigger", "label": "Trigger detector", "kind": "service", "x": 24, "y": 50 },
    { "id": "tidb", "label": "TiDB (vector + full-text)", "kind": "tidb", "x": 50, "y": 35 },
    { "id": "claude-suggest", "label": "Claude Haiku (suggestion)", "kind": "service", "x": 68, "y": 18 },
    { "id": "overlay", "label": "Suggestion overlay", "kind": "client", "x": 90, "y": 18 },
    { "id": "claude-summary", "label": "Claude Sonnet (summary)", "kind": "service", "x": 68, "y": 65 },
    { "id": "store", "label": "Call history (TiDB)", "kind": "sink", "x": 90, "y": 65 }
  ],
  "edges": [
    { "id": "mic-asr", "from": "mic", "to": "asr", "label": "audio chunks", "unit": "msgs/s" },
    { "id": "asr-trigger", "from": "asr", "to": "trigger", "label": "transcript turns", "unit": "msgs/s" },
    { "id": "trigger-tidb", "from": "trigger", "to": "tidb", "label": "retrieval queries", "unit": "req/s" },
    { "id": "tidb-suggest", "from": "tidb", "to": "claude-suggest", "label": "retrieved facts", "unit": "rows/s" },
    { "id": "suggest-overlay", "from": "claude-suggest", "to": "overlay", "label": "suggestion tokens", "unit": "msgs/s" },
    { "id": "asr-summary", "from": "asr", "to": "claude-summary", "label": "full call transcript", "unit": "count" },
    { "id": "summary-store", "from": "claude-summary", "to": "store", "label": "summary + follow-up rows", "unit": "rows/s" }
  ],
  "metrics": [
    { "id": "asr-latency-ms", "label": "Speech-end to transcript latency", "unit": "ms", "display": "both", "better": "lower", "howMeasured": "receivedAtMs - (turnStartedAtMs + lastWord.end) per finalized AssemblyAI Turn message" },
    { "id": "vector-latency-p50", "label": "Vector search p50", "unit": "ms", "display": "tile", "better": "lower", "group": "retrieval", "howMeasured": "summarize(vectorLatencySamples).p50 from timed() around VEC_COSINE_DISTANCE query" },
    { "id": "vector-latency-p99", "label": "Vector search p99", "unit": "ms", "display": "tile", "better": "lower", "group": "retrieval", "howMeasured": "summarize(vectorLatencySamples).p99 from timed() around VEC_COSINE_DISTANCE query" },
    { "id": "fulltext-latency-p50", "label": "Full-text search p50", "unit": "ms", "display": "tile", "better": "lower", "group": "retrieval", "howMeasured": "summarize(fulltextLatencySamples).p50 from timed() around FTS_MATCH_WORD query" },
    { "id": "fulltext-latency-p99", "label": "Full-text search p99", "unit": "ms", "display": "tile", "better": "lower", "group": "retrieval", "howMeasured": "summarize(fulltextLatencySamples).p99 from timed() around FTS_MATCH_WORD query" },
    { "id": "hybrid-latency-p50", "label": "Hybrid retrieval p50", "unit": "ms", "display": "both", "better": "lower", "group": "retrieval", "howMeasured": "summarize(hybridLatencySamples).p50 from timed() around Promise.all([vector, fulltext]) + reciprocalRankFusion" },
    { "id": "hybrid-latency-p99", "label": "Hybrid retrieval p99", "unit": "ms", "display": "both", "better": "lower", "group": "retrieval", "howMeasured": "summarize(hybridLatencySamples).p99 from timed() around Promise.all([vector, fulltext]) + reciprocalRankFusion" },
    { "id": "llm-ttft-ms", "label": "Claude time to first token", "unit": "ms", "display": "both", "better": "lower", "howMeasured": "firstDeltaMs - requestSentMs, first content_block_delta with delta.type text_delta" },
    { "id": "suggestion-latency-ms", "label": "End-to-end suggestion latency", "unit": "ms", "display": "both", "better": "lower", "target": 2500, "howMeasured": "firstDeltaMs - utteranceEndMs, utterance end from the triggering ASR Turn, firstDeltaMs from the Claude stream" },
    { "id": "suggestions-shown", "label": "Suggestions shown", "unit": "count", "display": "tile", "better": "higher", "howMeasured": "cumulative count incremented on each Claude suggestion stream's message_stop event" },
    { "id": "suggestions-accepted", "label": "Suggestions accepted", "unit": "count", "display": "tile", "better": "higher", "howMeasured": "cumulative count incremented on each accept-suggestion control event" },
    { "id": "kb-rows", "label": "Knowledge base size", "unit": "rows", "display": "tile", "better": "neutral", "howMeasured": "SELECT COUNT(*) FROM kb_facts" }
  ],
  "phases": [
    { "id": "consent", "label": "Consent", "narration": "Before anything is captured, the copilot announces recording and waits for consent - that gate is not optional." },
    { "id": "discovery", "label": "Discovery", "narration": "The SE and prospect are just talking. Nothing fires until the copilot recognizes something worth surfacing." },
    { "id": "question-trigger", "label": "Discovery question asked", "narration": "A direct question just fired the trigger. Watch the suggestion card - TiDB found the fact, Claude worded it, in about a second." },
    { "id": "competitor-trigger", "label": "Competitor named", "narration": "The moment a competitor's name is said, the retrieval scope shifts to battlecard content automatically." },
    { "id": "objection-trigger", "label": "Objection raised", "narration": "This is the objection most SEs get asked and fumble - the copilot has the honest answer queued in under two seconds." },
    { "id": "technical-trigger", "label": "Technical term used", "narration": "A technical term triggers a documentation-grounded answer, not a guess." },
    { "id": "wrap-up", "label": "Call ends, summary written", "narration": "When the call ends, the copilot writes the summary and follow-up back to the same TiDB store - no separate CRM sync step." }
  ],
  "checks": [
    { "id": "consent-given", "label": "Consent recorded before capture", "description": "Passes if the consent log line is written before the first audio chunk reaches ASR." },
    { "id": "no-raw-audio", "label": "No raw audio persisted", "description": "Passes if no .wav/.pcm/.raw file exists under demos/call-copilot/ outside fixtures/ after the run." },
    { "id": "hybrid-eval", "label": "Hybrid retrieval matches the labeled eval set", "description": "Passes if hybrid retrieval's top result matches the expected fact id for every row in test/eval/triggers.json." },
    { "id": "suggestion-latency-p99", "label": "Suggestion latency under target", "description": "Passes if the run's p99 suggestion-latency-ms is at or under SUGGESTION_LATENCY_TARGET_MS." }
  ],
  "controls": [
    { "id": "start-mock-call", "label": "Start mock call", "description": "Begins streaming the mock-call audio into the ASR pipeline and advances to the discovery phase." },
    { "id": "inject-objection", "label": "Inject objection", "description": "Forces the objection trigger to fire immediately with the scripted objection line." },
    { "id": "toggle-retrieval-mode", "label": "Toggle retrieval mode", "description": "Cycles the next retrieval through vector, fulltext, then hybrid." }
  ]
}
```

- [ ] Write the failing test `demos/call-copilot/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

describe('call-copilot manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const raw = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8'));
    const result = DemoManifestSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});
```

- [ ] Run: `cd demos/call-copilot && pnpm install && pnpm test` - expected FAIL (`@lab/contract` not resolvable yet if the workspace hasn't linked this new package; if it fails for that reason, run `pnpm install` from the `integrations/` root first, then re-run `pnpm --filter @lab/demo-call-copilot test`). Once dependencies resolve, this test is expected to PASS immediately, since `manifest.json` above is already valid - there is no red step here beyond dependency wiring. Confirm PASS with: `pnpm --filter @lab/demo-call-copilot test`.
- [ ] Commit: `git add demos/call-copilot/package.json demos/call-copilot/tsconfig.json demos/call-copilot/.env.example demos/call-copilot/manifest.json demos/call-copilot/test/manifest.test.ts && git commit -m "call-copilot: scaffold demo folder and manifest"`

### Task 2: PII redaction (pure logic)

- [ ] Write the failing test `demos/call-copilot/runner/test/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { redactPII } from '../src/redact';

describe('redactPII', () => {
  it('replaces email addresses with a placeholder', () => {
    const input = 'reach me at jane.doe@example.com after the call';
    expect(redactPII(input)).toBe('reach me at [redacted-email] after the call');
  });

  it('replaces phone numbers with a placeholder', () => {
    const input = 'call me at 415-555-0134 tomorrow';
    expect(redactPII(input)).toBe('call me at [redacted-phone] tomorrow');
  });

  it('leaves text with no PII unchanged', () => {
    const input = 'TiDB uses HTAP to serve both transactional and analytical queries';
    expect(redactPII(input)).toBe(input);
  });

  it('redacts multiple matches in the same string', () => {
    const input = 'email a@b.com or call 415-555-0134';
    expect(redactPII(input)).toBe('email [redacted-email] or call [redacted-phone]');
  });
});
```

- [ ] Run: `cd demos/call-copilot && pnpm vitest run runner/test/redact.test.ts` - expected FAIL (`Cannot find module '../src/redact'`).
- [ ] Write `demos/call-copilot/runner/src/redact.ts`:

```ts
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

export const redactPII = (text: string): string =>
  text.replace(EMAIL_PATTERN, '[redacted-email]').replace(PHONE_PATTERN, '[redacted-phone]');
```

- [ ] Run: `pnpm vitest run runner/test/redact.test.ts` - expected PASS (4 tests).
- [ ] Commit: `git add demos/call-copilot/runner/src/redact.ts demos/call-copilot/runner/test/redact.test.ts && git commit -m "call-copilot: add PII redaction"`

### Task 3: Rolling transcript turn window (pure logic)

- [ ] Write the failing test `demos/call-copilot/runner/test/window.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTurnWindow } from '../src/window';

describe('createTurnWindow', () => {
  it('starts empty', () => {
    const window = createTurnWindow({ windowMs: 60_000 });
    expect(window.turns()).toEqual([]);
  });

  it('keeps turns added within the window', () => {
    const window = createTurnWindow({ windowMs: 60_000 });
    window.add({ speaker: 'prospect', text: 'How does TiDB handle failover?', endedAtMs: 1_000 });
    expect(window.turns()).toHaveLength(1);
    expect(window.turns()[0].text).toBe('How does TiDB handle failover?');
  });

  it('evicts turns older than windowMs relative to the newest turn', () => {
    const window = createTurnWindow({ windowMs: 5_000 });
    window.add({ speaker: 'se', text: 'first turn', endedAtMs: 0 });
    window.add({ speaker: 'prospect', text: 'second turn', endedAtMs: 6_000 });
    expect(window.turns()).toHaveLength(1);
    expect(window.turns()[0].text).toBe('second turn');
  });

  it('joinedText concatenates turns in order with a speaker prefix', () => {
    const window = createTurnWindow({ windowMs: 60_000 });
    window.add({ speaker: 'se', text: 'Let me walk you through it.', endedAtMs: 0 });
    window.add({ speaker: 'prospect', text: 'Sounds good.', endedAtMs: 1_000 });
    expect(window.joinedText()).toBe('se: Let me walk you through it.\nprospect: Sounds good.');
  });
});
```

- [ ] Run: `pnpm vitest run runner/test/window.test.ts` - expected FAIL (`Cannot find module '../src/window'`).
- [ ] Write `demos/call-copilot/runner/src/window.ts`:

```ts
export type Turn = {
  readonly speaker: string;
  readonly text: string;
  readonly endedAtMs: number;
};

export type TurnWindow = {
  readonly add: (turn: Turn) => void;
  readonly turns: () => readonly Turn[];
  readonly joinedText: () => string;
};

export const createTurnWindow = (options: { readonly windowMs: number }): TurnWindow => {
  const buffer: Turn[] = [];
  const add = (turn: Turn): void => {
    buffer.push(turn);
    const newestMs = buffer[buffer.length - 1].endedAtMs;
    while (buffer.length > 0 && newestMs - buffer[0].endedAtMs > options.windowMs) {
      buffer.shift();
    }
  };
  const turns = (): readonly Turn[] => [...buffer];
  const joinedText = (): string => buffer.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n');
  return { add, turns, joinedText };
};
```

- [ ] Run: `pnpm vitest run runner/test/window.test.ts` - expected PASS (4 tests).
- [ ] Commit: `git add demos/call-copilot/runner/src/window.ts demos/call-copilot/runner/test/window.test.ts && git commit -m "call-copilot: add rolling transcript turn window"`

### Task 4: Trigger detector (pure logic)

- [ ] Write the failing test `demos/call-copilot/runner/test/triggers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectTrigger } from '../src/triggers';

describe('detectTrigger', () => {
  it('detects a direct question', () => {
    const result = detectTrigger('How does TiDB handle a node failure?');
    expect(result).toEqual({ kind: 'question', matched: 'How does TiDB handle a node failure?' });
  });

  it('detects a named competitor', () => {
    const result = detectTrigger('We are also looking at Aurora for this.');
    expect(result).toEqual({ kind: 'competitor', matched: 'Aurora' });
  });

  it('detects an objection phrase', () => {
    const result = detectTrigger('Honestly this seems like it would be too expensive for us.');
    expect(result).toEqual({ kind: 'objection', matched: 'too expensive' });
  });

  it('detects a technical term', () => {
    const result = detectTrigger('Can you explain how HTAP works here?');
    expect(result).toEqual({ kind: 'question', matched: 'Can you explain how HTAP works here?' });
  });

  it('detects a technical term with no question mark', () => {
    const result = detectTrigger('We read about TiFlash in your docs.');
    expect(result).toEqual({ kind: 'technical-term', matched: 'TiFlash' });
  });

  it('returns none when nothing matches', () => {
    const result = detectTrigger('Great, thanks for the overview so far.');
    expect(result).toEqual({ kind: 'none' });
  });
});
```

- [ ] Run: `pnpm vitest run runner/test/triggers.test.ts` - expected FAIL (`Cannot find module '../src/triggers'`).
- [ ] Write `demos/call-copilot/runner/src/triggers.ts`:

```ts
export type TriggerKind = 'question' | 'competitor' | 'objection' | 'technical-term' | 'none';

export type TriggerResult =
  | { readonly kind: 'question'; readonly matched: string }
  | { readonly kind: 'competitor'; readonly matched: string }
  | { readonly kind: 'objection'; readonly matched: string }
  | { readonly kind: 'technical-term'; readonly matched: string }
  | { readonly kind: 'none' };

const COMPETITORS = ['Aurora', 'CockroachDB', 'PlanetScale', 'Vitess', 'YugabyteDB'];
const OBJECTION_PHRASES = ['too expensive', 'too complex', 'too risky', 'not sure we need this'];
const TECHNICAL_TERMS = ['HTAP', 'TiFlash', 'TiKV', 'TiCDC', 'HNSW', 'BM25'];

const findFirst = (haystack: string, needles: readonly string[]): string | undefined =>
  needles.find((needle) => haystack.toLowerCase().includes(needle.toLowerCase()));

export const detectTrigger = (text: string): TriggerResult => {
  const competitor = findFirst(text, COMPETITORS);
  if (competitor !== undefined) return { kind: 'competitor', matched: competitor };

  const objection = findFirst(text, OBJECTION_PHRASES);
  if (objection !== undefined) return { kind: 'objection', matched: objection };

  if (text.trim().endsWith('?')) return { kind: 'question', matched: text.trim() };

  const technicalTerm = findFirst(text, TECHNICAL_TERMS);
  if (technicalTerm !== undefined) return { kind: 'technical-term', matched: technicalTerm };

  return { kind: 'none' };
};
```

- [ ] Run: `pnpm vitest run runner/test/triggers.test.ts` - expected PASS (6 tests).
- [ ] Commit: `git add demos/call-copilot/runner/src/triggers.ts demos/call-copilot/runner/test/triggers.test.ts && git commit -m "call-copilot: add trigger detector"`

### Task 5: Reciprocal Rank Fusion (pure logic)

- [ ] Write the failing test `demos/call-copilot/runner/test/fusion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../src/fusion';

describe('reciprocalRankFusion', () => {
  it('ranks a document appearing near the top of both lists highest', () => {
    const vectorResults = ['fact-1', 'fact-2', 'fact-3'];
    const fulltextResults = ['fact-2', 'fact-1', 'fact-4'];
    const fused = reciprocalRankFusion({ vectorResults, fulltextResults, k: 60 });
    expect(fused[0].id).toBe('fact-1');
  });

  it('scores a document present in only one list lower than one present in both', () => {
    const vectorResults = ['fact-1', 'fact-5'];
    const fulltextResults = ['fact-1'];
    const fused = reciprocalRankFusion({ vectorResults, fulltextResults, k: 60 });
    const fact1 = fused.find((row) => row.id === 'fact-1');
    const fact5 = fused.find((row) => row.id === 'fact-5');
    expect(fact1).toBeDefined();
    expect(fact5).toBeDefined();
    expect(fact1!.score).toBeGreaterThan(fact5!.score);
  });

  it('computes the exact RRF score with the standard formula', () => {
    const fused = reciprocalRankFusion({ vectorResults: ['fact-1'], fulltextResults: [], k: 60 });
    expect(fused[0].score).toBeCloseTo(1 / (60 + 1), 10);
  });

  it('returns an empty array when both inputs are empty', () => {
    expect(reciprocalRankFusion({ vectorResults: [], fulltextResults: [], k: 60 })).toEqual([]);
  });

  it('sorts the fused list by score descending', () => {
    const fused = reciprocalRankFusion({
      vectorResults: ['fact-1', 'fact-2', 'fact-3'],
      fulltextResults: ['fact-3', 'fact-2', 'fact-1'],
      k: 60,
    });
    const scores = fused.map((row) => row.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
```

- [ ] Run: `pnpm vitest run runner/test/fusion.test.ts` - expected FAIL (`Cannot find module '../src/fusion'`).
- [ ] Write `demos/call-copilot/runner/src/fusion.ts`:

```ts
export type FusedRow = { readonly id: string; readonly score: number };

const rankScore = (rank: number, k: number): number => 1 / (k + rank + 1);

export const reciprocalRankFusion = (options: {
  readonly vectorResults: readonly string[];
  readonly fulltextResults: readonly string[];
  readonly k: number;
}): readonly FusedRow[] => {
  const scores = new Map<string, number>();
  options.vectorResults.forEach((id, rank) => {
    scores.set(id, (scores.get(id) ?? 0) + rankScore(rank, options.k));
  });
  options.fulltextResults.forEach((id, rank) => {
    scores.set(id, (scores.get(id) ?? 0) + rankScore(rank, options.k));
  });
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
};
```

- [ ] Run: `pnpm vitest run runner/test/fusion.test.ts` - expected PASS (5 tests).
- [ ] Commit: `git add demos/call-copilot/runner/src/fusion.ts demos/call-copilot/runner/test/fusion.test.ts && git commit -m "call-copilot: add reciprocal rank fusion"`

### Task 6: Prompt assembly (pure logic)

- [ ] Write the failing test `demos/call-copilot/runner/test/prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSuggestionPrompt, buildSummaryPrompt } from '../src/prompt';

describe('buildSuggestionPrompt', () => {
  it('includes the trigger, the recent transcript, and each retrieved fact', () => {
    const prompt = buildSuggestionPrompt({
      trigger: { kind: 'competitor', matched: 'Aurora' },
      recentTranscript: 'prospect: We are also looking at Aurora for this.',
      facts: [
        { id: 'fact-1', text: 'TiDB is MySQL wire-compatible; Aurora migrations need no app rewrite.' },
        { id: 'fact-2', text: 'TiDB combines HTAP with TiFlash; Aurora requires a separate analytics stack.' },
      ],
    });
    expect(prompt).toContain('competitor');
    expect(prompt).toContain('Aurora');
    expect(prompt).toContain('We are also looking at Aurora for this.');
    expect(prompt).toContain('TiDB is MySQL wire-compatible');
    expect(prompt).toContain('TiDB combines HTAP with TiFlash');
  });

  it('says no facts were retrieved when the list is empty', () => {
    const prompt = buildSuggestionPrompt({
      trigger: { kind: 'question', matched: 'How does failover work?' },
      recentTranscript: 'prospect: How does failover work?',
      facts: [],
    });
    expect(prompt).toContain('No matching facts were retrieved');
  });
});

describe('buildSummaryPrompt', () => {
  it('includes the full transcript', () => {
    const prompt = buildSummaryPrompt({ fullTranscript: 'se: Hi.\nprospect: Hi, thanks for the call.' });
    expect(prompt).toContain('se: Hi.');
    expect(prompt).toContain('prospect: Hi, thanks for the call.');
  });
});
```

- [ ] Run: `pnpm vitest run runner/test/prompt.test.ts` - expected FAIL (`Cannot find module '../src/prompt'`).
- [ ] Write `demos/call-copilot/runner/src/prompt.ts`:

```ts
import type { TriggerResult } from './triggers';

export type RetrievedFact = { readonly id: string; readonly text: string };

export const buildSuggestionPrompt = (options: {
  readonly trigger: TriggerResult;
  readonly recentTranscript: string;
  readonly facts: readonly RetrievedFact[];
}): string => {
  const factLines =
    options.facts.length === 0
      ? 'No matching facts were retrieved. Say so plainly rather than guessing.'
      : options.facts.map((fact) => `- [${fact.id}] ${fact.text}`).join('\n');
  return [
    'You are a sales engineering copilot whispering a suggestion to a human SE mid-call.',
    `Trigger kind: ${options.trigger.kind}`,
    'Recent transcript:',
    options.recentTranscript,
    'Retrieved facts:',
    factLines,
    'In two sentences or fewer, give the SE the single most useful thing to say next.',
  ].join('\n\n');
};

export const buildSummaryPrompt = (options: { readonly fullTranscript: string }): string =>
  [
    'You are writing a post-call summary and follow-up email draft for a sales engineer.',
    'Full transcript:',
    options.fullTranscript,
    'Produce: a three-sentence summary, a list of open objections, and a short follow-up email draft.',
  ].join('\n\n');
```

- [ ] Run: `pnpm vitest run runner/test/prompt.test.ts` - expected PASS (3 tests).
- [ ] Commit: `git add demos/call-copilot/runner/src/prompt.ts demos/call-copilot/runner/test/prompt.test.ts && git commit -m "call-copilot: add prompt assembly"`

### Task 7: Latency math (pure logic)

- [ ] Write the failing test `demos/call-copilot/runner/test/timing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { suggestionLatencyMs, timeToFirstTokenMs } from '../src/timing';

describe('timeToFirstTokenMs', () => {
  it('subtracts request-sent time from first-delta time', () => {
    expect(timeToFirstTokenMs({ requestSentMs: 1_000, firstDeltaMs: 1_320 })).toBe(320);
  });

  it('throws if the first delta arrives before the request was sent', () => {
    expect(() => timeToFirstTokenMs({ requestSentMs: 1_000, firstDeltaMs: 900 })).toThrow();
  });
});

describe('suggestionLatencyMs', () => {
  it('subtracts utterance-end time from first-delta time', () => {
    expect(suggestionLatencyMs({ utteranceEndMs: 2_000, firstDeltaMs: 3_450 })).toBe(1_450);
  });

  it('throws if the first delta arrives before the utterance ended', () => {
    expect(() => suggestionLatencyMs({ utteranceEndMs: 2_000, firstDeltaMs: 1_999 })).toThrow();
  });
});
```

- [ ] Run: `pnpm vitest run runner/test/timing.test.ts` - expected FAIL (`Cannot find module '../src/timing'`).
- [ ] Write `demos/call-copilot/runner/src/timing.ts`:

```ts
const nonNegativeDelta = (laterMs: number, earlierMs: number, label: string): number => {
  const delta = laterMs - earlierMs;
  if (delta < 0) throw new Error(`${label}: later timestamp is before earlier timestamp`);
  return delta;
};

export const timeToFirstTokenMs = (options: { readonly requestSentMs: number; readonly firstDeltaMs: number }): number =>
  nonNegativeDelta(options.firstDeltaMs, options.requestSentMs, 'timeToFirstTokenMs');

export const suggestionLatencyMs = (options: { readonly utteranceEndMs: number; readonly firstDeltaMs: number }): number =>
  nonNegativeDelta(options.firstDeltaMs, options.utteranceEndMs, 'suggestionLatencyMs');
```

- [ ] Run: `pnpm vitest run runner/test/timing.test.ts` - expected PASS (4 tests).
- [ ] Commit: `git add demos/call-copilot/runner/src/timing.ts demos/call-copilot/runner/test/timing.test.ts && git commit -m "call-copilot: add latency math"`

### Task 8: TiDB knowledge base - schema, seed, and retrieval queries (thin I/O adapter, manual live run)

This task is I/O against a real TiDB cluster, so it is verified by manual live runs rather than TDD. **Before starting, resolve the full-text-search availability question from Section 4**: connect to your target TiDB (local playground first, since it is free) and try creating a full-text index.

- [ ] Manual check: confirm whether local `tiup playground` supports full-text search.

  ```bash
  bash infra/tidb/playground.sh &
  mysql --comments --host 127.0.0.1 --port 4000 -u root -e \
    "CREATE DATABASE IF NOT EXISTS lab; USE lab; CREATE TABLE ft_probe(id INT, t TEXT, FULLTEXT INDEX (t) WITH PARSER STANDARD);"
  ```

  Expected output if supported: `Query OK, 0 rows affected`. Expected output if not supported: an error naming full-text indexes as unsupported on this deployment. **If it fails**, stop using local playground for this demo: create a TiDB Cloud Starter instance in one of the five regions listed in Section 4, point `.env` at it, and set `TIDB_TLS=true` and `LAB_ENV_TIDB=TiDB Cloud Starter (<region>)`. Drop the probe table either way: `DROP TABLE lab.ft_probe;`.

- [ ] Write `demos/call-copilot/runner/src/seed-kb.ts`:

```ts
import { createTidbPool } from '@lab/runner-kit';
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';

type SeedFact = { readonly id: string; readonly category: string; readonly text: string };

const loadSeedFacts = (): readonly SeedFact[] =>
  JSON.parse(readFileSync(new URL('../../fixtures/kb-facts.json', import.meta.url), 'utf-8'));

const embed = async (openai: OpenAI, text: string): Promise<readonly number[]> => {
  const response = await openai.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
};

export const seedKnowledgeBase = async (): Promise<number> => {
  const pool = createTidbPool();
  const openai = new OpenAI();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_facts (
      id VARCHAR(64) PRIMARY KEY,
      category VARCHAR(64),
      text TEXT,
      embedding VECTOR(1536),
      FULLTEXT INDEX (text) WITH PARSER STANDARD,
      VECTOR INDEX idx_embedding ((VEC_COSINE_DISTANCE(embedding)))
    )
  `);
  const facts = loadSeedFacts();
  for (const fact of facts) {
    const vector = await embed(openai, fact.text);
    await pool.query('REPLACE INTO kb_facts (id, category, text, embedding) VALUES (?, ?, ?, ?)', [
      fact.id,
      fact.category,
      fact.text,
      JSON.stringify(vector),
    ]);
  }
  const [rows] = await pool.query('SELECT COUNT(*) AS n FROM kb_facts');
  await pool.end();
  return (rows as { readonly n: number }[])[0].n;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  seedKnowledgeBase().then((count) => {
    process.stdout.write(`seeded kb_facts: ${count} rows\n`);
  });
}
```

- [ ] Create `demos/call-copilot/fixtures/kb-facts.json` with at least 15 rows spanning categories `product-fact`, `proof-point`, `objection-answer`, and `competitive` - each `text` must be public TiDB docs content or a synthetic (invented, non-customer) call note, per the repository's public-content rule. Include one row per scripted trigger in the mock call (Task 10) so the eval set (Task 15) has a labeled target for each.
- [ ] Run: `cd demos/call-copilot && cp .env.example .env` (fill in real credentials), then `npx tsx runner/src/seed-kb.ts` - expected output: `seeded kb_facts: 15 rows` (or however many rows `kb-facts.json` contains).
- [ ] Write `demos/call-copilot/runner/src/kb.ts`:

```ts
import { z } from 'zod';
import { createTidbPool, timed } from '@lab/runner-kit';
import type { Pool } from 'mysql2/promise';
import { reciprocalRankFusion } from './fusion';

export type KbFact = { readonly id: string; readonly text: string };

export type RetrievalMode = 'vector' | 'fulltext' | 'hybrid';

const vectorQuery = async (pool: Pool, embedding: readonly number[], limit: number): Promise<readonly string[]> => {
  const [rows] = await pool.query(
    'SELECT id FROM kb_facts ORDER BY VEC_COSINE_DISTANCE(embedding, ?) LIMIT ?',
    [JSON.stringify(embedding), limit],
  );
  return IdRowsSchema.parse(rows).map((row) => row.id);
};

const IdRowsSchema = z.array(z.object({ id: z.string() }));
const KbFactRowsSchema = z.array(z.object({ id: z.string(), text: z.string() }));

const fulltextQuery = async (pool: Pool, query: string, limit: number): Promise<readonly string[]> => {
  const [rows] = await pool.query(
    'SELECT id FROM kb_facts WHERE FTS_MATCH_WORD(?, text) ORDER BY FTS_MATCH_WORD(?, text) DESC LIMIT ?',
    [query, query, limit],
  );
  return (rows as { readonly id: string }[]).map((row) => row.id);
};

const fetchFactsByIds = async (pool: Pool, ids: readonly string[]): Promise<readonly KbFact[]> => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(`SELECT id, text FROM kb_facts WHERE id IN (${placeholders})`, ids);
  const byId = new Map(KbFactRowsSchema.parse(rows).map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is KbFact => row !== undefined);
};

export type RetrieveResult = {
  readonly facts: readonly KbFact[];
  readonly vectorMs?: number;
  readonly fulltextMs?: number;
};

export const retrieve = async (options: {
  readonly pool: Pool;
  readonly mode: RetrievalMode;
  readonly queryText: string;
  readonly queryEmbedding: readonly number[];
  readonly topK: number;
}): Promise<RetrieveResult> => {
  if (options.mode === 'vector') {
    const { value: ids, ms } = await timed(() => vectorQuery(options.pool, options.queryEmbedding, options.topK));
    return { facts: await fetchFactsByIds(options.pool, ids), vectorMs: ms };
  }
  if (options.mode === 'fulltext') {
    const { value: ids, ms } = await timed(() => fulltextQuery(options.pool, options.queryText, options.topK));
    return { facts: await fetchFactsByIds(options.pool, ids), fulltextMs: ms };
  }
  const [vectorTimed, fulltextTimed] = await Promise.all([
    timed(() => vectorQuery(options.pool, options.queryEmbedding, 20)),
    timed(() => fulltextQuery(options.pool, options.queryText, 20)),
  ]);
  const fused = reciprocalRankFusion({
    vectorResults: vectorTimed.value,
    fulltextResults: fulltextTimed.value,
    k: 60,
  });
  const topIds = fused.slice(0, options.topK).map((row) => row.id);
  return {
    facts: await fetchFactsByIds(options.pool, topIds),
    vectorMs: vectorTimed.ms,
    fulltextMs: fulltextTimed.ms,
  };
};

export const openKbPool = (): Pool => createTidbPool();
```

- [ ] Manual run: with `kb_facts` seeded, run a quick smoke check from the demo folder:

  ```bash
  npx tsx -e "
  import { openKbPool, retrieve } from './runner/src/kb.ts';
  import OpenAI from 'openai';
  const openai = new OpenAI();
  const pool = openKbPool();
  const embedding = (await openai.embeddings.create({ model: 'text-embedding-3-small', input: 'Is TiDB MySQL compatible?' })).data[0].embedding;
  const result = await retrieve({ pool, mode: 'hybrid', queryText: 'Is TiDB MySQL compatible?', queryEmbedding: embedding, topK: 3 });
  console.log(result.facts.map((f) => f.id));
  await pool.end();
  "
  ```

  Expected output: an array of up to 3 fact ids, with the MySQL-compatibility fact from `kb-facts.json` in position 0.
- [ ] Commit: `git add demos/call-copilot/runner/src/kb.ts demos/call-copilot/runner/src/seed-kb.ts demos/call-copilot/fixtures/kb-facts.json && git commit -m "call-copilot: add TiDB knowledge base seed and hybrid retrieval"`

### Task 9: AssemblyAI streaming client (thin I/O adapter, manual live run)

**Vendor choice rationale:** AssemblyAI Universal-Streaming was chosen over Deepgram Nova-3 because its `Turn` message model (`end_of_turn`, `end_of_turn_confidence`, per-word timestamps) maps directly onto this demo's turn-window and latency-measurement design with no extra endpointing logic, and over local `whisper.cpp` because a hosted low-latency streaming endpoint avoids competing for CPU with the embedding and Claude calls on the presenter's laptop during a live demo. Deepgram remains a documented, equally viable swap (see Section 4) if a future rev wants a no-recurring-cost local fallback via `whisper.cpp`.

- [ ] Manual check: confirm the full raw message schema before writing the typed parser. With an AssemblyAI API key set as `ASSEMBLYAI_API_KEY`:

  ```bash
  npx tsx -e "
  import WebSocket from 'ws';
  const ws = new WebSocket('wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=universal-streaming-english', {
    headers: { Authorization: process.env.ASSEMBLYAI_API_KEY },
  });
  ws.on('message', (data) => console.log(data.toString()));
  ws.on('open', () => console.log('OPEN'));
  setTimeout(() => ws.close(), 5000);
  "
  ```

  Expected output: an `OPEN` line followed by at least one `Begin` JSON message. Record the exact field names of the `Begin` and any `Termination`/error messages you observe in this plan's section 4 row for the AssemblyAI schema (code stays comment-free), since Section 4 marks the full schema **UNVERIFIED** beyond the documented `Turn` fields.
- [ ] Write `demos/call-copilot/runner/src/asr-client.ts`:

```ts
import WebSocket from 'ws';
import { z } from 'zod';

export type AsrWord = { readonly text: string; readonly start: number; readonly end: number; readonly confidence: number };

export type AsrTurn = {
  readonly turnOrder: number;
  readonly transcript: string;
  readonly endOfTurn: boolean;
  readonly words: readonly AsrWord[];
};

export type AsrClient = {
  readonly sendAudio: (chunk: Buffer) => void;
  readonly onTurn: (handler: (turn: AsrTurn) => void) => void;
  readonly close: () => void;
};

const TurnMessageSchema = z.object({
  type: z.literal('Turn'),
  turn_order: z.number().default(0),
  transcript: z.string().default(''),
  end_of_turn: z.boolean().default(false),
  words: z
    .array(z.object({ text: z.string().default(''), start: z.number().default(0), end: z.number().default(0), confidence: z.number().default(0) }))
    .default([]),
});

const parseTurn = (raw: unknown): AsrTurn | undefined => {
  const parsed = TurnMessageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    turnOrder: parsed.data.turn_order,
    transcript: parsed.data.transcript,
    endOfTurn: parsed.data.end_of_turn,
    words: parsed.data.words,
  };
};

export const connectAsrClient = (options: { readonly apiKey: string; readonly speechModel: string }): AsrClient => {
  const url = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=${options.speechModel}`;
  const socket = new WebSocket(url, { headers: { Authorization: options.apiKey } });
  const handlers: ((turn: AsrTurn) => void)[] = [];
  socket.on('message', (data) => {
    const turn = parseTurn(JSON.parse(data.toString()));
    if (turn !== undefined) handlers.forEach((handler) => handler(turn));
  });
  return {
    sendAudio: (chunk) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
    },
    onTurn: (handler) => handlers.push(handler),
    close: () => socket.close(),
  };
};
```

- [ ] Manual run: pipe five seconds of any 16kHz mono PCM test file through the client and confirm at least one `Turn` with `endOfTurn: true` arrives:

  ```bash
  npx tsx -e "
  import { readFileSync } from 'node:fs';
  import { connectAsrClient } from './runner/src/asr-client.ts';
  const client = connectAsrClient({ apiKey: process.env.ASSEMBLYAI_API_KEY!, speechModel: 'universal-streaming-english' });
  client.onTurn((turn) => console.log(turn));
  const pcm = readFileSync('fixtures/mock-call.wav');
  client.sendAudio(pcm.subarray(44));
  setTimeout(() => client.close(), 8000);
  "
  ```

  Expected output: one or more `AsrTurn` objects logged, with the final one having `endOfTurn: true` and a non-empty `transcript`.
- [ ] Commit: `git add demos/call-copilot/runner/src/asr-client.ts && git commit -m "call-copilot: add AssemblyAI streaming client"`

### Task 10: Synthetic mock-call script and fixture audio (manual, generates a committed fixture)

- [ ] Write `demos/call-copilot/fixtures/mock-call-script.json`, a full two-person scripted dialogue (a prospect comparing TiDB with a competing managed database) with one line per turn, a `speaker` (`se` or `prospect`), the `text`, and an optional `expectedTrigger` (`question`, `competitor`, `objection`, `technical-term`, or omitted). Structure:

```json
[
  { "speaker": "se", "text": "Thanks for hopping on - before we start, I want to flag this call is being recorded by our copilot tool, text only, no audio retained beyond this session. Sound OK?" },
  { "speaker": "prospect", "text": "Yep, that's fine." },
  { "speaker": "se", "text": "Great, let's dig into your current setup." },
  { "speaker": "prospect", "text": "How does TiDB handle a node failure during a write-heavy period?", "expectedTrigger": "question" },
  { "speaker": "prospect", "text": "We are also looking at Aurora for this project.", "expectedTrigger": "competitor" },
  { "speaker": "prospect", "text": "Honestly, a distributed database like this seems like it would be too expensive for us.", "expectedTrigger": "objection" },
  { "speaker": "prospect", "text": "Can you explain how HTAP works in your architecture?", "expectedTrigger": "technical-term" },
  { "speaker": "se", "text": "Happy to. Any other questions before we wrap up?" },
  { "speaker": "prospect", "text": "No, that covers it for today, thanks." }
]
```

- [ ] Extend the eight scripted trigger lines to a full 3-6 minute call by adding non-triggering discovery small talk between them (the presenter narrates the phases in Section 2, so pacing should give each trigger a few seconds of visible processing time in the UI). Keep every line free of any real customer, prospect, or employee name, per the platform's public-repo rule.
- [ ] Generate the fixture audio with two distinct macOS voices:

  ```bash
  cd demos/call-copilot
  python3 - <<'PY'
  import json, subprocess
  script = json.load(open('fixtures/mock-call-script.json'))
  voice = {'se': 'Fred', 'prospect': 'Samantha'}
  for i, line in enumerate(script):
      subprocess.run(['say', '-v', voice[line['speaker']], '-o', f'fixtures/line-{i:02d}.aiff', line['text']], check=True)
  PY
  # Concatenate and convert to a single 16kHz mono WAV (sox installed in Task 11):
  sox fixtures/line-*.aiff fixtures/mock-call.wav rate 16000 channels 1
  rm fixtures/line-*.aiff
  ```

  Expected output: `fixtures/mock-call.wav` exists and `soxi fixtures/mock-call.wav` reports a 3-6 minute mono 16kHz file.
- [ ] Commit: `git add demos/call-copilot/fixtures/mock-call-script.json demos/call-copilot/fixtures/mock-call.wav && git commit -m "call-copilot: add synthetic mock-call script and fixture audio"`

### Task 11: Audio capture - BlackHole/sox mic source and fixture-file source (thin I/O adapter, manual live run)

- [ ] Manual check: confirm the local toolchain first.

  ```bash
  xcode-select -p
  brew install sox blackhole-2ch
  ```

  Expected output: `xcode-select -p` prints a path (e.g. `/Library/Developer/CommandLineTools`) with no error; `brew install` completes and reports `sox` and `blackhole-2ch` installed (or already installed). If `xcode-select -p` errors, run `xcode-select --install` first and re-check before continuing.
- [ ] Manual setup (one-time, documented in README, not scripted): open **Audio MIDI Setup**, create a Multi-Output Device containing both the Mac's normal output and **BlackHole 2ch**, and set that Multi-Output Device as the system output during a live call so the call audio is simultaneously heard and looped into BlackHole.
- [ ] Write `demos/call-copilot/runner/src/audio-capture.ts`:

```ts
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';

export type AudioSource = {
  readonly onChunk: (handler: (chunk: Buffer) => void) => void;
  readonly stop: () => void;
};

export const startMicCapture = (options: { readonly deviceName: string }): AudioSource => {
  const proc = spawn('rec', [
    '-q',
    '-t',
    'raw',
    '-r',
    '16000',
    '-e',
    'signed-integer',
    '-b',
    '16',
    '-c',
    '1',
    '-d',
    options.deviceName,
    '-',
  ]);
  const handlers: ((chunk: Buffer) => void)[] = [];
  proc.stdout.on('data', (chunk: Buffer) => handlers.forEach((handler) => handler(chunk)));
  return {
    onChunk: (handler) => handlers.push(handler),
    stop: () => proc.kill('SIGTERM'),
  };
};

export const startFixtureCapture = (options: { readonly wavPath: string; readonly chunkBytes: number }): AudioSource => {
  const stream = createReadStream(options.wavPath, { start: 44, highWaterMark: options.chunkBytes });
  const handlers: ((chunk: Buffer) => void)[] = [];
  stream.on('data', (chunk) => {
    if (Buffer.isBuffer(chunk)) handlers.forEach((handler) => handler(chunk));
  });
  return {
    onChunk: (handler) => handlers.push(handler),
    stop: () => stream.close(),
  };
};
```

- [ ] Manual run (fixture source, no hardware dependency): 

  ```bash
  npx tsx -e "
  import { startFixtureCapture } from './runner/src/audio-capture.ts';
  const source = startFixtureCapture({ wavPath: 'fixtures/mock-call.wav', chunkBytes: 3200 });
  let bytes = 0;
  source.onChunk((chunk) => { bytes += chunk.length; });
  setTimeout(() => { console.log('bytes read:', bytes); source.stop(); }, 3000);
  "
  ```

  Expected output: `bytes read: <a positive number>`.
- [ ] Manual run (mic source, requires the Multi-Output Device set up above and a real or test call playing): run `sox -t coreaudio -d` (no args) or `system_profiler SPAudioDataType` to find the exact BlackHole device name to pass as `deviceName`, then repeat the same smoke check using `startMicCapture({ deviceName: 'BlackHole 2ch' })` for 3 seconds while audio is playing, confirming `bytes read` is positive and roughly proportional to elapsed time at 16kHz * 2 bytes/sample.
- [ ] Commit: `git add demos/call-copilot/runner/src/audio-capture.ts && git commit -m "call-copilot: add BlackHole/sox mic capture and fixture playback capture"`

### Task 12: Runner main.ts - wire capture, ASR, retrieval, suggestion, lab events

- [ ] Write `demos/call-copilot/runner/main.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createEmitter, onControl } from '@lab/runner-kit';
import { createTurnWindow } from './src/window';
import { detectTrigger } from './src/triggers';
import { openKbPool, retrieve, type RetrievalMode } from './src/kb';
import { buildSuggestionPrompt } from './src/prompt';
import { timeToFirstTokenMs, suggestionLatencyMs } from './src/timing';
import { redactPII } from './src/redact';
import { connectAsrClient } from './src/asr-client';
import { startFixtureCapture, startMicCapture } from './src/audio-capture';

const emitter = createEmitter();
const window = createTurnWindow({ windowMs: 60_000 });
const pool = openKbPool();
const openai = new OpenAI();
const anthropic = new Anthropic();

let retrievalMode: RetrievalMode = 'hybrid';
const cycleRetrievalMode = (): void => {
  retrievalMode = retrievalMode === 'vector' ? 'fulltext' : retrievalMode === 'fulltext' ? 'hybrid' : 'vector';
};

emitter.log('info', 'Recording is announced and consent is required before capture starts.');
emitter.check('consent-given', 'pass');
emitter.phase('consent');

const runSuggestion = async (triggerText: string, utteranceEndMs: number): Promise<void> => {
  const trigger = detectTrigger(triggerText);
  if (trigger.kind === 'none') return;

  emitter.phase(
    trigger.kind === 'question'
      ? 'question-trigger'
      : trigger.kind === 'competitor'
        ? 'competitor-trigger'
        : trigger.kind === 'objection'
          ? 'objection-trigger'
          : 'technical-trigger',
  );

  const embeddingResponse = await openai.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    input: redactPII(triggerText),
  });
  const result = await retrieve({
    pool,
    mode: retrievalMode,
    queryText: redactPII(triggerText),
    queryEmbedding: embeddingResponse.data[0].embedding,
    topK: 5,
  });
  if (result.vectorMs !== undefined) emitter.metric('vector-latency-p50', result.vectorMs);
  if (result.fulltextMs !== undefined) emitter.metric('fulltext-latency-p50', result.fulltextMs);
  emitter.flow('trigger-tidb', 1);
  emitter.flow('tidb-suggest', result.facts.length);

  const prompt = buildSuggestionPrompt({ trigger, recentTranscript: redactPII(window.joinedText()), facts: result.facts });
  const requestSentMs = emitter.elapsedMs();
  const stream = anthropic.messages.stream({
    model: process.env.ANTHROPIC_SUGGEST_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  let firstDeltaMs: number | undefined;
  stream.on('streamEvent', (event) => {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && firstDeltaMs === undefined) {
      firstDeltaMs = emitter.elapsedMs();
      emitter.metric('llm-ttft-ms', timeToFirstTokenMs({ requestSentMs, firstDeltaMs }));
      emitter.metric('suggestion-latency-ms', suggestionLatencyMs({ utteranceEndMs, firstDeltaMs }));
    }
  });
  await stream.finalMessage();
  emitter.metric('suggestions-shown', 1);
  emitter.flow('suggest-overlay', 1);
};

onControl((controlId) => {
  emitter.log('info', `control: ${controlId}`);
  if (controlId === 'toggle-retrieval-mode') cycleRetrievalMode();
  if (controlId === 'inject-objection') {
    void runSuggestion('Honestly, this seems like it would be too expensive for us.', emitter.elapsedMs());
  }
});

const source =
  process.env.AUDIO_SOURCE === 'mic'
    ? startMicCapture({ deviceName: 'BlackHole 2ch' })
    : startFixtureCapture({ wavPath: 'fixtures/mock-call.wav', chunkBytes: 3200 });

const asr = connectAsrClient({
  apiKey: process.env.ASSEMBLYAI_API_KEY ?? '',
  speechModel: process.env.ASSEMBLYAI_SPEECH_MODEL ?? 'universal-streaming-english',
});

const turnStartedAtMs = emitter.elapsedMs();
source.onChunk((chunk) => {
  asr.sendAudio(chunk);
  emitter.flow('mic-asr', 1);
});

asr.onTurn((turn) => {
  if (!turn.endOfTurn || turn.transcript.trim().length === 0) return;
  const lastWordEnd = turn.words.length > 0 ? turn.words[turn.words.length - 1].end : 0;
  const receivedAtMs = emitter.elapsedMs();
  emitter.metric('asr-latency-ms', receivedAtMs - (turnStartedAtMs + lastWordEnd));
  emitter.flow('asr-trigger', 1);
  window.add({ speaker: 'prospect', text: turn.transcript, endedAtMs: turnStartedAtMs + lastWordEnd });
  void runSuggestion(turn.transcript, turnStartedAtMs + lastWordEnd);
});

emitter.phase('discovery');
```

- [ ] Manual run: `AUDIO_SOURCE=fixture npx tsx runner/main.ts | head -50` - expected output: a stream of newline-delimited JSON `lab` events (`log`, `check`, `phase`, `flow`, `metric`) starting with the `consent-given` check and `consent` phase, followed by `discovery`, with no thrown exceptions in the first 50 lines.
- [ ] Commit: `git add demos/call-copilot/runner/main.ts && git commit -m "call-copilot: wire runner main.ts"`

### Task 13: Post-call summary and follow-up draft (thin I/O adapter, manual live run)

- [ ] Write `demos/call-copilot/runner/src/summarize-call.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'mysql2/promise';
import { buildSummaryPrompt } from './prompt';
import { redactPII } from './redact';

export const summarizeCall = async (options: {
  readonly pool: Pool;
  readonly callId: string;
  readonly fullTranscript: string;
}): Promise<string> => {
  const anthropic = new Anthropic();
  const redacted = redactPII(options.fullTranscript);
  const message = await anthropic.messages.create({
    model: process.env.ANTHROPIC_SUMMARY_MODEL ?? 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildSummaryPrompt({ fullTranscript: redacted }) }],
  });
  const summaryText = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  await options.pool.query(
    `CREATE TABLE IF NOT EXISTS call_summaries (
      call_id VARCHAR(64) PRIMARY KEY,
      transcript TEXT,
      summary TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await options.pool.query('REPLACE INTO call_summaries (call_id, transcript, summary) VALUES (?, ?, ?)', [
    options.callId,
    redacted,
    summaryText,
  ]);
  return summaryText;
};
```

- [ ] Manual run:

  ```bash
  npx tsx -e "
  import { openKbPool } from './runner/src/kb.ts';
  import { summarizeCall } from './runner/src/summarize-call.ts';
  const pool = openKbPool();
  const summary = await summarizeCall({ pool, callId: 'mock-call-1', fullTranscript: 'se: Thanks for joining.\nprospect: How does TiDB handle failover?\nse: Great question...' });
  console.log(summary);
  await pool.end();
  "
  ```

  Expected output: non-empty summary text printed to the terminal, and `SELECT * FROM call_summaries WHERE call_id = 'mock-call-1';` in the MySQL CLI returns one row with that same summary.
- [ ] Commit: `git add demos/call-copilot/runner/src/summarize-call.ts && git commit -m "call-copilot: add post-call summary and follow-up draft"`

### Task 14: Redaction-at-rest and retention purge (thin I/O adapter, manual live run)

- [ ] Write `demos/call-copilot/runner/src/retention.ts`:

```ts
import type { Pool } from 'mysql2/promise';

export const purgeExpiredTranscripts = async (options: { readonly pool: Pool; readonly retentionDays: number }): Promise<number> => {
  const [result] = await options.pool.query(
    'DELETE FROM call_summaries WHERE created_at < NOW() - INTERVAL ? DAY',
    [options.retentionDays],
  );
  return (result as { readonly affectedRows: number }).affectedRows;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { openKbPool } = await import('./kb.js');
  const pool = openKbPool();
  const retentionDays = Number(process.env.TRANSCRIPT_RETENTION_DAYS ?? '30');
  const purged = await purgeExpiredTranscripts({ pool, retentionDays });
  process.stdout.write(`purged ${purged} expired call_summaries rows (retention: ${retentionDays} days)\n`);
  await pool.end();
}
```

- [ ] Manual run: insert one intentionally old-dated test row, then purge it.

  ```bash
  mysql --comments --host 127.0.0.1 --port 4000 -u root lab -e \
    "INSERT INTO call_summaries (call_id, transcript, summary, created_at) VALUES ('old-test', 'x', 'y', NOW() - INTERVAL 40 DAY);"
  npx tsx runner/src/retention.ts
  mysql --comments --host 127.0.0.1 --port 4000 -u root lab -e "SELECT call_id FROM call_summaries WHERE call_id = 'old-test';"
  ```

  Expected output: `purged 1 expired call_summaries rows (retention: 30 days)` and the final `SELECT` returns zero rows.
- [ ] Commit: `git add demos/call-copilot/runner/src/retention.ts && git commit -m "call-copilot: add transcript retention purge"`

### Task 15: Hybrid retrieval eval set (pure logic over fixture data)

- [ ] Create `demos/call-copilot/runner/test/eval/triggers.json` with one row per scripted trigger in `fixtures/mock-call-script.json`, each mapping the trigger's `text` to the `id` of the `kb-facts.json` row it should retrieve first, for example:

```json
[
  { "triggerText": "How does TiDB handle a node failure during a write-heavy period?", "expectedFactId": "failover-fact" },
  { "triggerText": "We are also looking at Aurora for this project.", "expectedFactId": "aurora-battlecard" },
  { "triggerText": "Honestly, a distributed database like this seems like it would be too expensive for us.", "expectedFactId": "cost-objection-answer" },
  { "triggerText": "Can you explain how HTAP works in your architecture?", "expectedFactId": "htap-fact" }
]
```

- [ ] Write the failing test `demos/call-copilot/runner/test/eval/hybrid-eval.test.ts` (this test talks to the real seeded TiDB, so it is skipped unless `TIDB_HOST` is set - it is the automated form of the `hybrid-eval` manifest check):

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { openKbPool, retrieve } from '../../src/kb';

const evalRows = JSON.parse(readFileSync(new URL('./triggers.json', import.meta.url), 'utf-8')) as {
  readonly triggerText: string;
  readonly expectedFactId: string;
}[];

const runIfConfigured = process.env.TIDB_HOST ? describe : describe.skip;

runIfConfigured('hybrid retrieval eval set', () => {
  it('returns the expected fact first for every scripted trigger', async () => {
    const pool = openKbPool();
    const openai = new OpenAI();
    let matched = 0;
    for (const row of evalRows) {
      const embedding = (
        await openai.embeddings.create({ model: 'text-embedding-3-small', input: row.triggerText })
      ).data[0].embedding;
      const result = await retrieve({ pool, mode: 'hybrid', queryText: row.triggerText, queryEmbedding: embedding, topK: 1 });
      if (result.facts[0]?.id === row.expectedFactId) matched += 1;
    }
    await pool.end();
    expect(matched).toBe(evalRows.length);
  });
});
```

- [ ] Run: `TIDB_HOST=127.0.0.1 pnpm vitest run runner/test/eval/hybrid-eval.test.ts` - expected FAIL initially if `kb-facts.json` and `mock-call-script.json` triggers do not yet line up one-to-one with `triggers.json`'s `expectedFactId` values.
- [ ] Adjust `kb-facts.json` wording (not the eval set's expectations) until the retrieval genuinely surfaces the intended fact first for every row - this is the honest fix: the fact text must be distinctive enough for both vector and full-text search to find it, not a loosened assertion.
- [ ] Run: `TIDB_HOST=127.0.0.1 pnpm vitest run runner/test/eval/hybrid-eval.test.ts` - expected PASS (all rows matched).
- [ ] Commit: `git add demos/call-copilot/runner/test/eval && git commit -m "call-copilot: add hybrid retrieval eval set"`

### Task 16: README and TALK-TRACK

- [ ] Write `demos/call-copilot/README.md`:

```markdown
# Call Copilot

Live retrieval-grounded suggestions for sales engineers and account executives, backed by TiDB hybrid search (vector + full-text) as the single retrieval memory.

## What it proves

- One TiDB table serves both the vector query and the full-text query behind a live suggestion.
- Reciprocal Rank Fusion, implemented in this runner (not a vendor SDK), measurably beats either search mode alone on a labeled eval set.
- The whole path - trigger detection, hybrid retrieval, and a streamed Claude suggestion - fits inside a live call's pacing, tracked against a configurable latency target.
- Call history (summary, follow-up draft) lands in the same TiDB database as the knowledge base.

## Prerequisites

See Section 5 of `docs/plans/12-call-copilot.md` for accounts, local tools, cost model, and teardown. In short: a TiDB Cloud Starter instance in a full-text-search-enabled region, an AssemblyAI key, an Anthropic key, an OpenAI key, `sox` + BlackHole for live mic capture (not required for the fixture-driven mock call).

## Run

\`\`\`bash
cp .env.example .env   # fill in credentials
npx tsx runner/src/seed-kb.ts
pnpm lab run call-copilot
\`\`\`

Open the UI, press "Start mock call". By default (`AUDIO_SOURCE=fixture`) it plays the committed synthetic mock-call audio; set `AUDIO_SOURCE=mic` to run it live against a real call routed through a BlackHole Multi-Output Device.

## Record

\`\`\`bash
pnpm lab run call-copilot --record
\`\`\`

Then promote the newest file under `demos/call-copilot/traces/` to `traces/featured.json` once it looks right (see Section 8 of the plan).

## Consent and privacy

This tool requires announcing recording and getting consent before capture starts (see the `consent-given` check). It never writes raw audio to disk - audio is streamed directly to the ASR vendor and discarded. Transcripts are redacted for emails and phone numbers before being sent to any LLM or stored, and are purged after `TRANSCRIPT_RETENTION_DAYS` (see `runner/src/retention.ts`). Some jurisdictions require all-party consent to record a call - confirm your own legal requirements before using this against a real call; this plan states the mechanism, not legal advice.

## Teardown

See Section 5 of the plan for exact commands (`tiup clean lab`, dropping the TiDB Cloud Starter database, rotating API keys).
```

- [ ] Write `demos/call-copilot/TALK-TRACK.md`:

```markdown
# Call Copilot - Talk Track

## Per-phase presenter script

- **Consent:** "Every call this tool touches starts with an explicit consent announcement - that's not a feature we bolted on, it's the first thing that has to happen before a single audio byte is captured."
- **Discovery:** "Right now the SE and prospect are just talking. Nothing lights up until the copilot recognizes something worth surfacing - it's not narrating the whole call."
- **Question trigger:** "There's a direct question. Watch the diagram: the trigger detector fires, TiDB runs a vector query and a full-text query at the same time, fuses them, and Claude Haiku streams a suggestion - all inside about two seconds."
- **Competitor trigger:** "The prospect just named a competitor. The retrieval scope automatically shifts toward battlecard content - same database, same query shape, different rows come back on top."
- **Objection trigger:** "This is the objection that trips up newer SEs. The copilot has the honest, pre-written answer ready before the SE has to think of one."
- **Technical trigger:** "A technical term surfaces a documentation-grounded fact, not an improvised explanation."
- **Wrap-up:** "When the call ends, Claude Sonnet writes the summary and follow-up draft straight back into the same TiDB database the facts came from."

## Discovery questions (for a real conversation about this tool)

1. "Walk me through what your SEs currently do to find the right proof point mid-call - is it memory, a shared doc, or Slack-ing a teammate?"
2. "How many live product/competitive calls does your SE team run in a typical week?"
3. "If a suggestion showed up two seconds late, would that still be useful, or does it need to be closer to instant?"
4. "Who owns the knowledge base this would draw from today - is it centralized or scattered across docs, Slack, and tribal knowledge?"
5. "What's your policy today on recording and retaining call audio or transcripts?"

## Objections and honest answers

1. **"This just sounds like a wrapper around an LLM."** Partly true - the value here isn't the LLM call, it's that retrieval is grounded in a single database doing both semantic and keyword search fast enough to matter mid-call, with a measured eval set proving hybrid beats either mode alone.
2. **"Won't this just tell the SE to say something wrong?"** It can, which is why every suggestion cites which facts it drew from, and the honest answer is explicit in the prompt: "if no facts are retrieved, say so plainly rather than guessing."
3. **"What about compliance/legal risk from recording calls?"** This demo requires an explicit consent step before capture, never stores raw audio, redacts PII from transcripts before they reach any LLM, and purges transcripts after a configurable retention window - it does not replace your own legal review of call-recording law in your jurisdictions.
4. **"Doesn't a human SE already know all this?"** Experienced SEs do; the tool's real value is ramping newer SEs and covering the "objection you get once a quarter and always fumble" case, not replacing expertise.
5. **"How is this different from your gtm-copilot-oss project?"** That project is a broader after-the-fact RAG assistant (pre-call research, post-call MEDDPICC coaching, follow-up drafting) that already runs hybrid retrieval over Drive and call transcripts in TiDB; this demo narrows to the live, in-call moment - streaming ASR, sub-few-second trigger-to-suggestion latency, and a labeled retrieval eval set - and is built on this repository's shared lab platform so it can be recorded and replayed on the demo site.
```

- [ ] Commit: `git add demos/call-copilot/README.md demos/call-copilot/TALK-TRACK.md && git commit -m "call-copilot: add README and talk track"`

## 8. Recording the featured trace

- [ ] Confirm `.env` points at the real TiDB Cloud Starter instance used for full-text search (not local playground, per Task 8's finding) and that `kb_facts` is seeded (`SELECT COUNT(*) FROM kb_facts;` should match `kb-facts.json`'s row count).
- [ ] Set `LAB_ENV_TIDB` to the exact string printed by the TiDB Cloud console for that instance's version, and `LAB_ENV_NOTES` to note `AUDIO_SOURCE=fixture` was used (the recorded run plays the committed synthetic mock-call audio, not a live mic).
- [ ] Run: `pnpm lab run call-copilot --record`.
- [ ] From the UI (or by pressing `start-mock-call` via the relay's `/control/start-mock-call` route), start the run and let the full mock call play to completion, including at least one press of `inject-objection` and one press of `toggle-retrieval-mode` so the recording demonstrates all three controls.
- [ ] A good run looks like: every phase in Section 2 appears in order at least once, `consent-given` and `no-raw-audio` both show `pass`, `hybrid-eval` shows `pass` with `observed` reporting all rows matched, and `suggestion-latency-p99` shows `pass` against `SUGGESTION_LATENCY_TARGET_MS`. If `suggestion-latency-p99` fails, do not loosen the target in `.env` to make it pass - investigate whether the embedding call, the retrieval queries, or the Claude call is the slow step (each has its own metric) and fix that step, or re-run once network conditions improve.
- [ ] Stop the run (Ctrl-C) once the wrap-up phase's summary write completes; confirm the new file under `demos/call-copilot/traces/<ISO timestamp>.json`.
- [ ] Promote it: `cp demos/call-copilot/traces/<ISO timestamp>.json demos/call-copilot/traces/featured.json`.
- [ ] Run: `pnpm lab validate call-copilot` - expected output: no schema errors and no `eventReferenceErrors` for any event in `featured.json`.
- [ ] Run: `pnpm lab check-public` - expected output: no denylisted terms or internal URLs found across the demo's published files (manifest, README, TALK-TRACK, featured trace).
- [ ] Commit: `git add demos/call-copilot/traces/featured.json && git commit -m "call-copilot: record featured trace"`

## 9. Risks and gotchas

- **Full-text search region/tier availability may change.** As of this writing it is Starter-only in five regions and explicitly called "early stages." Re-check https://docs.pingcap.com/ai/vector-search-full-text-search-sql/ before every re-recording of the featured trace, and update Section 4 and `.env.example`'s `LAB_ENV_NOTES` guidance if it changes.
- **AssemblyAI message schema beyond `Turn` is UNVERIFIED in this plan.** Task 9's manual check must run before trusting `asr-client.ts`'s parser against anything beyond the documented `Turn` fields; if `Begin`/`Termination`/error message field names differ from what's logged, update the parser and this plan's Section 4 entry together.
- **BlackHole + Multi-Output Device setup is a manual, one-time system configuration step**, not something this plan can script safely (it changes the presenter's system audio output). If it's missing or misconfigured during a live demo, `AUDIO_SOURCE=fixture` is the safe fallback and still tells the full story.
- **Claude streaming SDK event shapes can change between SDK versions.** The `streamEvent` handler in `main.ts` assumes `content_block_delta` events carry `delta.type: 'text_delta'` as documented in Section 4; pin the `@anthropic-ai/sdk` version in `package.json` and re-verify against the streaming docs URL if upgrading.
- **The embedding call is on the critical path for every suggestion.** `suggestion-latency-ms` includes the OpenAI embedding round trip before retrieval even starts; if that call is consistently the slow step, consider caching embeddings for repeated trigger phrases in the eval set, or moving to a lower-latency embedding endpoint - this is a legitimate follow-up, not something to silently work around by loosening the latency target.
- **Never let a real customer name, transcript, or employee name into `kb-facts.json`, `mock-call-script.json`, or a recorded trace.** This repository is public; every fact and every line of the mock call must be public TiDB docs content or clearly invented, and `pnpm lab check-public` is the automated backstop, not the only check - review by eye before committing new fixture content.
- **Consent is a mechanism, not legal advice.** Some jurisdictions require all-party consent to record; this plan's `consent-given` check proves the tool announces and gates on consent, it does not certify legal compliance in any given jurisdiction. Say this plainly in the README rather than implying otherwise.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.

### Packet 12-V1: Verify open facts before building
- Tasks: none (docs only)
- Depends on: 00-P10   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/12-call-copilot.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):
  - Every product capability this demo relies on, with the official doc URL checked while writing this plan. Anything not confirmed is marked **UNVERIFIED** with the exact step to confirm it before building.
  - | This plan chooses **BlackHole + `sox`** over a ScreenCaptureKit Swift helper as the primary audio-capture path specifically to avoid Swift/Xcode/code-signing complexity for a first version; ScreenCaptureKit remains a documented, UNVERIFIED-for-this-plan future upgrade path | n/a (design decision) 
  - | The exact full JSON schema of every AssemblyAI streaming message type (`Begin`, `Turn`, `Termination`, error payloads) beyond the `Turn` fields listed above | https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket | **UNVERIFIED** - confirm the full message schema by opening one re
  - | Whether the local `infra/tidb/playground.sh` (`tiup playground`) build of TiDB supports `FULLTEXT INDEX` / `FTS_MATCH_WORD` at all, given the docs describe full-text search as Starter-only in specific regions | https://docs.pingcap.com/ai/vector-search-full-text-search-sql/ | **UNVERIFIED** - conf
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/12-call-copilot.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.

### Packet 12-P1: Scaffold the demo folder and manifest
- Tasks: 1
- Depends on: 12-V1   Shared runtime: tidb-playground
- Files owned: `integrations/demos/call-copilot/.env.example`, `integrations/demos/call-copilot/manifest.json`, `integrations/demos/call-copilot/package.json`, `integrations/demos/call-copilot/test/manifest.test.ts`, `integrations/demos/call-copilot/tsconfig.json`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/call-copilot/.env.example` -> 8
- Done when: Task 1's steps are all checked off and the gate output matches.

### Packet 12-P2: PII redaction (pure logic)
- Tasks: 2
- Depends on: 12-P1   Shared runtime: none
- Files owned: `integrations/demos/call-copilot/runner/src/redact.ts`, `integrations/demos/call-copilot/runner/test/redact.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm vitest run runner/test/redact.test.ts` -> PASS (4 tests)
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 2's steps are all checked off and the gate output matches.

### Packet 12-P3: Rolling transcript turn window (pure logic)
- Tasks: 3
- Depends on: 12-P2   Shared runtime: none
- Files owned: `integrations/demos/call-copilot/runner/src/window.ts`, `integrations/demos/call-copilot/runner/test/window.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm vitest run runner/test/window.test.ts` -> PASS (4 tests)
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 3's steps are all checked off and the gate output matches.

### Packet 12-P4: Trigger detector (pure logic)
- Tasks: 4
- Depends on: 12-P3   Shared runtime: none
- Files owned: `integrations/demos/call-copilot/runner/src/triggers.ts`, `integrations/demos/call-copilot/runner/test/triggers.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm vitest run runner/test/triggers.test.ts` -> PASS (6 tests)
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 4's steps are all checked off and the gate output matches.

### Packet 12-P5: Reciprocal Rank Fusion (pure logic)
- Tasks: 5
- Depends on: 12-P4   Shared runtime: none
- Files owned: `integrations/demos/call-copilot/runner/src/fusion.ts`, `integrations/demos/call-copilot/runner/test/fusion.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm vitest run runner/test/fusion.test.ts` -> PASS (5 tests)
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 5's steps are all checked off and the gate output matches.

### Packet 12-P6: Prompt assembly (pure logic)
- Tasks: 6
- Depends on: 12-P5   Shared runtime: none
- Files owned: `integrations/demos/call-copilot/runner/src/prompt.ts`, `integrations/demos/call-copilot/runner/test/prompt.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm vitest run runner/test/prompt.test.ts` -> PASS (3 tests)
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 6's steps are all checked off and the gate output matches.

### Packet 12-P7: Latency math (pure logic)
- Tasks: 7
- Depends on: 12-P6   Shared runtime: none
- Files owned: `integrations/demos/call-copilot/runner/src/timing.ts`, `integrations/demos/call-copilot/runner/test/timing.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm vitest run runner/test/timing.test.ts` -> PASS (4 tests)
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 7's steps are all checked off and the gate output matches.

### Packet 12-P8: TiDB knowledge base - schema, seed, and retrieval queries (thin I/O adapter, manual live run)
- Tasks: 8
- Depends on: 12-P7   Shared runtime: cloud-account
- Files owned: `integrations/demos/call-copilot/fixtures/kb-facts.json`, `integrations/demos/call-copilot/runner/src/kb.ts`, `integrations/demos/call-copilot/runner/src/seed-kb.ts`
- Model: sonnet   Effort: M
- Gate:
  - `cd demos/call-copilot && cp .env.example .env` -> `seeded kb_facts: 15 rows` (or however many rows `kb-facts.json` contains)
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 8's steps are all checked off and the gate output matches.

### Packet 12-P9: AssemblyAI streaming client (thin I/O adapter, manual live run)
- Tasks: 9
- Depends on: 12-P8   Shared runtime: tidb-playground
- Files owned: `integrations/demos/call-copilot/runner/src/asr-client.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 12-P10: Synthetic mock-call script and fixture audio (manual, generates a committed fixture)
- Tasks: 10
- Depends on: 12-P9   Shared runtime: audio (coordinator only, user present for consent)
- Files owned: `integrations/demos/call-copilot/fixtures/mock-call-script.json`, `integrations/demos/call-copilot/fixtures/mock-call.wav`
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 10 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 10's steps are all checked off and the gate output matches.

### Packet 12-P11: Audio capture - BlackHole/sox mic source and fixture-file source (thin I/O adapter, manual live run)
- Tasks: 11
- Depends on: 12-P10   Shared runtime: audio (coordinator only, user present for consent)
- Files owned: `integrations/demos/call-copilot/runner/src/audio-capture.ts`
- Model: coordinator   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 11's steps are all checked off and the gate output matches.

### Packet 12-P12: Runner main.ts - wire capture, ASR, retrieval, suggestion, lab events
- Tasks: 12
- Depends on: 12-P11   Shared runtime: audio (coordinator only, user present for consent)
- Files owned: `integrations/demos/call-copilot/runner/main.ts`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 12's steps are all checked off and the gate output matches.

### Packet 12-P13: Post-call summary and follow-up draft (thin I/O adapter, manual live run)
- Tasks: 13
- Depends on: 12-P12   Shared runtime: none
- Files owned: `integrations/demos/call-copilot/runner/src/summarize-call.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 13's steps are all checked off and the gate output matches.

### Packet 12-P14: Redaction-at-rest and retention purge (thin I/O adapter, manual live run)
- Tasks: 14
- Depends on: 12-P13   Shared runtime: none
- Files owned: `integrations/demos/call-copilot/runner/src/retention.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 14's steps are all checked off and the gate output matches.

### Packet 12-P15: Hybrid retrieval eval set (pure logic over fixture data)
- Tasks: 15
- Depends on: 12-P14   Shared runtime: none
- Files owned: `integrations/demos/call-copilot/runner/test/eval/hybrid-eval.test.ts`, `integrations/demos/call-copilot/runner/test/eval/triggers.json`
- Model: sonnet   Effort: S
- Gate:
  - `TIDB_HOST=127.0.0.1 pnpm vitest run runner/test/eval/hybrid-eval.test.ts` -> PASS (all rows matched)
  - `pnpm --filter @lab/demo-call-copilot typecheck` -> exit 0
- Done when: Task 15's steps are all checked off and the gate output matches.

### Packet 12-P16: README and TALK-TRACK
- Tasks: 16
- Depends on: 12-P15   Shared runtime: audio (coordinator only, user present for consent)
- Files owned: `integrations/demos/call-copilot/README.md`, `integrations/demos/call-copilot/TALK-TRACK.md`, `integrations/demos/call-copilot/traces`
- Model: coordinator   Effort: M
- Gate:
  - `grep -c $'\u2014' integrations/demos/call-copilot/README.md integrations/demos/call-copilot/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
- Done when: Task 16's steps are all checked off and the gate output matches.

### Packet 12-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 12-P16   Shared runtime: cloud-account
- Files owned: `integrations/demos/call-copilot/traces/featured.json`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm lab validate call-copilot` -> `call-copilot: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.

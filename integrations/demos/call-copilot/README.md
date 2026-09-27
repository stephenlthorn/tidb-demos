# Call Copilot

Live retrieval-grounded suggestions for sales engineers and account executives, backed by TiDB hybrid search (vector + full-text) as the single retrieval memory.

## What it proves

- One TiDB table serves both the vector query and the full-text query behind a live suggestion.
- Reciprocal Rank Fusion, implemented in this runner (not a vendor SDK), is scored against a labeled eval set so hybrid retrieval's accuracy is measured, not assumed.
- The whole path - trigger detection, hybrid retrieval, and a streamed Claude suggestion - fits inside a live call's pacing, tracked against a configurable latency target.
- Call history (summary, follow-up draft) lands in the same TiDB database as the knowledge base, so there is no separate CRM sync step.

## Prerequisites

See Section 5 of `docs/plans/12-call-copilot.md` for accounts, local tools, cost model, and teardown. In short: a TiDB Cloud instance in a full-text-search-enabled region (see the current region list at the TiDB full-text search docs before provisioning, since this plan's own verification step found it is not available on a local `tiup playground` build), an AssemblyAI key, an Anthropic key, an OpenAI key, and `sox` + BlackHole for live mic capture (not required for the fixture-driven mock call).

## Run

```bash
cp .env.example .env   # fill in credentials
npx tsx runner/src/seed-kb.ts
pnpm lab run call-copilot
```

Open the UI and press "Start mock call". By default (`AUDIO_SOURCE=fixture`) it plays the committed synthetic mock-call audio fixture; set `AUDIO_SOURCE=mic` to run it live against a real call routed through a BlackHole Multi-Output Device (see the one-time Audio MIDI Setup step below). Press "Toggle retrieval mode" to compare vector-only, full-text-only, and hybrid suggestions live, and "Inject objection" to force the objection trigger on demand.

## Live mic setup (one-time, manual)

1. `xcode-select -p` to confirm Command Line Tools are installed (run `xcode-select --install` first if not).
2. `brew install sox blackhole-2ch`.
3. Open **Audio MIDI Setup**, create a Multi-Output Device containing both the Mac's normal output and **BlackHole 2ch**, and set that Multi-Output Device as the system output during a live call so the call audio is simultaneously heard and looped into BlackHole.
4. Set `AUDIO_SOURCE=mic` and `AUDIO_MIC_DEVICE_NAME` (default `BlackHole 2ch`) in `.env`.

This step is deliberately not scripted, since it changes the presenter's system audio output. If it is missing or misconfigured during a live demo, `AUDIO_SOURCE=fixture` is the safe fallback and still tells the full story.

## Record

```bash
pnpm lab run call-copilot --record
```

Then promote the newest file under `demos/call-copilot/traces/` to `traces/featured.json` once it looks right (see Section 8 of the plan).

## Consent and privacy

This tool requires announcing recording and getting consent before capture starts (see the `consent-given` check, which passes before the first audio chunk reaches ASR). It never writes raw audio to disk - audio is streamed directly to the ASR vendor and discarded (the `no-raw-audio` check scans the demo folder for stray `.wav`/`.pcm`/`.raw` files outside the committed `fixtures/` directory). Transcripts are redacted for emails and phone numbers before being sent to any LLM or stored, and are purged after `TRANSCRIPT_RETENTION_DAYS` (see `runner/src/retention.ts`). Some jurisdictions require all-party consent to record a call - confirm your own legal requirements before using this against a real call; this plan states the mechanism, not legal advice.

## Teardown

See Section 5 of the plan for exact commands (`tiup clean lab`, dropping the TiDB database used for this demo, rotating the AssemblyAI/Anthropic/OpenAI API keys). Cost details for TiDB Cloud, AssemblyAI, and Anthropic are not repeated here since they change over time; see https://www.pingcap.com/pricing/, https://www.assemblyai.com/pricing, and https://platform.claude.com/docs/en/about-claude/pricing for current rates.

## Known gaps in this build

This build was assembled without live systems (no TiDB cluster, no AssemblyAI/Anthropic/OpenAI API calls, no audio capture). Every I/O adapter (`runner/src/kb.ts`, `runner/src/seed-kb.ts`, `runner/src/asr-client.ts`, `runner/src/audio-capture.ts`, `runner/src/summarize-call.ts`, `runner/src/retention.ts`) and `runner/main.ts` are checked by `typecheck` only; they have not been exercised against real credentials. Before recording the featured trace, run every "Manual run" and "Manual check" step in Section 7, Tasks 8-14 of `docs/plans/12-call-copilot.md` against real accounts, in particular the full-text-search availability check (Task 8) and the AssemblyAI message schema check (Task 9), both marked UNVERIFIED in Section 4 as of this build. `fixtures/mock-call.wav` has not been generated (script only, per this build's scope); generate it with the `say`/`sox` steps in Task 10 before a live or recorded run with `AUDIO_SOURCE=fixture`.

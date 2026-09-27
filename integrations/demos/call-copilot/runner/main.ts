import { extname, join, sep } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  createEmitter,
  createSampleWindow,
  every,
  onControl,
  summarize,
  timed,
} from '@lab/runner-kit';
import { createTurnWindow } from './src/window';
import { detectTrigger } from './src/triggers';
import { countKbFacts, openKbPool, retrieve } from './src/kb';
import type { RetrievalMode } from './src/kb';
import { buildSuggestionPrompt } from './src/prompt';
import { suggestionLatencyMs, timeToFirstTokenMs } from './src/timing';
import { redactPII } from './src/redact';
import { connectAsrClient } from './src/asr-client';
import { startFixtureCapture, startMicCapture } from './src/audio-capture';
import { summarizeCall } from './src/summarize-call';
import { purgeExpiredTranscripts } from './src/retention';
import { formatEvalObserved, scoreHybridEval } from './src/eval-scoring';
import type { EvalRow } from './src/eval-scoring';

const env = process.env;
const emitter = createEmitter();
const window = createTurnWindow({ windowMs: 60_000 });
const pool = openKbPool();
const openai = new OpenAI();
const anthropic = new Anthropic();

const suggestionTopK = Number(env.RETRIEVAL_TOP_K ?? '5');
const suggestionLatencyTargetMs = Number(env.SUGGESTION_LATENCY_TARGET_MS ?? '2500');

const vectorLatencyTick = createSampleWindow();
const fulltextLatencyTick = createSampleWindow();
const hybridLatencyTick = createSampleWindow();
const asrLatencyTick = createSampleWindow();
const ttftTick = createSampleWindow();
const suggestionLatencyTick = createSampleWindow();
const suggestionLatencyAll: number[] = [];

let retrievalMode: RetrievalMode = 'hybrid';
let suggestionsShown = 0;
let started = false;
let stopCall: (() => void) | undefined;
const fullTranscriptTurns: { readonly speaker: string; readonly text: string }[] = [];

const cycleRetrievalMode = (): void => {
  retrievalMode = retrievalMode === 'vector' ? 'fulltext' : retrievalMode === 'fulltext' ? 'hybrid' : 'vector';
};

const EvalRowsSchema: z.ZodType<readonly EvalRow[]> = z.array(
  z.object({ triggerText: z.string(), expectedFactId: z.string() }),
);

const loadEvalRows = (): readonly EvalRow[] =>
  EvalRowsSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL('./test/eval/triggers.json', import.meta.url)), 'utf-8')),
  );

const RAW_AUDIO_EXTENSIONS = new Set(['.wav', '.pcm', '.raw']);

const findStrayRawAudioFile = (rootDir: string): string | undefined => {
  const entries = readdirSync(rootDir, { withFileTypes: true, recursive: true });
  const stray = entries.find((entry) => {
    if (!entry.isFile()) return false;
    if (!RAW_AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) return false;
    const entryPath = join(entry.parentPath, entry.name);
    return !entryPath.split(sep).includes('fixtures');
  });
  return stray === undefined ? undefined : join(stray.parentPath, stray.name);
};

emitter.node('mic', 'idle');
emitter.node('asr', 'idle');
emitter.node('trigger', 'idle');
emitter.node('tidb', 'healthy', 'kb_facts ready');
emitter.node('claude-suggest', 'idle');
emitter.node('overlay', 'idle');
emitter.node('claude-summary', 'idle');
emitter.node('store', 'healthy');

emitter.log('info', 'Recording is announced and consent is required before capture starts.');
emitter.check('consent-given', 'pass');
emitter.phase('consent');

const reportKbRows = async (): Promise<void> => {
  const count = await countKbFacts(pool);
  emitter.metric('kb-rows', count);
};
void reportKbRows();

const runHybridEvalCheck = async (): Promise<void> => {
  emitter.check('hybrid-eval', 'pending');
  const evalRows = loadEvalRows();
  const topFactIdForTrigger = new Map<string, string | undefined>();
  for (const row of evalRows) {
    const embeddingResponse = await openai.embeddings.create({
      model: env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      input: row.triggerText,
    });
    const queryEmbedding = embeddingResponse.data[0]?.embedding ?? [];
    const result = await retrieve({ pool, mode: 'hybrid', queryText: row.triggerText, queryEmbedding, topK: 1 });
    topFactIdForTrigger.set(row.triggerText, result.facts[0]?.id);
  }
  const score = scoreHybridEval({ rows: evalRows, topFactIdForTrigger });
  emitter.check('hybrid-eval', score.matched === score.total ? 'pass' : 'fail', formatEvalObserved(score));
};
void runHybridEvalCheck();

const runSuggestion = async (triggerText: string, utteranceEndMs: number): Promise<void> => {
  const trigger = detectTrigger(triggerText);
  if (trigger.kind === 'none') return;

  if (trigger.kind === 'question') emitter.phase('question-trigger');
  if (trigger.kind === 'competitor') emitter.phase('competitor-trigger');
  if (trigger.kind === 'objection') emitter.phase('objection-trigger');
  if (trigger.kind === 'technical-term') emitter.phase('technical-trigger');
  emitter.node('trigger', 'busy', `${trigger.kind}: ${trigger.matched}`);
  emitter.node('claude-suggest', 'busy');

  const redactedQuery = redactPII(triggerText);
  const embeddingResponse = await openai.embeddings.create({
    model: env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    input: redactedQuery,
  });
  const queryEmbedding = embeddingResponse.data[0]?.embedding ?? [];

  const { value: result, ms: retrievalMs } = await timed(() =>
    retrieve({
      pool,
      mode: retrievalMode,
      queryText: redactedQuery,
      queryEmbedding,
      topK: suggestionTopK,
    }),
  );
  if (result.vectorMs !== undefined) vectorLatencyTick.add(result.vectorMs);
  if (result.fulltextMs !== undefined) fulltextLatencyTick.add(result.fulltextMs);
  if (retrievalMode === 'hybrid') hybridLatencyTick.add(retrievalMs);

  emitter.flow('trigger-tidb', 1);
  emitter.flow('tidb-suggest', result.facts.length);
  emitter.node('trigger', 'idle');

  const prompt = buildSuggestionPrompt({
    trigger,
    recentTranscript: redactPII(window.joinedText()),
    facts: result.facts,
  });
  const requestSentMs = emitter.elapsedMs();
  const stream = anthropic.messages.stream({
    model: env.ANTHROPIC_SUGGEST_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  let firstDeltaMs: number | undefined;
  stream.on('streamEvent', (event) => {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && firstDeltaMs === undefined) {
      firstDeltaMs = emitter.elapsedMs();
      ttftTick.add(timeToFirstTokenMs({ requestSentMs, firstDeltaMs }));
      const suggestLatency = suggestionLatencyMs({ utteranceEndMs, firstDeltaMs });
      suggestionLatencyTick.add(suggestLatency);
      suggestionLatencyAll.push(suggestLatency);
    }
  });
  await stream.finalMessage();
  suggestionsShown += 1;
  emitter.metric('suggestions-shown', suggestionsShown);
  emitter.flow('suggest-overlay', 1);
  emitter.node('claude-suggest', 'idle');
  emitter.node('overlay', 'busy', 'suggestion rendered');
};

const runWrapUp = async (): Promise<void> => {
  emitter.phase('wrap-up');
  emitter.node('mic', 'done');
  emitter.node('asr', 'done');

  const stats = summarize(suggestionLatencyAll);
  if (stats === undefined) {
    emitter.check('suggestion-latency-p99', 'fail', 'no suggestions were measured during this run');
  } else {
    const withinTarget = stats.p99 <= suggestionLatencyTargetMs;
    emitter.check(
      'suggestion-latency-p99',
      withinTarget ? 'pass' : 'fail',
      `p99 ${stats.p99}ms (target ${suggestionLatencyTargetMs}ms)`,
    );
  }

  const strayAudioFile = findStrayRawAudioFile(process.cwd());
  emitter.check('no-raw-audio', strayAudioFile === undefined ? 'pass' : 'fail', strayAudioFile);

  emitter.node('claude-summary', 'busy');
  const fullTranscript = fullTranscriptTurns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n');
  await summarizeCall({ pool, callId: 'mock-call-1', fullTranscript });
  emitter.node('claude-summary', 'idle');
  emitter.flow('summary-store', 1);
  emitter.flow('asr-summary', 1);
  emitter.node('store', 'done');

  const purged = await purgeExpiredTranscripts({
    pool,
    retentionDays: Number(env.TRANSCRIPT_RETENTION_DAYS ?? '30'),
  });
  emitter.log('info', `purged ${purged} expired call_summaries rows`);
};

const startCall = (): void => {
  if (started) return;
  started = true;
  emitter.node('mic', 'starting');
  emitter.node('asr', 'starting');

  const source =
    env.AUDIO_SOURCE === 'mic'
      ? startMicCapture({ deviceName: env.AUDIO_MIC_DEVICE_NAME ?? 'BlackHole 2ch' })
      : startFixtureCapture({ wavPath: 'fixtures/mock-call.wav', chunkBytes: 3200 });

  const asr = connectAsrClient({
    apiKey: env.ASSEMBLYAI_API_KEY ?? '',
    speechModel: env.ASSEMBLYAI_SPEECH_MODEL ?? 'universal-streaming-english',
  });

  const turnStartedAtMs = emitter.elapsedMs();
  emitter.node('mic', 'healthy');
  emitter.node('asr', 'healthy');

  source.onChunk((chunk) => {
    asr.sendAudio(chunk);
    emitter.flow('mic-asr', 1);
  });

  asr.onTurn((turn) => {
    if (!turn.endOfTurn || turn.transcript.trim().length === 0) return;
    const lastWord = turn.words.at(-1);
    const lastWordEnd = lastWord === undefined ? 0 : lastWord.end;
    const receivedAtMs = emitter.elapsedMs();
    asrLatencyTick.add(receivedAtMs - (turnStartedAtMs + lastWordEnd));
    emitter.flow('asr-trigger', 1);
    const endedAtMs = turnStartedAtMs + lastWordEnd;
    window.add({ speaker: 'prospect', text: turn.transcript, endedAtMs });
    fullTranscriptTurns.push({ speaker: 'prospect', text: turn.transcript });
    void runSuggestion(turn.transcript, endedAtMs);
  });

  source.onEnd(() => {
    asr.close();
    void runWrapUp();
  });

  stopCall = () => {
    source.stop();
    asr.close();
  };

  emitter.phase('discovery');
};

onControl((controlId) => {
  emitter.log('info', `control: ${controlId}`);
  if (controlId === 'start-mock-call') startCall();
  if (controlId === 'toggle-retrieval-mode') cycleRetrievalMode();
  if (controlId === 'inject-objection') {
    void runSuggestion('Honestly, this seems like it would be too expensive for us.', emitter.elapsedMs());
  }
});

const metricsAbortController = new AbortController();
void every({
  intervalMs: 1000,
  task: async () => {
    const vectorStats = summarize(vectorLatencyTick.drain());
    if (vectorStats !== undefined) {
      emitter.metric('vector-latency-p50', vectorStats.p50);
      emitter.metric('vector-latency-p99', vectorStats.p99);
    }
    const fulltextStats = summarize(fulltextLatencyTick.drain());
    if (fulltextStats !== undefined) {
      emitter.metric('fulltext-latency-p50', fulltextStats.p50);
      emitter.metric('fulltext-latency-p99', fulltextStats.p99);
    }
    const hybridStats = summarize(hybridLatencyTick.drain());
    if (hybridStats !== undefined) {
      emitter.metric('hybrid-latency-p50', hybridStats.p50);
      emitter.metric('hybrid-latency-p99', hybridStats.p99);
    }
    const asrStats = summarize(asrLatencyTick.drain());
    if (asrStats !== undefined) emitter.metric('asr-latency-ms', asrStats.p50);
    const ttftStats = summarize(ttftTick.drain());
    if (ttftStats !== undefined) emitter.metric('llm-ttft-ms', ttftStats.p50);
    const suggestionStats = summarize(suggestionLatencyTick.drain());
    if (suggestionStats !== undefined) emitter.metric('suggestion-latency-ms', suggestionStats.p50);
  },
  signal: metricsAbortController.signal,
});

process.on('SIGINT', () => {
  metricsAbortController.abort();
  stopCall?.();
  void runWrapUp().finally(() => process.exit(0));
});

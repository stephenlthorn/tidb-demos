import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rfc3339Second, runCli } from '@lab/agent-stack-kit';
import { DemoManifestSchema, eventReferenceErrors, parseEventLine, type DemoEvent } from '@lab/contract';
import { createEmitter } from '@lab/runner-kit';
import manifestJson from '../../manifest.json';
import { runConfigFromEnv } from '../src/config';
import { loadAttemptScripts } from '../src/fixtureStore';
import { createRunner } from '../src/runner';
import {
  createFakeBranches,
  createFakeBranchSql,
  createFakeLake,
  createFakeOrg,
  createFakeRun,
  createFakeSink,
  createFakeTiFs,
} from './fakes';

const manifest = DemoManifestSchema.parse(manifestJson);
const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));

const env = {
  AGENT_ORG_CLUSTER_ID: 'org-1',
  AGENT_FIXTURE_CLUSTER_ID: 'fix-1',
  FIXTURE_SQL_USER: 'reader',
  FIXTURE_SQL_PASSWORD: 'pw',
  S3_BUCKET: 'lab-bucket',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  LAKE_WAREHOUSE: 'agent-coding-wh',
  STEP_WAIT_MS: '0',
  STAGE_PAUSE_MS: '0',
  HISTORY_RUNS: '5',
};

const play = async (options: { readonly autoRun: boolean; readonly controls: readonly string[] }) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-coding-run-'));
  try {
    const config = runConfigFromEnv(
      { ...env, WORK_DIR: join(root, 'work'), AUTO_RUN: options.autoRun ? 'true' : 'false' },
      { fixturesDir, now: new Date('2026-10-17T10:00:00Z'), homeDir: root },
    );
    const lines: string[] = [];
    const fs = createFakeTiFs(join(root, 'fake-fs'));
    const fakeBranches = createFakeBranches();
    const org = createFakeOrg();
    const sink = createFakeSink();
    const saved: unknown[] = [];
    const runner = createRunner({
      config,
      env: { TIDB_DATABASE: 'agent_coding' },
      emitter: createEmitter({ write: (line) => lines.push(line) }),
      orgPool: org.sql,
      tiFs: fs.tiFs,
      branches: fakeBranches.branches,
      lake: createFakeLake({ lines: sink.lines, ledgerRows: () => org.ledger.length }),
      lakeBootstrap: createFakeLake({ lines: sink.lines, ledgerRows: () => 0 }),
      sink: sink.sink,
      run: createFakeRun(),
      scripts: await loadAttemptScripts(fixturesDir),
      sleep: async () => undefined,
      openBranchPool: () => createFakeBranchSql(),
      saveState: async (state) => {
        saved.push(state);
      },
    });
    await runner.start();
    options.controls.forEach((control) => runner.onControl(control));
    await runner.idle();
    const events: DemoEvent[] = lines.flatMap((line) => {
      const parsed = parseEventLine(line);
      return parsed.ok ? [parsed.event] : [];
    });
    const remote = join(config.workDir, 'remote.git');
    const refs = await runCli({ bin: 'git', args: ['--git-dir', remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'] });
    return {
      lines,
      events,
      fs,
      org,
      sink,
      created: fakeBranches.created,
      pushedBranches: refs.stdout.split('\n').filter((name) => name !== '').sort(),
      saved,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const lastCheckStatuses = (events: readonly DemoEvent[]): Record<string, string> =>
  Object.fromEntries(events.flatMap((event) => (event.type === 'check' ? [[event.id, event.status]] : [])));

describe('the whole run against in-memory stand-ins for the three services', () => {
  it('emits only ids that the manifest declares and every line parses', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.events).toHaveLength(run.lines.length);
    expect(run.events.flatMap((event) => eventReferenceErrors(manifest, event))).toEqual([]);
  });

  it('walks the nine phases in order', async () => {
    const run = await play({ autoRun: true, controls: [] });
    const phases = run.events.flatMap((event) => (event.type === 'phase' ? [event.phase] : []));
    expect([...new Set(phases)]).toEqual(manifest.phases.map((phase) => phase.id));
  });

  it('emits every metric, every edge and a status for every node', async () => {
    const run = await play({ autoRun: true, controls: [] });
    const metrics = new Set(run.events.flatMap((event) => (event.type === 'metric' ? [event.id] : [])));
    const edges = new Set(run.events.flatMap((event) => (event.type === 'flow' ? [event.edge] : [])));
    const nodes = new Set(run.events.flatMap((event) => (event.type === 'node' ? [event.node] : [])));
    expect(manifest.metrics.map((metric) => metric.id).filter((id) => !metrics.has(id))).toEqual([]);
    expect(manifest.edges.map((edge) => edge.id).filter((id) => !edges.has(id))).toEqual([]);
    expect(manifest.nodes.map((node) => node.id).filter((id) => !nodes.has(id))).toEqual([]);
  });

  it('passes every check', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(lastCheckStatuses(run.events)).toEqual({
      'layer-isolation': 'pass',
      'fork-branches-identical': 'pass',
      'journal-verified': 'pass',
      'replay-reproduces': 'pass',
      'lake-count-matches': 'pass',
      'lesson-recalled': 'pass',
    });
  });

  it('opens a pull request for attempt 1 and never commits a layer', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.pushedBranches).toEqual(['fix/KIT-8812-attempt-1', 'main']);
    expect(run.fs.calls).not.toContain('commitLayer');
  });

  it('writes one ledger row per step and one event per step plus finishes and a marker', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.org.ledger).toHaveLength(7 + 7 + 9);
    const live = run.sink.lines.filter((line) => line.includes('"source":"live"'));
    expect(live).toHaveLength(7 + 7 + 9 + 3 + 1);
    const lastEmitted = run.events.filter((event) => event.type === 'metric' && event.id === 'events-emitted').at(-1);
    expect(lastEmitted).toMatchObject({ value: 27 });
  });

  it('creates three attempt branches and a replay branch at the step timestamp', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.created).toHaveLength(4);
    const replay = run.created[3];
    expect(replay?.name).toBe('run-20261017-100000-replay');
    expect(replay?.parentId).toBe('br_2');
    expect(replay?.parentTimestamp).toBe(rfc3339Second('2026-10-17T10:00:08.250Z'));
  });

  it('forks the replay layer from the failed attempt step-07 checkpoint', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.fs.calls.filter((call) => call.startsWith('forkLayer'))).toEqual([
      'forkLayer lyr_1 seed',
      'forkLayer lyr_1 seed',
      'forkLayer lyr_1 seed',
      'forkLayer lyr_3 step-07',
    ]);
  });

  it('journals the run and writes a lesson that mentions the failed attempt', async () => {
    const run = await play({ autoRun: true, controls: [] });
    const types = run.fs.journal.map((entry) => entry.type);
    expect(types).toEqual(expect.arrayContaining(['run.started', 'memory.recalled', 'step.completed', 'pr.pushed', 'step.replayed', 'lesson.written']));
    const lesson = run.org.memories.find((memory) => memory.kind === 'lesson');
    expect(lesson?.content).toContain('attempt-2 failed at step 7 with ECONNRESET');
  });

  it('lets attempt 3 win when the flaky dependency takes attempt 1 down', async () => {
    const run = await play({ autoRun: false, controls: ['inject-flaky-dependency', 'fan-out'] });
    expect(run.pushedBranches).toEqual(['fix/KIT-8812-attempt-3', 'main']);
  });

  it('refuses a replay before the fan-out and says why', async () => {
    const run = await play({ autoRun: false, controls: ['replay-failed-step'] });
    expect(run.events.some((event) => event.type === 'log' && event.msg === 'replay-failed-step: press fan-out first')).toBe(true);
    expect(run.fs.calls.filter((call) => call.startsWith('forkLayer'))).toEqual([]);
  });

  it('records state after each resource is created', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.saved.length).toBeGreaterThan(5);
  });
});

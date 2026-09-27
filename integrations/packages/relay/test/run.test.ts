import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TraceSchema } from '@lab/contract';
import { manifestInput } from '@lab/contract/testing';
import { runDemo } from '../src/run';

const ECHO_RUNNER = [
  "import { createInterface } from 'node:readline';",
  "const out = (event, done) => process.stdout.write(JSON.stringify(event) + '\\n', done);",
  "out({ type: 'phase', t: 0, phase: 'warmup' });",
  "createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const { control } = JSON.parse(line);",
  "  out({ type: 'log', t: 1, level: 'info', msg: 'got ' + control }, () => process.exit(0));",
  '});',
].join('\n');

const makeEchoDemo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'lab-run-'));
  const dir = join(root, 'demos', 'example');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'runner.mjs'), ECHO_RUNNER);
  await writeFile(join(dir, '.env'), 'LAB_ENV_TIDB=none (echo test)\n');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifestInput({ runner: { command: [process.execPath, 'runner.mjs'] } })));
  return root;
};

describe('runDemo', () => {
  it('streams runner output, forwards controls and records a valid trace', async () => {
    const root = await makeEchoDemo();
    const handle = await runDemo({ root, id: 'example', record: true, port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await fetch(`${handle.url}/control/burst`, { method: 'POST' })).status).toBe(202);
    const result = await handle.finished;
    expect(result.exitCode).toBe(0);
    const trace = TraceSchema.parse(JSON.parse(await readFile(result.tracePath ?? '', 'utf8')));
    expect(trace.environment.tidb).toBe('none (echo test)');
    expect(trace.events.map((event) => event.type)).toEqual(['phase', 'log', 'control']);
    expect(trace.events.some((event) => event.type === 'log' && event.msg === 'got burst')).toBe(true);
  }, 15000);
});

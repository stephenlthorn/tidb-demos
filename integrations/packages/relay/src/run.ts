import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DemoEvent, DemoManifest } from '@lab/contract';
import { loadDemoEnv, loadManifest } from './demo-files';
import { createHub } from './hub';
import { controlLine, stderrEvent, toLabEvent } from './lines';
import { demoDir } from './paths';
import { createRelayServer, parseOrigins } from './server';
import { buildTrace, traceFileName } from './trace-builder';

export type RunResult = { readonly exitCode: number; readonly tracePath: string | undefined };
export type RunHandle = { readonly url: string; readonly finished: Promise<RunResult>; readonly stop: () => void };

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    });
  });

const writeTrace = async (options: {
  readonly dir: string;
  readonly manifest: DemoManifest;
  readonly events: readonly DemoEvent[];
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<string> => {
  const recordedAt = new Date();
  const trace = buildTrace({ manifest: options.manifest, events: options.events, recordedAt, env: options.env });
  const path = join(options.dir, 'traces', traceFileName(recordedAt));
  await mkdir(join(options.dir, 'traces'), { recursive: true });
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`);
  return path;
};

export const runDemo = async (options: {
  readonly root: string;
  readonly id: string;
  readonly record: boolean;
  readonly port: number;
}): Promise<RunHandle> => {
  const dir = demoDir(options.root, options.id);
  const manifest = await loadManifest(dir);
  const env = { ...process.env, ...(await loadDemoEnv(dir)) };
  const started = performance.now();
  const now = (): number => Math.round(performance.now() - started);
  const hub = createHub();
  const [command, ...args] = manifest.runner.command;
  if (command === undefined) throw new Error('runner.command is empty');
  const child = spawn(command, args, { cwd: join(dir, manifest.runner.cwd), env, stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: child.stdout }).on('line', (line) => hub.publish(toLabEvent(manifest, line, now())));
  createInterface({ input: child.stderr }).on('line', (line) => hub.publish(stderrEvent(line, now())));
  const server = createRelayServer({
    manifest,
    hub,
    sendControl: (id) => {
      child.stdin.write(controlLine(id));
    },
    allowedOrigins: parseOrigins(env.LAB_ALLOWED_ORIGINS),
    now,
    runId: Date.now().toString(36),
  });
  const port = await listen(server, options.port);
  const finished = new Promise<RunResult>((resolve, reject) => {
    child.on('close', (code) => {
      const tracePath = options.record ? writeTrace({ dir, manifest, events: hub.events(), env }) : Promise.resolve(undefined);
      tracePath.then((path) => {
        server.closeAllConnections();
        server.close();
        resolve({ exitCode: code ?? 0, tracePath: path });
      }, reject);
    });
  });
  return { url: `http://localhost:${port}`, finished, stop: () => { child.kill('SIGINT'); } };
};

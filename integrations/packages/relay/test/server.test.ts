import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { createHub } from '../src/hub';
import { createRelayServer, parseOrigins } from '../src/server';

const startServer = async () => {
  const hub = createHub();
  const sent: string[] = [];
  const server = createRelayServer({
    manifest: aManifest(),
    hub,
    sendControl: (id) => { sent.push(id); },
    allowedOrigins: ['http://localhost:5173'],
    now: () => 123,
    runId: 'run1',
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { hub, sent, base: `http://127.0.0.1:${port}`, close };
};

const readUntil = async (response: Response, done: (text: string) => boolean): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  const step = async (text: string): Promise<string> => {
    if (done(text)) return text;
    const chunk = await reader.read();
    if (chunk.done) return text;
    return step(text + decoder.decode(chunk.value));
  };
  const text = await step('');
  await reader.cancel();
  return text;
};

describe('relay server', () => {
  it('reports health', async () => {
    const relay = await startServer();
    const body: unknown = await (await fetch(`${relay.base}/health`)).json();
    expect(body).toEqual({ ok: true, demo: 'example' });
    await relay.close();
  });

  it('replays history to a late subscriber, then streams live events', async () => {
    const relay = await startServer();
    relay.hub.publish({ type: 'phase', t: 0, phase: 'warmup' });
    const response = await fetch(`${relay.base}/events`);
    relay.hub.publish({ type: 'metric', t: 1000, id: 'ingest-rate', value: 7 });
    const text = await readUntil(response, (soFar) => (soFar.match(/^data: /gm) ?? []).length >= 2);
    expect(text).toContain('"phase":"warmup"');
    expect(text).toContain('"value":7');
    await relay.close();
  });

  it('resumes after Last-Event-ID instead of replaying the whole run', async () => {
    const relay = await startServer();
    relay.hub.publish({ type: 'phase', t: 0, phase: 'warmup' });
    relay.hub.publish({ type: 'metric', t: 1000, id: 'ingest-rate', value: 1 });
    relay.hub.publish({ type: 'metric', t: 2000, id: 'ingest-rate', value: 2 });
    const response = await fetch(`${relay.base}/events`, { headers: { 'last-event-id': 'run1.1' } });
    const text = await readUntil(response, (soFar) => soFar.includes('"value":2'));
    expect(text).toContain('id: run1.2');
    expect(text).not.toContain('"phase":"warmup"');
    expect(text).not.toContain('"value":1');
    await relay.close();
  });

  it('replays the whole run to a browser still holding an id from a previous run', async () => {
    const relay = await startServer();
    relay.hub.publish({ type: 'phase', t: 0, phase: 'warmup' });
    const response = await fetch(`${relay.base}/events`, { headers: { 'last-event-id': 'run0.300' } });
    const text = await readUntil(response, (soFar) => soFar.includes('warmup'));
    expect(text).toContain('id: run1.0');
    await relay.close();
  });

  it('forwards a known control to the runner and records it', async () => {
    const relay = await startServer();
    const response = await fetch(`${relay.base}/control/burst`, { method: 'POST' });
    expect(response.status).toBe(202);
    expect(relay.sent).toEqual(['burst']);
    expect(relay.hub.events()).toEqual([{ type: 'control', t: 123, id: 'burst' }]);
    await relay.close();
  });

  it('rejects an unknown control', async () => {
    const relay = await startServer();
    expect((await fetch(`${relay.base}/control/launch`, { method: 'POST' })).status).toBe(404);
    expect(relay.sent).toEqual([]);
    await relay.close();
  });

  it('echoes CORS only for allowed origins', async () => {
    const relay = await startServer();
    const allowed = await fetch(`${relay.base}/health`, { headers: { origin: 'http://localhost:5173' } });
    const denied = await fetch(`${relay.base}/health`, { headers: { origin: 'https://evil.example' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    await relay.close();
  });
});

describe('parseOrigins', () => {
  it('defaults to the Vite dev server and splits a list', () => {
    expect(parseOrigins(undefined)).toEqual(['http://localhost:5173']);
    expect(parseOrigins('https://a.example, https://b.example')).toEqual(['https://a.example', 'https://b.example']);
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { formatSseId, type DemoManifest } from '@lab/contract';
import type { Hub } from './hub';
import { resumeIndex, sseMessage } from './lines';

export type RelayServerOptions = {
  readonly manifest: DemoManifest;
  readonly hub: Hub;
  readonly sendControl: (id: string) => void;
  readonly allowedOrigins: readonly string[];
  readonly now: () => number;
  readonly runId: string;
};

export const parseOrigins = (value: string | undefined): readonly string[] =>
  (value ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const applyCors = (req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): void => {
  const origin = req.headers.origin;
  if (origin === undefined || !allowed.includes(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
};

const streamEvents = (req: IncomingMessage, res: ServerResponse, hub: Hub, runId: string): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const lastEventId = req.headers['last-event-id'];
  const from = resumeIndex(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId, runId);
  hub.events().forEach((event, index) => {
    if (index >= from) res.write(sseMessage(event, formatSseId(runId, index)));
  });
  const unsubscribe = hub.subscribe((event, index) => res.write(sseMessage(event, formatSseId(runId, index))));
  req.on('close', unsubscribe);
};

const controlIdFrom = (path: string): string | undefined => /^\/control\/([a-z0-9-]+)$/.exec(path)?.[1];

export const createRelayServer = (options: RelayServerOptions): Server =>
  createServer((req, res) => {
    applyCors(req, res, options.allowedOrigins);
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' });
      res.end();
      return;
    }
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, demo: options.manifest.id });
    if (req.method === 'GET' && path === '/manifest') return sendJson(res, 200, options.manifest);
    if (req.method === 'GET' && path === '/events') return streamEvents(req, res, options.hub, options.runId);
    const id = req.method === 'POST' ? controlIdFrom(path) : undefined;
    if (id === undefined) return sendJson(res, 404, { error: 'not found' });
    if (!options.manifest.controls.some((control) => control.id === id)) return sendJson(res, 404, { error: `unknown control: ${id}` });
    options.sendControl(id);
    options.hub.publish({ type: 'control', t: options.now(), id });
    return sendJson(res, 202, { ok: true, control: id });
  });

import { eventReferenceErrors, parseEventLine, parseSseId, type DemoEvent, type DemoManifest } from '@lab/contract';

const warning = (t: number, msg: string): DemoEvent => ({ type: 'log', t, level: 'warn', msg });

export const toLabEvent = (manifest: DemoManifest, line: string, t: number): DemoEvent => {
  const parsed = parseEventLine(line);
  if (!parsed.ok) return warning(t, `invalid event: ${parsed.error}`);
  if (parsed.event.type === 'control') return warning(t, 'invalid event: runners may not emit control events');
  const errors = eventReferenceErrors(manifest, parsed.event);
  if (errors.length > 0) return warning(t, `invalid event: ${errors.join('; ')}`);
  return parsed.event;
};

export const stderrEvent = (line: string, t: number): DemoEvent => warning(t, line);

export const controlLine = (id: string): string => `${JSON.stringify({ control: id })}\n`;

export const sseMessage = (event: DemoEvent, id: string): string => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;

export const resumeIndex = (lastEventId: string | undefined, runId: string): number => {
  const parsed = parseSseId(lastEventId);
  if (parsed === undefined || parsed.runId !== runId) return 0;
  return parsed.index + 1;
};

import { eventReferenceErrors, parseEventLine, type DemoEvent, type DemoManifest } from '@lab/contract';

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

export const sseMessage = (event: DemoEvent): string => `data: ${JSON.stringify(event)}\n\n`;

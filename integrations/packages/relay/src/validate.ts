import { eventReferenceErrors, type DemoEvent, type DemoManifest, type Trace } from '@lab/contract';

export type ValidationReport = {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly eventCount: number;
};

const isSortedByTime = (events: readonly DemoEvent[]): boolean =>
  events.every((event, index) => index === 0 || (events[index - 1]?.t ?? 0) <= event.t);

export const validateTrace = (current: DemoManifest, trace: Trace): ValidationReport => ({
  errors: [
    ...(trace.manifest.id === current.id ? [] : [`trace belongs to ${trace.manifest.id}, not ${current.id}`]),
    ...trace.events.flatMap((event, index) =>
      eventReferenceErrors(trace.manifest, event).map((message) => `event ${index}: ${message}`),
    ),
    ...(isSortedByTime(trace.events) ? [] : ['events are not sorted by t']),
    ...(trace.events.some((event) => event.type === 'phase') ? [] : ['trace has no phase events']),
  ],
  warnings:
    JSON.stringify(trace.manifest) === JSON.stringify(current)
      ? []
      : ['manifest changed since this trace was recorded; re-record before publishing'],
  eventCount: trace.events.length,
});

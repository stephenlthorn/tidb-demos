import { formatClock } from '../format';
import type { LogEntry } from '../state/demo-state';

export const LogConsole = ({ logs }: { readonly logs: readonly LogEntry[] }) => (
  <details className="logs">
    <summary>{`Log (${logs.length})`}</summary>
    <ol>
      {logs.slice(-50).map((entry, index) => (
        <li key={`${entry.t}-${index}`} data-level={entry.level}>
          <time>{formatClock(entry.t)}</time> {entry.msg}
        </li>
      ))}
    </ol>
  </details>
);

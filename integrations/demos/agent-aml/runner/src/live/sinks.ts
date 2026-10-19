import type { S3EventSink } from '@lab/agent-stack-kit';

export type RowSink = {
  readonly emit: (row: object) => void;
  readonly flush: () => Promise<number>;
};

export const createRowSink = (sink: S3EventSink): RowSink => {
  let pending: readonly string[] = [];
  return {
    emit: (row) => {
      pending = [...pending, JSON.stringify(row)];
    },
    flush: async () => {
      const lines = pending;
      pending = [];
      if (lines.length === 0) return 0;
      await sink.write(lines);
      return lines.length;
    },
  };
};

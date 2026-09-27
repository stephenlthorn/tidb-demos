import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'mysql2/promise';

const execFileAsync = promisify(execFile);

export type FaultHandle = { readonly stop: () => void };

export const runSlowQueryStorm = (pool: Pool): FaultHandle => {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await pool.query('SELECT COUNT(*) FROM lab_orders WHERE notes LIKE ?', ['%steady%']);
    setTimeout(() => {
      void tick();
    }, 50);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
    },
  };
};

export const runWriteHotSpot = (pool: Pool): FaultHandle => {
  let stopped = false;
  let sequentialId = 1;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await pool.query('INSERT INTO lab_orders (id, customer_id, amount_cents, notes) VALUES (?, ?, ?, ?)', [
      sequentialId,
      1,
      100,
      'hot-spot',
    ]);
    sequentialId += 1;
    setTimeout(() => {
      void tick();
    }, 10);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
    },
  };
};

export type SurgeConnection = { readonly end: () => Promise<void> };

export const runConnectionSurge = (createConnection: () => Promise<SurgeConnection>): FaultHandle => {
  let stopped = false;
  const connections: SurgeConnection[] = [];
  const open = async (): Promise<void> => {
    for (let i = 0; i < 200 && !stopped; i += 1) {
      connections.push(await createConnection());
    }
  };
  void open();
  return {
    stop: () => {
      stopped = true;
      void Promise.all(connections.map((connection) => connection.end()));
    },
  };
};

export type TikvPlaygroundHandle = { readonly pid: string };

export const stopTikvStore = async (options: { readonly displayCommand?: string } = {}): Promise<TikvPlaygroundHandle> => {
  const displayCommand = options.displayCommand ?? 'tiup playground display';
  const { stdout } = await execFileAsync('bash', ['-c', displayCommand]);
  const tikvLine = stdout.split('\n').find((line) => line.includes('tikv') && !line.includes('exited'));
  if (tikvLine === undefined) throw new Error('no running tikv instance found in tiup playground display output');
  const pid = tikvLine.trim().split(/\s+/)[0];
  if (pid === undefined) throw new Error('could not parse a pid from the tiup playground display line');
  await execFileAsync('bash', ['-c', `tiup playground scale-in --pid ${pid}`]);
  return { pid };
};

export const startTikvStore = async (): Promise<void> => {
  await execFileAsync('bash', ['-c', 'tiup playground scale-out --kv 1']);
};

export const clearAllFaults = async (handles: readonly FaultHandle[]): Promise<void> => {
  handles.forEach((handle) => handle.stop());
};

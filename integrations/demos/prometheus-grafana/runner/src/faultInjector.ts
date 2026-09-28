import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'mysql2/promise';

const execFileAsync = promisify(execFile);

export type FaultHandle = { readonly stop: () => void };

const SLOW_QUERY_STORM_WORKERS = 4;

export const runSlowQueryStorm = (pool: Pool): FaultHandle => {
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      await pool.query('SELECT COUNT(*) FROM lab_orders WHERE notes LIKE ? AND (SELECT SLEEP(0.6)) = 0', ['%steady%']);
    }
  };
  const workers = Array.from({ length: SLOW_QUERY_STORM_WORKERS }, () => worker());
  void Promise.all(workers);
  return {
    stop: () => {
      stopped = true;
    },
  };
};

export const runWriteHotSpot = (pool: Pool): FaultHandle => {
  let stopped = false;
  let sequentialId = Date.now() * 1000;
  const start = async (): Promise<void> => {
    const connection = await pool.getConnection();
    try {
      await connection.query('SET SESSION allow_auto_random_explicit_insert = 1');
      const tick = async (): Promise<void> => {
        if (stopped) {
          connection.release();
          return;
        }
        try {
          await connection.query('INSERT IGNORE INTO lab_orders (id, customer_id, amount_cents, notes) VALUES (?, ?, ?, ?)', [
            sequentialId,
            1,
            100,
            'hot-spot',
          ]);
        } catch {}
        sequentialId += 1;
        setTimeout(() => {
          void tick();
        }, 10);
      };
      void tick();
    } catch {
      connection.release();
    }
  };
  void start();
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

export type TikvPlaygroundHandle = { readonly pid: string; readonly command: string };

const PD_BASE_URL = 'http://127.0.0.1:2379';

const setMaxStoreDownTime = async (duration: string): Promise<void> => {
  await fetch(`${PD_BASE_URL}/pd/api/v1/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ 'schedule.max-store-down-time': duration }),
  });
};

const TIKV_STATUS_PORT = 20180;

export const stopTikvStore = async (options: { readonly statusPort?: number } = {}): Promise<TikvPlaygroundHandle> => {
  const statusPort = options.statusPort ?? TIKV_STATUS_PORT;
  await setMaxStoreDownTime('5s');
  const { stdout: pidOutput } = await execFileAsync('lsof', ['-ti', `:${statusPort}`, '-sTCP:LISTEN']);
  const pid = pidOutput
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (pid === undefined) throw new Error(`no process found listening on tikv status port ${statusPort}`);
  const { stdout: verifyOutput } = await execFileAsync('ps', ['-p', pid, '-wwo', 'command=']);
  if (!verifyOutput.includes('tikv-server')) throw new Error(`pid ${pid} bound to status port ${statusPort} is not a tikv-server process`);
  const command = verifyOutput.trim();
  await execFileAsync('kill', ['-9', pid]);
  return { pid, command };
};

export const startTikvStore = async (handle?: TikvPlaygroundHandle): Promise<void> => {
  if (handle === undefined) {
    await execFileAsync('bash', ['-c', 'tiup playground scale-out --kv 1']);
    return;
  }
  await execFileAsync('bash', ['-c', `nohup ${handle.command} > /dev/null 2>&1 & disown`]);
  await setMaxStoreDownTime('30m0s');
};

export const clearAllFaults = async (handles: readonly FaultHandle[]): Promise<void> => {
  handles.forEach((handle) => handle.stop());
};

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const isPortForwardReady = (line: string): boolean => /Forwarding from/.test(line);

export type UpdateKubeconfigOptions = {
  readonly clusterName: string;
  readonly region: string;
  readonly alias: string;
};

export const updateKubeconfig = (options: UpdateKubeconfigOptions): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('aws', [
      'eks',
      'update-kubeconfig',
      '--name',
      options.clusterName,
      '--region',
      options.region,
      '--alias',
      options.alias,
    ]);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`aws eks update-kubeconfig exited ${code}`))));
  });

export type PortForwardHandle = {
  readonly stop: () => void;
};

export type StartPortForwardOptions = {
  readonly context: string;
  readonly service: string;
  readonly localPort: number;
  readonly remotePort: number;
  readonly timeoutMs?: number;
};

export const startPortForward = (options: StartPortForwardOptions): Promise<PortForwardHandle> =>
  new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      'kubectl',
      [
        'port-forward',
        `service/${options.service}`,
        `${options.localPort}:${options.remotePort}`,
        '--context',
        options.context,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`kubectl port-forward did not become ready within ${options.timeoutMs ?? 30_000}ms`));
    }, options.timeoutMs ?? 30_000);

    const onLine = (line: string): void => {
      if (isPortForwardReady(line)) {
        clearTimeout(timeout);
        resolve({ stop: () => child.kill() });
      }
    };

    if (child.stdout) createInterface({ input: child.stdout }).on('line', onLine);
    if (child.stderr) createInterface({ input: child.stderr }).on('line', onLine);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

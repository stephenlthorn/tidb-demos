import { spawn } from 'node:child_process';

export type CliOptions = {
  readonly bin: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export type CliResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunCli = (options: CliOptions) => Promise<CliResult>;

export const runCli: RunCli = (options) =>
  new Promise((resolve) => {
    const child = spawn(options.bin, [...options.args], {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => resolve({ code: 127, stdout: '', stderr: error.message }));
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });

export const stdoutOrThrow = (result: CliResult, label: string): string => {
  if (result.code === 0) return result.stdout;
  const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
  throw new Error(`${label} failed with exit code ${result.code}: ${detail}`);
};

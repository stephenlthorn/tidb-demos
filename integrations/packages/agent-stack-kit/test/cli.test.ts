import { describe, expect, it } from 'vitest';
import { runCli, stdoutOrThrow } from '../src/cli';

describe('runCli', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await runCli({ bin: process.execPath, args: ['-e', 'process.stdout.write("hello")'] });
    expect(result).toEqual({ code: 0, stdout: 'hello', stderr: '' });
  });

  it('returns a nonzero exit code and stderr instead of throwing', async () => {
    const result = await runCli({
      bin: process.execPath,
      args: ['-e', 'process.stderr.write("bad"); process.exit(3)'],
    });
    expect(result).toEqual({ code: 3, stdout: '', stderr: 'bad' });
  });

  it('passes extra environment variables to the child', async () => {
    const result = await runCli({
      bin: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.KIT_PROBE ?? "")'],
      env: { KIT_PROBE: 'on' },
    });
    expect(result.stdout).toBe('on');
  });

  it('reports a missing binary as exit code 127', async () => {
    const result = await runCli({ bin: 'definitely-not-a-real-binary', args: [] });
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('ENOENT');
  });
});

describe('stdoutOrThrow', () => {
  it('returns stdout on success', () => {
    expect(stdoutOrThrow({ code: 0, stdout: 'x', stderr: '' }, 'ti fs')).toBe('x');
  });

  it('names the command and stderr on failure', () => {
    expect(() => stdoutOrThrow({ code: 2, stdout: '', stderr: ' boom ' }, 'ti fs')).toThrow(
      'ti fs failed with exit code 2: boom',
    );
  });
});

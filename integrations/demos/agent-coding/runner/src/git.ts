import { cp, mkdir, rm } from 'node:fs/promises';
import type { RunCli } from '@lab/agent-stack-kit';

const identity = ['-c', 'user.name=Kiteline Lab', '-c', 'user.email=lab@example.invalid'];

export const pushWinnerBranch = async (options: {
  readonly run: RunCli;
  readonly remoteDir: string;
  readonly cloneDir: string;
  readonly baselineDir: string;
  readonly winnerDir: string;
  readonly branch: string;
  readonly message: string;
}): Promise<{ readonly commit: string; readonly files: readonly string[] }> => {
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await options.run({ bin: 'git', args });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const inClone = (args: readonly string[]): Promise<string> => git(['-C', options.cloneDir, ...identity, ...args]);
  await rm(options.remoteDir, { recursive: true, force: true });
  await rm(options.cloneDir, { recursive: true, force: true });
  await mkdir(options.cloneDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', options.remoteDir]);
  await git(['init', '--initial-branch=main', options.cloneDir]);
  await cp(options.baselineDir, options.cloneDir, { recursive: true });
  await inClone(['add', '-A']);
  await inClone(['commit', '-m', 'baseline']);
  await inClone(['remote', 'add', 'origin', options.remoteDir]);
  await inClone(['push', 'origin', 'main']);
  await inClone(['checkout', '-b', options.branch]);
  await cp(options.winnerDir, options.cloneDir, { recursive: true });
  await inClone(['add', '-A']);
  await inClone(['commit', '-m', options.message]);
  await inClone(['push', 'origin', options.branch]);
  const commit = (await inClone(['rev-parse', 'HEAD'])).trim();
  const files = (await inClone(['diff', '--name-only', 'main', options.branch])).split('\n').filter((line) => line !== '');
  return { commit, files: [...files].sort() };
};

export const remoteBranchExists = async (run: RunCli, remoteDir: string, branch: string): Promise<boolean> => {
  const result = await run({ bin: 'git', args: ['--git-dir', remoteDir, 'rev-parse', '--verify', `refs/heads/${branch}`] });
  return result.code === 0;
};

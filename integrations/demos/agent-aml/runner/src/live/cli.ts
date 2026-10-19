import { runCli } from '@lab/agent-stack-kit';

type CliOptions = Parameters<typeof runCli>[0];

export const runOrThrow = async (options: CliOptions): Promise<Awaited<ReturnType<typeof runCli>>> => {
  const result = await runCli(options);
  if (result.code !== 0) {
    throw new Error(`${options.bin} ${options.args.slice(0, 3).join(' ')} exited ${result.code}: ${result.stderr.slice(0, 300)}`);
  }
  return result;
};

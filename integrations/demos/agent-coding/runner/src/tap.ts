export type TapSummary = {
  readonly failing: readonly string[];
  readonly passing: number;
  readonly signature: string | undefined;
};

const failingLine = /^not ok \d+ - (.+)$/;
const passingLine = /^ok \d+ - /;

export const failureSignature = (stdout: string): string | undefined => {
  if (stdout.includes('ECONNRESET')) return 'ECONNRESET';
  if (stdout.includes('ERR_ASSERTION')) return 'AssertionError';
  return stdout.includes('not ok') ? 'UnknownFailure' : undefined;
};

export const parseTap = (stdout: string): TapSummary => {
  const lines = stdout.split('\n');
  return {
    failing: lines
      .map((line) => failingLine.exec(line)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort(),
    passing: lines.filter((line) => passingLine.test(line)).length,
    signature: failureSignature(stdout),
  };
};

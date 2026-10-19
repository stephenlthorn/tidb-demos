export const sqlStringLiteral = (value: string): string =>
  `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;

export const assertSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer: ${value}`);
  return value;
};

const accountIdPattern = /^[A-Z]{3}-\d{4}$/;
const branchCodePattern = /^B\d{2}$/;

export const assertAccountId = (value: string): string => {
  if (!accountIdPattern.test(value)) throw new Error(`not an account id: ${value}`);
  return value;
};

export const assertBranchCode = (value: string): string => {
  if (!branchCodePattern.test(value)) throw new Error(`not a branch code: ${value}`);
  return value;
};

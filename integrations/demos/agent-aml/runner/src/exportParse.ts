export const parseExportId = (stdout: string): string | undefined => {
  const labelled = /export[\s_-]*id\W+([A-Za-z0-9_-]{6,})/i.exec(stdout);
  if (labelled?.[1] !== undefined) return labelled[1];
  const json = /"id"\s*:\s*"([A-Za-z0-9_-]{6,})"/.exec(stdout);
  return json?.[1];
};

export type ExportState = 'running' | 'done' | 'failed';

export const exportState = (stdout: string): ExportState => {
  if (/fail|cancel/i.test(stdout)) return 'failed';
  if (/succeed|success|complete/i.test(stdout)) return 'done';
  return 'running';
};

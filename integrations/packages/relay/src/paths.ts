import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const labRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LAB_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));

export const demoDir = (root: string, id: string): string => join(root, 'demos', id);

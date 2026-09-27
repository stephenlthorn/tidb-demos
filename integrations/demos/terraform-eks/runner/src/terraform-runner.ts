import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

export type SpawnTerraformOptions = {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly onLine: (line: string) => void;
};

export const spawnTerraform = (options: SpawnTerraformOptions): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn('terraform', options.args, { cwd: options.cwd });
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    stdout.on('line', options.onLine);
    stderr.on('line', options.onLine);
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

const TerraformOutputValueSchema = z.object({
  value: z.unknown(),
  sensitive: z.boolean().optional(),
  type: z.unknown().optional(),
});

const TerraformOutputsSchema = z.record(z.string(), TerraformOutputValueSchema);

export type TerraformOutputs = Readonly<Record<string, unknown>>;

const collectStdout = (options: { readonly args: readonly string[]; readonly cwd: string }): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('terraform', options.args, { cwd: options.cwd });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const readTerraformOutputs = async (cwd: string): Promise<TerraformOutputs> => {
  const raw = await collectStdout({ args: ['output', '-json'], cwd });
  const parsed = TerraformOutputsSchema.safeParse(parseJson(raw));
  if (!parsed.success) return {};
  return Object.fromEntries(Object.entries(parsed.data).map(([key, entry]) => [key, entry.value]));
};

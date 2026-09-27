import { z } from 'zod';
import type { Pool } from 'mysql2/promise';

const DeleteResultSchema = z.object({ affectedRows: z.number() });

export const purgeExpiredTranscripts = async (options: {
  readonly pool: Pool;
  readonly retentionDays: number;
}): Promise<number> => {
  const [result] = await options.pool.query(
    'DELETE FROM call_summaries WHERE created_at < NOW() - INTERVAL ? DAY',
    [options.retentionDays],
  );
  return DeleteResultSchema.parse(result).affectedRows;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { openKbPool } = await import('./kb.js');
  const pool = openKbPool();
  const retentionDays = Number(process.env.TRANSCRIPT_RETENTION_DAYS ?? '30');
  const purged = await purgeExpiredTranscripts({ pool, retentionDays });
  process.stdout.write(`purged ${purged} expired call_summaries rows (retention: ${retentionDays} days)\n`);
  await pool.end();
}

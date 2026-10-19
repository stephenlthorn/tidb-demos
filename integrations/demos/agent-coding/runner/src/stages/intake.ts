import { timed } from '@lab/runner-kit';
import type { Stage } from '../context';
import { intakeQuery } from '../lesson';
import { buildHybridSearch, parseMemoryHits } from '../starterSql';

export const intakeMemoryRecall = async ({ deps, memory }: Stage): Promise<void> => {
  const { config, emitter, orgPool, tiFs } = deps;
  emitter.phase('intake-memory-recall');
  emitter.node('org-memory', 'busy', 'hybrid recall');
  const query = buildHybridSearch({ text: intakeQuery(config.ticket), limit: 3 });
  const { value, ms } = await timed(() => orgPool.rows(query.sql, query.params));
  const hits = parseMemoryHits(value);
  emitter.metric('hybrid-search-ms', ms);
  emitter.flow('recall', hits.length);
  hits.forEach((hit, index) => emitter.log('info', `recall ${index + 1} (${hit.kind}): ${hit.content}`, 'org-memory'));
  emitter.node('org-memory', 'healthy', `${hits.length} memories recalled`);
  await tiFs.appendJournal({
    journalId: memory.journalId,
    entry: { type: 'memory.recalled', subjects: [`ticket:${config.ticket.id}`], summary: { hits: hits.map((hit) => hit.id) } },
    idempotencyKey: `${config.runId}-recalled`,
  });
};

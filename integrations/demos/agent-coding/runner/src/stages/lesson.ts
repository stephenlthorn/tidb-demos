import { timed } from '@lab/runner-kit';
import type { Stage } from '../context';
import { stepKey } from '../context';
import { buildLesson, lessonRecalled } from '../lesson';
import { buildHybridSearch, insertMemorySql, parseMemoryHits } from '../starterSql';
import { verifyJournal } from './winner';

const recallQuery = 'gateway connection reset retry loop idempotency';

export const writeLesson = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, orgPool, tiFs, sleep } = deps;
  emitter.phase('write-lesson');
  emitter.check('lesson-recalled', 'pending');
  const target = memory.replayTarget;
  const entry = target === undefined ? undefined : memory.stepEntries.get(stepKey(target.attemptId, target.haltedAtStep));
  if (target === undefined || entry === undefined) {
    emitter.log('warn', 'no attempt failed, so there is no lesson to write', 'org-memory');
    emitter.check('lesson-recalled', 'fail', 'no failure to learn from');
    return;
  }
  const text = buildLesson({
    ticketId: config.ticket.id,
    attemptId: target.attemptId,
    step: target.haltedAtStep,
    signature: entry.signature ?? 'failure',
    reproduced: memory.replayVerified === true,
    winnerId: memory.winner?.attemptId,
  });
  emitter.node('org-memory', 'busy', 'writing the lesson');
  const lessonId = await orgPool.insert(insertMemorySql, ['lesson', text]);
  memory.lessonId = lessonId;
  emitter.flow('lesson-write', 1);
  emitter.log('info', `lesson ${lessonId} written: ${text}`, 'org-memory');

  const query = buildHybridSearch({ text: recallQuery, limit: 3 });
  const deadline = Date.now() + 60000;
  const attemptRecall = async (): Promise<boolean> => {
    const { value, ms } = await timed(() => orgPool.rows(query.sql, query.params));
    emitter.metric('hybrid-search-ms', ms);
    if (lessonRecalled(parseMemoryHits(value), lessonId)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(3000);
    return attemptRecall();
  };
  const recalled = await attemptRecall();
  emitter.check(
    'lesson-recalled',
    recalled ? 'pass' : 'fail',
    recalled ? `lesson ${lessonId} is in the top 3 hybrid results for a new retry-loop task` : `lesson ${lessonId} not in the top 3 after 60 s`,
  );
  await tiFs.appendJournal({
    journalId: memory.journalId,
    entry: { type: 'lesson.written', subjects: [`memory:${lessonId}`], summary: { recalled } },
    idempotencyKey: `${config.runId}-lesson`,
  });
  await verifyJournal(stage);
  emitter.node('org-memory', 'done', 'lesson recorded');
  emitter.log('info', 'run complete: stop the runner with Ctrl-C, then run the teardown script', 'harness');
};

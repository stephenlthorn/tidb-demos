import { describe, expect, it } from 'vitest';
import { buildLesson, intakeQuery, lessonRecalled } from '../src/lesson';

describe('intakeQuery', () => {
  it('joins the ticket title and id', () => {
    expect(intakeQuery({ id: 'KIT-8812', title: 'fix double charge on retried payments' })).toBe(
      'fix double charge on retried payments KIT-8812',
    );
  });
});

describe('buildLesson', () => {
  const base = {
    ticketId: 'KIT-8812',
    attemptId: 'attempt-2',
    step: 7,
    signature: 'ECONNRESET',
    reproduced: true,
    winnerId: 'attempt-1',
  };

  it('states the failure, the reproduction and the winner', () => {
    expect(buildLesson(base)).toBe(
      'KIT-8812: attempt-2 failed at step 7 with ECONNRESET after it wrapped the gateway call in a retry loop. Replaying from the step-07 checkpoint reproduced the same failing tests. attempt-1 won with a smaller change. Fix idempotency in the ledger first and treat gateway connection resets as retryable infrastructure faults, not patch defects.',
    );
  });

  it('says so when the replay did not reproduce', () => {
    expect(buildLesson({ ...base, reproduced: false, winnerId: undefined })).toContain(
      'The replay did not reproduce the failure, so treat it as flaky. No attempt passed.',
    );
  });

  it('contains no em dash', () => {
    expect(buildLesson(base)).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('lessonRecalled', () => {
  it('finds the lesson id among the hits', () => {
    expect(lessonRecalled([{ id: 3 }, { id: 11 }], 11)).toBe(true);
    expect(lessonRecalled([{ id: 3 }], 11)).toBe(false);
  });
});

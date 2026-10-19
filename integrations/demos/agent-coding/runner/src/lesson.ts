export const intakeQuery = (ticket: { readonly id: string; readonly title: string }): string => `${ticket.title} ${ticket.id}`;

export const buildLesson = (options: {
  readonly ticketId: string;
  readonly attemptId: string;
  readonly step: number;
  readonly signature: string;
  readonly reproduced: boolean;
  readonly winnerId: string | undefined;
}): string => {
  const outcome = options.reproduced
    ? `Replaying from the step-${String(options.step).padStart(2, '0')} checkpoint reproduced the same failing tests.`
    : 'The replay did not reproduce the failure, so treat it as flaky.';
  const winner = options.winnerId === undefined ? 'No attempt passed.' : `${options.winnerId} won with a smaller change.`;
  return `${options.ticketId}: ${options.attemptId} failed at step ${options.step} with ${options.signature} after it wrapped the gateway call in a retry loop. ${outcome} ${winner} Fix idempotency in the ledger first and treat gateway connection resets as retryable infrastructure faults, not patch defects.`;
};

export const lessonRecalled = (hits: readonly { readonly id: number }[], lessonId: number): boolean =>
  hits.some((hit) => hit.id === lessonId);

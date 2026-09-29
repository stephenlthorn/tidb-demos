export type CursorEvent = {
  readonly uuid: string;
  readonly published: string;
};

export const selectNewEvents = <T extends CursorEvent>(
  events: readonly T[],
  seenUuids: ReadonlySet<string>,
): readonly T[] => events.filter((event) => !seenUuids.has(event.uuid));

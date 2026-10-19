export type SerialQueue = {
  readonly enqueue: <T>(task: () => Promise<T>) => Promise<T>;
};

export const createSerialQueue = (): SerialQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
  return { enqueue };
};

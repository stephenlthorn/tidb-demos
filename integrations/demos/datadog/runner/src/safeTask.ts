export type SafeTaskOptions = {
  readonly task: () => Promise<void>;
  readonly onError: (error: unknown) => void;
};

export const safeTask = (options: SafeTaskOptions): (() => Promise<void>) =>
  async () => {
    try {
      await options.task();
    } catch (error) {
      options.onError(error);
    }
  };

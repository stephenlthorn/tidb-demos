export type Store<T> = {
  readonly get: () => T;
  readonly update: (change: (current: T) => T) => T;
};

export const createStore = <T>(initial: T): Store<T> => {
  let value = initial;
  return {
    get: () => value,
    update: (change) => {
      value = change(value);
      return value;
    },
  };
};

/** Runs admin writes one after the other: file writes and database check writes share one lock. */
export interface WriteLock {
  run<T>(fn: () => T): Promise<T>;
}

export function createWriteLock(): WriteLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(fn);
      // The chain goes on after a failure.
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

let epoch = 0;
let mutationQueue: Promise<unknown> = Promise.resolve();

export const invalidateAuthOperations = () => { epoch += 1; };
export const getAuthOperationEpoch = () => epoch;
export function staleAuthOperation() {
  return Object.assign(new Error('The sign-in session changed. Please try again.'), { code: 'ERR_CANCELED' });
}
export function captureAuthOperation() {
  const expected = epoch;
  return () => { if (epoch !== expected) throw staleAuthOperation(); };
}

// Logout/restriction cleanup queues behind an already-started secure write, so
// that write cannot finish after cleanup and resurrect a previous account.
export function mutateAuthSession<T>(assertCurrent: () => void, mutation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.catch(() => undefined).then(() => {
    assertCurrent();
    return mutation();
  });
  mutationQueue = result.catch(() => undefined);
  return result;
}

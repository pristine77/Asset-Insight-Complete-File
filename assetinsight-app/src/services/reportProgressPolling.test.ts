import { pollAcceptedReport } from './reportProgressPolling';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const callbacks = () => ({ onDone: jest.fn(), onError: jest.fn(), onPending: jest.fn() });

it('does not overlap slow requests and stops on completion', async () => {
  let resolve!: (value: { phase: string }) => void;
  const load = jest.fn(() => new Promise<{ phase: string }>((done) => { resolve = done; }));
  const handlers = callbacks();
  pollAcceptedReport({ load, ...handlers });
  await jest.advanceTimersByTimeAsync(12_000);
  expect(load).toHaveBeenCalledTimes(1);
  resolve({ phase: 'done' });
  await jest.advanceTimersByTimeAsync(12_000);
  expect(handlers.onDone).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it('reports accepted but untracked work after bounded network failures, not upload failure', async () => {
  const handlers = callbacks();
  const load = jest.fn().mockRejectedValue(new Error('network'));
  pollAcceptedReport({ load, ...handlers, maxFailures: 2 });
  await jest.advanceTimersByTimeAsync(20_000);
  expect(load).toHaveBeenCalledTimes(2);
  expect(handlers.onPending).toHaveBeenCalledTimes(1);
  expect(handlers.onError).not.toHaveBeenCalled();
});

it('bounds even a never-resolving request and ignores a late response', async () => {
  let resolve!: (value: { phase: string }) => void;
  const handlers = callbacks();
  pollAcceptedReport({ load: () => new Promise((done) => { resolve = done; }), ...handlers, maxDurationMs: 5000 });
  await jest.advanceTimersByTimeAsync(6000);
  expect(handlers.onPending).toHaveBeenCalledTimes(1);
  resolve({ phase: 'done' });
  await jest.advanceTimersByTimeAsync(1000);
  expect(handlers.onDone).not.toHaveBeenCalled();
});

it('cancels timers when the form leaves and ignores errors from canceled requests', async () => {
  const handlers = callbacks();
  const load = jest.fn().mockResolvedValue({ phase: 'processing' });
  const stop = pollAcceptedReport({ load, ...handlers });
  stop();
  await jest.advanceTimersByTimeAsync(700_000);
  expect(load).not.toHaveBeenCalled();
  expect(handlers.onPending).not.toHaveBeenCalled();
});

it('surfaces an actual server generation failure once', async () => {
  const handlers = callbacks();
  pollAcceptedReport({ load: async () => ({ phase: 'error', message: 'Generation failed' }), ...handlers });
  await jest.advanceTimersByTimeAsync(20_000);
  expect(handlers.onError).toHaveBeenCalledWith('Generation failed');
  expect(jest.getTimerCount()).toBe(0);
});

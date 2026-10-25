/**
 * Automatic resume (2026-10-02): which interruptions may continue by
 * themselves, and the wait for a steady connection before they do.
 */
import {
  AUTO_RESUME_STABLE_SIGNAL_MS,
  UPLOAD_WAITING_FOR_CONNECTION,
  isAutoResumableUploadFailure,
  waitForStableConnection,
  type NetworkWatcher,
} from './uploadAutoResume';

const paused = (extra: Record<string, unknown> = {}) => Object.assign(
  new Error('Upload paused. Your draft is saved. Resume this same upload to check whether the server already accepted it.'),
  { code: 'ERR_CANCELED', acceptanceUncertain: true, ...extra },
);

describe('which interruptions continue by themselves', () => {
  it.each([
    ['a pause for a lost connection', paused({ pauseReason: 'connection' })],
    ['a Submit that found no connection', Object.assign(new Error('Saved on this device.'), { code: UPLOAD_WAITING_FOR_CONNECTION })],
    ['a stalled transfer', Object.assign(new Error('The upload stopped making progress.'), { code: 'UPLOAD_STALLED', isRecoverableUploadError: true })],
    ['a network error', Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })],
    ['a request aborted by the automatic pause', Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', request: {} })],
    ['a busy server', { response: { status: 503 }, message: 'Service unavailable' }],
  ])('%s', (_name, error) => {
    expect(isAutoResumableUploadFailure(error)).toBe(true);
  });

  it.each([
    ['the Pause button, Offline mode or a sign-out', paused()],
    ['a rejected request', { response: { status: 400, data: { message: 'Bad request' } }, message: 'Bad request' }],
    ['a sign-in problem', { response: { status: 401 }, message: 'Unauthorized' }],
    ['a conflict that needs a decision', { response: { status: 409, data: { code: 'SUBMISSION_MANIFEST_CHANGED' } }, message: 'Conflict' }],
    ['a receipt that did not confirm the upload', Object.assign(new Error('The server response did not confirm this submission.'), { code: 'UPLOAD_RECEIPT_UNCONFIRMED' })],
    ['nothing', undefined],
  ])('%s does not', (_name, error) => {
    expect(isAutoResumableUploadFailure(error)).toBe(false);
  });
});

/** A phone connection the test switches on and off. */
function fakeNetwork(connected: boolean | null) {
  let state = { isConnected: connected };
  const listeners = new Set<(value: { isConnected?: boolean | null }) => void>();
  const network: NetworkWatcher = {
    fetch: jest.fn(async () => state),
    addEventListener: jest.fn((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
  };
  return {
    network,
    set(value: boolean | null) {
      state = { isConnected: value };
      for (const listener of Array.from(listeners)) listener(state);
    },
    listening: () => listeners.size,
  };
}

describe('waiting for a steady connection', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  function start(network: NetworkWatcher, checkServer: () => Promise<boolean>) {
    const controller = new AbortController();
    const outcome: { value?: boolean } = {};
    void waitForStableConnection({ signal: controller.signal, checkServer, network }).then((value) => { outcome.value = value; });
    return { controller, outcome };
  }

  it('goes ahead only after the signal has held and our server answers', async () => {
    const net = fakeNetwork(true);
    const checkServer = jest.fn(async () => true);
    const { outcome } = start(net.network, checkServer);
    await jest.advanceTimersByTimeAsync(AUTO_RESUME_STABLE_SIGNAL_MS - 1);
    expect(outcome.value).toBeUndefined();
    expect(checkServer).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome.value).toBe(true);
    expect(checkServer).toHaveBeenCalledTimes(1);
    expect(net.listening()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits out a dead zone without checking the server, then needs the signal to hold', async () => {
    const net = fakeNetwork(false);
    const checkServer = jest.fn(async () => true);
    const { outcome } = start(net.network, checkServer);
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(outcome.value).toBeUndefined();
    expect(checkServer).not.toHaveBeenCalled();
    net.set(true);
    await jest.advanceTimersByTimeAsync(AUTO_RESUME_STABLE_SIGNAL_MS - 1);
    expect(outcome.value).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome.value).toBe(true);
  });

  it('starts the steady period again after a drop, so a flickering signal does not resume', async () => {
    const net = fakeNetwork(true);
    const checkServer = jest.fn(async () => true);
    const { outcome } = start(net.network, checkServer);
    await jest.advanceTimersByTimeAsync(AUTO_RESUME_STABLE_SIGNAL_MS - 2_000);
    net.set(false);
    await jest.advanceTimersByTimeAsync(3_000);
    net.set(true);
    await jest.advanceTimersByTimeAsync(AUTO_RESUME_STABLE_SIGNAL_MS - 1);
    expect(outcome.value).toBeUndefined();
    expect(checkServer).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome.value).toBe(true);
  });

  it('treats an unknown connection state as connected, like the automatic pause', async () => {
    const net = fakeNetwork(null);
    const { outcome } = start(net.network, async () => true);
    await jest.advanceTimersByTimeAsync(AUTO_RESUME_STABLE_SIGNAL_MS);
    expect(outcome.value).toBe(true);
  });

  it('checks the server again with longer waits while connected but unanswered', async () => {
    const net = fakeNetwork(true);
    const answers: Array<() => Promise<boolean>> = [
      async () => false,
      async () => { throw new Error('Network Error'); },
      async () => true,
    ];
    const checkServer = jest.fn(() => answers.shift()!());
    const { outcome } = start(net.network, checkServer);
    // Steady 15 s, no answer; wait 15 s; steady 15 s, an error; wait 30 s; steady 15 s, answered.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(checkServer).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_000 - 1);
    expect(checkServer).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(checkServer).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(45_000 - 1);
    expect(outcome.value).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(checkServer).toHaveBeenCalledTimes(3);
    expect(outcome.value).toBe(true);
  });

  it.each([
    ['while offline', false, 0],
    ['during the steady period', true, 5_000],
    ['between server checks', true, 20_000],
  ])('stops at once when cancelled %s and leaves nothing running', async (_when, connected, after) => {
    const net = fakeNetwork(connected);
    const checkServer = jest.fn(async () => false);
    const { controller, outcome } = start(net.network, checkServer);
    await jest.advanceTimersByTimeAsync(after);
    const checksBefore = checkServer.mock.calls.length;
    controller.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(outcome.value).toBe(false);
    expect(net.listening()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(checkServer.mock.calls.length).toBe(checksBefore);
  });
});


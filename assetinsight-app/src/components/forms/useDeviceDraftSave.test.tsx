import { act, renderHook } from '@testing-library/react-native';
import useDeviceDraftSave from './useDeviceDraftSave';
let mockOwner: string | null = 'owner';
jest.mock('../../services/offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: () => mockOwner } }));
afterEach(() => { mockOwner = 'owner'; jest.useRealTimers(); });

it('flushes a pending autosave and coalesces duplicate Save taps without starting transport', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  let finish!: () => void;
  const pending = { current: new Promise<void>(resolve => { finish = resolve; }) };
  const staleSave = jest.fn();
  const timer = { current: setTimeout(staleSave, 2000) as unknown as ReturnType<typeof setTimeout> };
  const save = jest.fn(async () => ({ id: 'same-draft' }));
  const closed = jest.fn();
  const { result } = await renderHook(() => useDeviceDraftSave(save, pending, timer));
  let first!: Promise<void>;
  await act(async () => { first = result.current.saveOnDevice(closed); });
  expect(result.current.saving).toBe(true);
  await act(async () => { await result.current.saveOnDevice(closed); jest.advanceTimersByTime(5000); });
  expect(save).not.toHaveBeenCalled(); expect(staleSave).not.toHaveBeenCalled();
  await act(async () => { finish(); await first; });
  expect(save).toHaveBeenCalledTimes(1); expect(closed).toHaveBeenCalledWith({ id: 'same-draft' });
  expect(result.current.saving).toBe(false);
});
it('does not save or close an old account draft when pending work crosses logout', async () => {
  let finish!: () => void;
  const pending = { current: new Promise<void>(resolve => { finish = resolve; }) };
  const timer = { current: null };
  const save = jest.fn(async () => ({ id: 'same-draft' })), closed = jest.fn();
  const { result } = await renderHook(() => useDeviceDraftSave(save, pending, timer));
  let first!: Promise<void>;
  await act(async () => { first = result.current.saveOnDevice(closed); });
  mockOwner = null;
  await act(async () => { finish(); await expect(first).rejects.toThrow('account changed'); });
  expect(save).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
  expect(result.current.saving).toBe(false);
});

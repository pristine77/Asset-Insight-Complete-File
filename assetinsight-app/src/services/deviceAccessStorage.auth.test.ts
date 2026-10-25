import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearDeviceAccess, getMemoryAccessToken, migrateLegacyTokens, persistDeviceAccess, setMemoryAccessToken, subscribeDeviceAccess } from './deviceAccessStorage';
import { captureAuthOperation, invalidateAuthOperations, mutateAuthSession } from './authSessionOperation';

jest.mock('expo-secure-store', () => ({ setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), getItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1 }));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), multiRemove: jest.fn() }));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
beforeEach(() => { jest.clearAllMocks(); invalidateAuthOperations(); setMemoryAccessToken(null); });

it('never emits a late device restriction after logout starts, and cleanup follows the pending write', async () => {
  const write = deferred<void>(); let persisted: string | null = null;
  jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (_key, value) => { await write.promise; persisted = value; });
  jest.mocked(SecureStore.deleteItemAsync).mockImplementationOnce(async () => { persisted = null; });
  const listener = jest.fn(), unsubscribe = subscribeDeviceAccess(listener);
  try {
    const guard = captureAuthOperation();
    const pending = mutateAuthSession(guard, () => persistDeviceAccess({ authState: 'revoked' }, guard));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    await Promise.resolve(); await Promise.resolve();
    invalidateAuthOperations(); const current = captureAuthOperation();
    const cleanup = mutateAuthSession(current, () => clearDeviceAccess(current));
    write.resolve(); await rejected; await cleanup;
    expect(listener.mock.calls).toEqual([[null]]); expect(persisted).toBeNull();
  } finally { unsubscribe(); }
});

it('does not publish a stale device-clear event over a newer sign-in decision', async () => {
  const deletion = deferred<void>(); jest.mocked(SecureStore.deleteItemAsync).mockReturnValueOnce(deletion.promise);
  const listener = jest.fn(), unsubscribe = subscribeDeviceAccess(listener);
  try {
    const pending = clearDeviceAccess(); const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    invalidateAuthOperations(); deletion.resolve(); await rejected; expect(listener).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});

it('does not resurrect a legacy token read that finishes after logout', async () => {
  const read = deferred<string | null>();
  jest.mocked(AsyncStorage.getItem).mockReturnValueOnce(read.promise).mockResolvedValueOnce('legacy-refresh');
  jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
  const pending = migrateLegacyTokens(); const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  invalidateAuthOperations(); read.resolve('legacy-access'); await rejected;
  expect(getMemoryAccessToken()).toBeNull(); expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  clearSecureSession,
  getDeviceKey,
  getOrCreateDeviceKey,
} from './deviceAccessStorage';

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
}));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({ multiRemove: jest.fn() }));

const DEVICE_KEY = 'cv_device_installation_secure_v1';
const generatedBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const generatedKey = Array.from(generatedBytes, (value) => value.toString(16).padStart(2, '0')).join('');
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};

let storedKey: string | null;
beforeEach(() => {
  jest.resetAllMocks();
  storedKey = null;
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => key === DEVICE_KEY ? storedKey : null);
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    if (key === DEVICE_KEY) storedKey = value;
  });
  jest.mocked(Crypto.getRandomBytesAsync).mockResolvedValue(generatedBytes);
});

it.each([
  'a'.repeat(64),
  'legacy-valid-installation-key-1234567890',
  `  ${'b'.repeat(32)}  `,
])('preserves an existing server-valid installation identity exactly %#', async (key) => {
  storedKey = key;
  await expect(getOrCreateDeviceKey()).resolves.toBe(key);
  expect(Crypto.getRandomBytesAsync).not.toHaveBeenCalled();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});

it.each([null, '', 'old-short-key', ' '.repeat(64), ` ${'a'.repeat(31)} `])(
  'persists a server-valid random identity when the stored value is unusable %#', async (key) => {
    storedKey = key;
    await expect(getOrCreateDeviceKey()).resolves.toBe(generatedKey);
    expect(generatedKey).toMatch(/^[a-f0-9]{64}$/);
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledWith(32);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(DEVICE_KEY, generatedKey, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
);

it('shares one identity across concurrent sign-in, verification and reset preparation, only after persistence', async () => {
  const write = deferred<void>();
  jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
    await write.promise;
    if (key === DEVICE_KEY) storedKey = value;
  });
  const settled = jest.fn();
  const requests = Array.from({ length: 6 }, () => getOrCreateDeviceKey().then((key) => {
    settled();
    return key;
  }));
  await Promise.resolve();
  await Promise.resolve();
  expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1);
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  expect(settled).not.toHaveBeenCalled();
  write.resolve();
  await expect(Promise.all(requests)).resolves.toEqual(Array(6).fill(generatedKey));
  expect(storedKey).toBe(generatedKey);
});

it('reuses the persisted identity after creation finishes and through session logout', async () => {
  await expect(getOrCreateDeviceKey()).resolves.toBe(generatedKey);
  await clearSecureSession();
  await expect(getOrCreateDeviceKey()).resolves.toBe(generatedKey);
  await expect(getDeviceKey()).resolves.toBe(generatedKey);
  expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1);
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith(DEVICE_KEY);
});

it('does not rotate the identity when secure storage is temporarily unreadable', async () => {
  storedKey = 'c'.repeat(64);
  const failure = new Error('Secure storage is locked');
  jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(failure);
  await expect(getOrCreateDeviceKey()).rejects.toBe(failure);
  expect(Crypto.getRandomBytesAsync).not.toHaveBeenCalled();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  await expect(getOrCreateDeviceKey()).resolves.toBe(storedKey);
});

it('does not return an unpersisted key and allows retry after a failed write', async () => {
  const failure = new Error('Secure storage write failed');
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(failure);
  await expect(getOrCreateDeviceKey()).rejects.toBe(failure);
  expect(storedKey).toBeNull();
  await expect(getOrCreateDeviceKey()).resolves.toBe(generatedKey);
  expect(storedKey).toBe(generatedKey);
});

it('reconciles a write that persisted but lost its acknowledgement without another key', async () => {
  const failure = new Error('Secure storage acknowledgement failed');
  jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (_key, value) => {
    storedKey = value;
    throw failure;
  });
  await expect(getOrCreateDeviceKey()).rejects.toBe(failure);
  await expect(getOrCreateDeviceKey()).resolves.toBe(generatedKey);
  expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1);
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
});

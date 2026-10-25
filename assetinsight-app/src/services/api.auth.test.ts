import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api, { STORAGE_KEYS } from './api';
import * as storage from './deviceAccessStorage';
import { invalidateAuthOperations } from './authSessionOperation';

jest.mock('axios', () => {
  const client = Object.assign(jest.fn(), { interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } });
  return { __esModule: true, default: { create: jest.fn(() => client), post: jest.fn() } };
});
jest.mock('@react-native-async-storage/async-storage', () => ({ removeItem: jest.fn(), setItem: jest.fn(), multiRemove: jest.fn() }));
jest.mock('./deviceReinstallIdentity', () => ({ getAndroidReinstallId: jest.fn(async () => 'fixture-installation') }));
jest.mock('./appVersion', () => ({ getAppVersionLabel: () => '1.0.1 (build 73)' }));
jest.mock('./deviceAccessStorage', () => ({
  clearSecureSession: jest.fn(), emitRestrictedDeviceAccess: jest.fn(), emitSessionInvalidated: jest.fn(),
  getDeviceKey: jest.fn(async () => 'fixture-device'), getOrCreateDeviceKey: jest.fn(async () => 'fixture-device'),
  getMemoryAccessToken: jest.fn(() => 'old-access'), getRefreshToken: jest.fn(async () => 'secure-refresh'), setMemoryAccessToken: jest.fn(),
}));

const rejectResponse = (api.interceptors.response.use as jest.Mock).mock.calls[0][1] as (error: any) => Promise<unknown>;
const prepareRequest = (api.interceptors.request.use as jest.Mock).mock.calls[0][0] as (config: any) => Promise<any>;
const unauthorized = () => ({ response: { status: 401, data: {} }, config: { headers: {} } });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: any) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => { jest.clearAllMocks(); invalidateAuthOperations(); jest.mocked(storage.getRefreshToken).mockResolvedValue('secure-refresh'); });

it('sends the installed app version with the existing owner and device context', async () => {
  const request = await prepareRequest({ url: '/asset', headers: {} });
  expect(request.headers).toEqual(expect.objectContaining({
    'X-App-Version': '1.0.1 (build 73)',
    'X-Device-Key': 'fixture-device',
    Authorization: 'Bearer old-access',
    'X-Activity-Source': expect.stringMatching(/^(android|ios)$/),
  }));
});

it.each([
  { message: 'Network Error' }, { code: 'ECONNABORTED', message: 'timeout' },
  { response: { status: 503, data: {} } }, { response: { status: 429, data: {} } }, { code: 'ERR_CANCELED' },
])('preserves offline credentials and cached owner on transient refresh failure %#', async (failure) => {
  jest.mocked(axios.post).mockRejectedValueOnce(failure);
  await expect(rejectResponse(unauthorized())).rejects.toBe(failure);
  expect(storage.clearSecureSession).not.toHaveBeenCalled();
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  expect(storage.emitSessionInvalidated).not.toHaveBeenCalled();
  expect(axios.post).toHaveBeenCalledWith(expect.any(String), { token: 'secure-refresh' }, expect.objectContaining({ timeout: 15000 }));
});

it('clears the cached user only when refresh definitively rejects credentials', async () => {
  jest.mocked(axios.post).mockRejectedValueOnce({ response: { status: 401, data: {} } });
  await expect(rejectResponse(unauthorized())).rejects.toBeDefined();
  expect(storage.clearSecureSession).toHaveBeenCalledTimes(1);
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEYS.USER);
  expect(storage.emitSessionInvalidated).toHaveBeenCalledTimes(1);
});

it('keeps ordinary forbidden responses out of authentication refresh', async () => {
  const denied = { response: { status: 403, data: {} }, config: { headers: {} } };
  await expect(rejectResponse(denied)).rejects.toBe(denied);
  expect(axios.post).not.toHaveBeenCalled(); expect(storage.clearSecureSession).not.toHaveBeenCalled();
});

it('never refreshes or replays a one-time Re-Open mutation after a 401', async () => {
  const failure = { ...unauthorized(), config: { url: '/auctioneer/contracts/contract/reopen', headers: {}, skipAuthRefreshReplay: true } };
  await expect(rejectResponse(failure)).rejects.toBe(failure);
  expect(axios.post).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
  expect(storage.clearSecureSession).not.toHaveBeenCalled();
});

it('preserves offline cache for a malformed refresh success', async () => {
  jest.mocked(axios.post).mockResolvedValueOnce({ data: {} });
  await expect(rejectResponse(unauthorized())).rejects.toThrow('incomplete');
  expect(storage.clearSecureSession).not.toHaveBeenCalled(); expect(storage.setMemoryAccessToken).not.toHaveBeenCalled();
});

it('does not restore a late refreshed token after logout or a different sign-in', async () => {
  const response = deferred<any>(); jest.mocked(axios.post).mockReturnValueOnce(response.promise);
  const result = rejectResponse(unauthorized()); const rejected = expect(result).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  invalidateAuthOperations(); response.resolve({ data: { accessToken: 'stale-account-access' } });
  await rejected;
  expect(storage.setMemoryAccessToken).not.toHaveBeenCalled(); expect(storage.clearSecureSession).not.toHaveBeenCalled();
});

it('coalesces transient refresh failure without deleting either waiting request’s offline cache', async () => {
  const response = deferred<any>(); jest.mocked(axios.post).mockReturnValueOnce(response.promise);
  const first = rejectResponse(unauthorized()); const second = rejectResponse(unauthorized());
  const settled = Promise.allSettled([first, second]);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  response.reject(new Error('connection dropped'));
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
  expect(axios.post).toHaveBeenCalledTimes(1); expect(storage.clearSecureSession).not.toHaveBeenCalled();
});

it.each(['login', 'signup', 'verify-email', 'resend-verification-code', 'forgot-password', 'reset-password-code', 'reset-password/fixture-token'])('never refreshes or replays public auth action %s', async (route) => {
  const failure = { ...unauthorized(), config: { url: `/auth/${route}`, headers: {} } };
  await expect(rejectResponse(failure)).rejects.toBe(failure);
  expect(axios.post).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
  expect(storage.clearSecureSession).not.toHaveBeenCalled();
});

it('keeps a device-context input error on the reset screen without expiring the session', async () => {
  const failure = { response: { status: 428, data: { code: 'DEVICE_CONTEXT_REQUIRED', authState: 'registration_required' } }, config: { url: '/auth/reset-password-code' } };
  await expect(rejectResponse(failure)).rejects.toBe(failure);
  expect(storage.clearSecureSession).not.toHaveBeenCalled();
  expect(storage.emitSessionInvalidated).not.toHaveBeenCalled();
  expect(storage.emitRestrictedDeviceAccess).not.toHaveBeenCalled();
});

it('continues enforcing real device rejection on public auth requests', async () => {
  const failure = { response: { status: 403, data: { code: 'DEVICE_REVOKED', authState: 'revoked' } }, config: { url: '/auth/login' } };
  await expect(rejectResponse(failure)).rejects.toBe(failure);
  expect(storage.clearSecureSession).toHaveBeenCalledTimes(1);
  expect(storage.emitRestrictedDeviceAccess).toHaveBeenCalledWith(expect.objectContaining({ authState: 'revoked' }), expect.any(Function));
});

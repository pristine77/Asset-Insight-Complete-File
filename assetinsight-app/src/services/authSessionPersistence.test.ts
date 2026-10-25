import AsyncStorage from '@react-native-async-storage/async-storage';
import api from './api';
import authService from './authService';
import deviceAccessService from './deviceAccessService';
import * as storage from './deviceAccessStorage';
import { invalidateAuthOperations } from './authSessionOperation';
import { buildNativeDeviceContext } from './deviceMetadataService';

jest.mock('@react-native-async-storage/async-storage', () => ({ multiRemove: jest.fn(), setItem: jest.fn(), getItem: jest.fn() }));
jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() }, STORAGE_KEYS: { USER: 'cached-user', SESSION_EXPIRED: 'expired' } }));
jest.mock('./deviceMetadataService', () => ({ buildNativeDeviceContext: jest.fn(async () => ({})), collectVerifiedNativeDeviceContext: jest.fn(async () => ({})) }));
jest.mock('./deviceAccessStorage', () => ({
  clearDeviceAccess: jest.fn(), clearSecureSession: jest.fn(), getMemoryAccessToken: jest.fn(),
  getRefreshToken: jest.fn(async () => 'old-refresh'), migrateLegacyTokens: jest.fn(), persistDeviceAccess: jest.fn(),
  setMemoryAccessToken: jest.fn(), setRefreshToken: jest.fn(), getDeviceKey: jest.fn(async () => 'device'),
  getPersistedDeviceAccess: jest.fn(async () => ({ challengeToken: 'fixture-challenge' })),
}));
const session = { authState: 'authenticated' as const, accessToken: 'fixture-access', refreshToken: 'fixture-refresh', user: { _id: 'owner-a', email: 'fixture@example.test', isVerified: true } };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
beforeEach(() => { jest.clearAllMocks(); invalidateAuthOperations(); jest.mocked(api.post).mockResolvedValue({ data: {} }); jest.mocked(storage.setRefreshToken).mockResolvedValue(undefined); });

it.each(['login', 'exchange'] as const)('rejects a late %s response before it can persist credentials after logout', async (action) => {
  const response = deferred<any>(); jest.mocked(api.post).mockReturnValueOnce(response.promise);
  const pending = action === 'login' ? authService.login({ email: 'fixture@example.test', password: 'fixture' }) : deviceAccessService.exchange();
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await flush(); invalidateAuthOperations(); await authService.logout();
  response.resolve({ data: session }); await rejected;
  expect(storage.setMemoryAccessToken).not.toHaveBeenCalled(); expect(storage.setRefreshToken).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it('serializes logout behind an in-flight secure write so that write cannot resurrect credentials', async () => {
  const secureWrite = deferred<void>(); let token: string | null = 'old-refresh';
  jest.mocked(storage.setRefreshToken).mockImplementationOnce(async (value) => { await secureWrite.promise; token = value; });
  jest.mocked(storage.clearSecureSession).mockImplementationOnce(async () => { token = null; });
  const persisting = authService.acceptAuthenticatedResponse(session);
  const rejected = expect(persisting).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await flush(); expect(storage.setRefreshToken).toHaveBeenCalled();
  invalidateAuthOperations(); const logout = authService.logout(); await flush();
  expect(storage.clearSecureSession).not.toHaveBeenCalled();
  secureWrite.resolve(); await rejected; await logout;
  expect(token).toBeNull(); expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it('does not restore a late profile response to the offline cache', async () => {
  const response = deferred<any>(); jest.mocked(api.get).mockReturnValueOnce(response.promise);
  const profile = authService.refreshCurrentUser();
  invalidateAuthOperations(); await authService.logout(); response.resolve({ data: session.user });
  expect(await profile).toBeNull(); expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it('rejects an incomplete authenticated response before changing the stored session', async () => {
  await expect(authService.acceptAuthenticatedResponse({ ...session, user: null } as any)).rejects.toThrow('incomplete');
  expect(storage.setMemoryAccessToken).not.toHaveBeenCalled(); expect(storage.setRefreshToken).not.toHaveBeenCalled();
  expect(api.get).not.toHaveBeenCalled(); expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
});

const deviceContext = { installationKey: 'd'.repeat(64), platform: 'android' as const, formFactor: 'mobile' as const, displayName: 'Fixture phone', metadata: {} };
const sessionActions = [
  { name: 'login', url: '/auth/login', body: { email: 'fixture@example.test', password: 'fixture' }, run: () => authService.login({ email: 'fixture@example.test', password: 'fixture' }) },
  { name: 'verify', url: '/auth/verify-email', body: { email: 'fixture@example.test', verificationCode: '123456' }, run: () => authService.verifyEmail({ email: 'fixture@example.test', verificationCode: '123456' }) },
  { name: 'reset-code', url: '/auth/reset-password-code', body: { email: 'fixture@example.test', code: '123456', password: 'fixture' }, run: () => authService.resetPasswordByCode({ email: 'fixture@example.test', code: '123456', password: 'fixture' }) },
  { name: 'reset-token', url: '/auth/reset-password/token%2Ffixture', body: { password: 'fixture' }, run: () => authService.resetPassword({ token: 'token/fixture', password: 'fixture' }) },
];

it.each(sessionActions)('sends stable device context for $name before accepting session', async ({ run, url, body }) => {
  jest.mocked(buildNativeDeviceContext).mockResolvedValueOnce(deviceContext);
  jest.mocked(api.post).mockResolvedValueOnce({ data: session });
  await run();
  expect(api.post).toHaveBeenCalledWith(url, { ...body, deviceContext });
  expect(storage.setRefreshToken).toHaveBeenCalledWith('fixture-refresh');
});

it.each(sessionActions)('does not send $name after account changes during device preparation', async ({ run }) => {
  const preparing = deferred<typeof deviceContext>();
  jest.mocked(buildNativeDeviceContext).mockReturnValueOnce(preparing.promise);
  const result = run(); const rejected = expect(result).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  invalidateAuthOperations(); preparing.resolve(deviceContext); await rejected;
  expect(api.post).not.toHaveBeenCalled();
});

it.each(sessionActions)('retains existing session when $name response is malformed', async ({ run }) => {
  jest.mocked(api.post).mockResolvedValueOnce({ data: { message: 'unexpected' } });
  await expect(run()).rejects.toThrow('incomplete');
  expect(storage.clearSecureSession).not.toHaveBeenCalled();
  expect(storage.persistDeviceAccess).not.toHaveBeenCalled();
});

it.each(sessionActions)('does not send $name if durable device identity is unavailable', async ({ run }) => {
  jest.mocked(buildNativeDeviceContext).mockRejectedValueOnce(new Error('Secure storage unavailable'));
  await expect(run()).rejects.toThrow('Secure storage unavailable');
  expect(api.post).not.toHaveBeenCalled();
});

it('sends signup, forgot and resend with the correct contracts and never assumes a session', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { message: 'Request accepted' } });
  await authService.signup({ email: 'fixture@example.test', username: 'Fixture', password: 'fixture' });
  await authService.forgotPassword('fixture@example.test');
  await authService.resendVerificationCode('fixture@example.test');
  expect(api.post).toHaveBeenNthCalledWith(1, '/auth/signup', { email: 'fixture@example.test', username: 'Fixture', password: 'fixture' });
  expect(api.post).toHaveBeenNthCalledWith(2, '/auth/forgot-password', { email: 'fixture@example.test', clientType: 'mobile' });
  expect(api.post).toHaveBeenNthCalledWith(3, '/auth/resend-verification-code', { email: 'fixture@example.test' });
  expect(storage.setRefreshToken).not.toHaveBeenCalled();
});

it.each([
  { ...session, accessToken: '   ' }, { ...session, refreshToken: {} },
  { ...session, user: { ...session.user, _id: {} } },
  { authState: 'pending' }, { authState: 'registration_required', challengeToken: ' ' },
])('rejects malformed session receipts before clearing or writing secure storage %#', async (receipt) => {
  jest.mocked(api.post).mockResolvedValueOnce({ data: receipt });
  await expect(authService.login({ email: 'fixture@example.test', password: 'fixture' })).rejects.toThrow('incomplete');
  expect(storage.clearSecureSession).not.toHaveBeenCalled();
  expect(storage.setRefreshToken).not.toHaveBeenCalled();
  expect(storage.setMemoryAccessToken).not.toHaveBeenCalled();
  expect(storage.persistDeviceAccess).not.toHaveBeenCalled();
});

it.each(['registration_required', 'pending', 'rerequest_pending', 'rejected', 'revoked', 'ip_blocked'])('retains a valid %s response without issuing a session', async (authState) => {
  const receipt = { authState, ...(authState === 'ip_blocked' ? {} : { challengeToken: 'fixture-challenge' }) };
  jest.mocked(api.post).mockResolvedValueOnce({ data: receipt });
  await expect(authService.login({ email: 'fixture@example.test', password: 'fixture' })).resolves.toEqual(receipt);
  expect(storage.persistDeviceAccess).toHaveBeenCalledWith(receipt, expect.any(Function));
  expect(storage.setRefreshToken).not.toHaveBeenCalled();
});

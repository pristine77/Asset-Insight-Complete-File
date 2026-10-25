import api from './api';
import authService from './authService';
import deviceAccessService from './deviceAccessService';
import { getDeviceKey, getPersistedDeviceAccess, persistDeviceAccess } from './deviceAccessStorage';
import { captureAuthOperation, invalidateAuthOperations } from './authSessionOperation';
import { collectVerifiedNativeDeviceContext } from './deviceMetadataService';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./authService', () => ({ __esModule: true, default: { acceptAuthenticatedResponse: jest.fn(async value => value) } }));
jest.mock('./deviceAccessStorage', () => ({ getDeviceKey: jest.fn(), getPersistedDeviceAccess: jest.fn(), persistDeviceAccess: jest.fn() }));
jest.mock('./deviceMetadataService', () => ({ collectVerifiedNativeDeviceContext: jest.fn(async () => ({ platform: 'android', formFactor: 'mobile', metadata: {} })) }));

const enrollmentToken = 'e'.repeat(43);
const statusToken = 's'.repeat(43);
const approved = () => ({ authState: 'approved' as const, challengeToken: statusToken, challengeExpiresAt: new Date(Date.now() + 60_000).toISOString() });
const session = { authState: 'authenticated', user: { _id: 'owner-a' }, accessToken: 'fixture-access', refreshToken: 'fixture-refresh' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

beforeEach(() => {
  jest.resetAllMocks(); invalidateAuthOperations();
  jest.mocked(collectVerifiedNativeDeviceContext).mockResolvedValue({ platform: 'android', formFactor: 'mobile', metadata: {} } as any);
  jest.mocked(getDeviceKey).mockResolvedValue('k'.repeat(64));
  jest.mocked(getPersistedDeviceAccess).mockResolvedValue({ authState: 'registration_required', challengeToken: enrollmentToken });
  jest.mocked(authService.acceptAuthenticatedResponse).mockImplementation(async value => value);
});

it('exchanges the new status challenge on the first automatically approved registration without publishing a restriction', async () => {
  jest.mocked(api.post).mockResolvedValueOnce({ data: approved() }).mockImplementationOnce(async (_url, _body, config) => {
    if (config?.headers?.Authorization !== `Bearer ${statusToken}`) throw new Error('Consumed enrollment challenge');
    return { data: session };
  });
  const guard = captureAuthOperation();
  const registration = await deviceAccessService.register(guard);
  if (registration.authState !== 'approved') throw new Error('Expected approved registration');
  await expect(deviceAccessService.exchange(guard, registration)).resolves.toEqual(session);
  expect(jest.mocked(api.post).mock.calls[0][2]?.headers?.Authorization).toBe(`Bearer ${enrollmentToken}`);
  expect(jest.mocked(api.post).mock.calls[1][2]?.headers?.Authorization).toBe(`Bearer ${statusToken}`);
  expect(persistDeviceAccess).not.toHaveBeenCalled();
  expect(authService.acceptAuthenticatedResponse).toHaveBeenCalledWith(session, guard);
});

it('keeps the normal pending registration, approval-status and persisted-challenge exchange flow', async () => {
  const pending = { ...approved(), authState: 'pending' as const };
  jest.mocked(api.post).mockResolvedValueOnce({ data: pending }).mockResolvedValueOnce({ data: session });
  jest.mocked(persistDeviceAccess).mockImplementation(async value => {
    jest.mocked(getPersistedDeviceAccess).mockResolvedValue(value); return value;
  });
  await expect(deviceAccessService.register()).resolves.toEqual(pending);
  expect(persistDeviceAccess).toHaveBeenCalledWith(pending, expect.any(Function));
  jest.mocked(api.get).mockResolvedValueOnce({ data: { status: 'approved' } });
  await expect(deviceAccessService.status()).resolves.toEqual({ status: 'approved' });
  await expect(deviceAccessService.exchange()).resolves.toEqual(session);
  expect(jest.mocked(api.post).mock.calls[1][2]?.headers?.Authorization).toBe(`Bearer ${statusToken}`);
});

it.each([
  { challengeToken: undefined }, { challengeToken: '' }, { challengeToken: '   ' },
  { challengeToken: 'bad\r\nheader' }, { challengeToken: 123 },
  { challengeExpiresAt: undefined }, { challengeExpiresAt: 'not-a-date' }, { challengeExpiresAt: '2000-01-01T00:00:00Z' },
])('rejects incomplete automatically approved registration before exchange: %j', async invalid => {
  jest.mocked(api.post).mockResolvedValueOnce({ data: { ...approved(), ...invalid } });
  await expect(deviceAccessService.register()).rejects.toThrow(/approval response was incomplete|expired/i);
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(persistDeviceAccess).not.toHaveBeenCalled();
  expect(authService.acceptAuthenticatedResponse).not.toHaveBeenCalled();
});

it('rejects a malformed explicit challenge instead of falling back to a previous account challenge', async () => {
  await expect(deviceAccessService.exchange(captureAuthOperation(), { ...approved(), challengeToken: '' })).rejects.toThrow(/approval response was incomplete/i);
  expect(api.post).not.toHaveBeenCalled();
});

it('rejects a registration response that arrives after the account operation changes', async () => {
  const response = deferred<any>(); jest.mocked(api.post).mockReturnValueOnce(response.promise);
  const request = deviceAccessService.register();
  const rejected = expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  invalidateAuthOperations(); response.resolve({ data: approved() }); await rejected;
  expect(persistDeviceAccess).not.toHaveBeenCalled();
  expect(authService.acceptAuthenticatedResponse).not.toHaveBeenCalled();
});

it('does not send an approval exchange if the account changes while the device key is read', async () => {
  const key = deferred<string | null>(); jest.mocked(getDeviceKey).mockReturnValueOnce(key.promise);
  const request = deviceAccessService.exchange(captureAuthOperation(), approved());
  const rejected = expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  invalidateAuthOperations(); key.resolve('k'.repeat(64)); await rejected;
  expect(api.post).not.toHaveBeenCalled();
});

it('does not persist a session from a late approval exchange', async () => {
  const response = deferred<any>(); jest.mocked(api.post).mockReturnValueOnce(response.promise);
  const request = deviceAccessService.exchange(captureAuthOperation(), approved());
  const rejected = expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  invalidateAuthOperations(); response.resolve({ data: session }); await rejected;
  expect(authService.acceptAuthenticatedResponse).not.toHaveBeenCalled();
});

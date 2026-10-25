import React from 'react';
import { Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { AuthProvider, useAuth } from './AuthContext';
import authService from '../services/authService';
import deviceAccessService from '../services/deviceAccessService';
import AutoSaveService from '../services/autoSaveService';
import CaptureBackupService from '../services/captureBackupService';
import NetInfo from '@react-native-community/netinfo';

let mockOwner: string | null = null;
let mockDeviceListener: (state: any) => void;
jest.mock('../services/authService', () => ({ __esModule: true, default: { login: jest.fn(), logout: jest.fn(), isAuthenticated: jest.fn(), getCurrentUser: jest.fn(), refreshCurrentUser: jest.fn() } }));
jest.mock('../services/deviceAccessService', () => ({ __esModule: true, default: { status: jest.fn(), exchange: jest.fn(), register: jest.fn(), rerequest: jest.fn() } }));
jest.mock('../services/offlineQueueService', () => ({ __esModule: true, default: { init: jest.fn(), cleanup: jest.fn() } }));
jest.mock('../services/notificationService', () => ({ unregisterStoredPushTokenFromServer: jest.fn(async () => undefined) }));
jest.mock('../services/offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: () => mockOwner, initialize: jest.fn(async () => undefined) } }));
jest.mock('../services/autoSaveService', () => ({ __esModule: true, default: { setOwner: jest.fn((owner) => { mockOwner = owner; }) } }));
jest.mock('../services/offlineCaptureSync', () => ({ __esModule: true, default: { cleanup: jest.fn() } }));
jest.mock('../services/captureBackupService', () => ({ __esModule: true, default: { deactivate: jest.fn(async () => undefined) } }));
jest.mock('../services/uploadCancellation', () => ({ pauseActiveUploads: jest.fn() }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn() } }));
jest.mock('../services/deviceAccessStorage', () => ({
  getPersistedDeviceAccess: jest.fn(async () => null),
  subscribeDeviceAccess: jest.fn((listener) => { mockDeviceListener = listener; return () => undefined; }),
  subscribeSessionInvalidated: jest.fn(() => () => undefined),
}));
let auth!: ReturnType<typeof useAuth>;
const user = { _id: 'owner-a', email: 'fixture@example.test', isVerified: true };
const authenticated = { authState: 'authenticated' as const, user, accessToken: 'fixture-access', refreshToken: 'fixture-refresh' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
function Probe() { auth = useAuth(); return <Text>{auth.user?._id || 'no-owner'}</Text>; }
async function open() { await render(<AuthProvider><Probe /></AuthProvider>); await screen.findByText('owner-a'); }
beforeEach(() => {
  jest.clearAllMocks(); mockOwner = null;
  jest.mocked(authService.isAuthenticated).mockResolvedValue(true);
  jest.mocked(authService.getCurrentUser).mockResolvedValue(user);
  jest.mocked(authService.refreshCurrentUser).mockResolvedValue(null);
  jest.mocked(authService.logout).mockResolvedValue(undefined);
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: false, isInternetReachable: false } as any);
});

it('opens the cached owner when a connection drops during current-user refresh', async () => {
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: true, isInternetReachable: true } as any);
  await open(); expect(mockOwner).toBe('owner-a'); expect(auth.isAuthenticated).toBe(true);
  expect(CaptureBackupService.deactivate).not.toHaveBeenCalled();
});

it('cannot rebind the owner when approval exchange finishes after logout', async () => {
  await open(); const exchange = deferred<any>();
  jest.mocked(deviceAccessService.status).mockResolvedValue({ status: 'approved' } as any);
  jest.mocked(deviceAccessService.exchange).mockReturnValue(exchange.promise);
  let request!: Promise<void>;
  await act(() => { request = auth.refreshDeviceStatus(); });
  const rejected = expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await act(async () => { await auth.logout(); });
  await act(async () => { exchange.resolve(authenticated); await rejected; });
  expect(mockOwner).toBeNull(); expect(auth.user).toBeNull();
  expect(jest.mocked(AutoSaveService.setOwner).mock.calls.at(-1)).toEqual([null]);
  expect(CaptureBackupService.deactivate).toHaveBeenCalled();
});

it('cannot rebind the owner when a login response arrives after device restriction', async () => {
  await open(); const login = deferred<any>(); jest.mocked(authService.login).mockReturnValue(login.promise);
  let request!: Promise<any>;
  await act(() => { request = auth.login({ email: 'fixture@example.test', password: 'fixture' }); });
  const rejected = expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await act(() => mockDeviceListener({ authState: 'revoked' }));
  await act(async () => { login.resolve(authenticated); await rejected; });
  expect(mockOwner).toBeNull(); expect(auth.user).toBeNull(); expect(auth.deviceAccess?.authState).toBe('revoked');
  expect(CaptureBackupService.deactivate).toHaveBeenCalled();
});

it('cannot rebind the owner when login completes after logout', async () => {
  await open(); const login = deferred<any>(); jest.mocked(authService.login).mockReturnValue(login.promise);
  let request!: Promise<any>;
  await act(() => { request = auth.login({ email: 'fixture@example.test', password: 'fixture' }); });
  const rejected = expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await act(async () => { await auth.logout(); });
  await act(async () => { login.resolve(authenticated); await rejected; });
  expect(mockOwner).toBeNull(); expect(auth.user).toBeNull();
});

it('finishes loading when the current login publishes its own pending-device decision', async () => {
  await open();
  jest.mocked(authService.login).mockImplementationOnce(async () => {
    const pending = { authState: 'pending' as const }; mockDeviceListener(pending); return pending;
  });
  await act(async () => { await auth.login({ email: 'fixture@example.test', password: 'fixture' }); });
  expect(auth.loading).toBe(false); expect(auth.deviceAccess?.authState).toBe('pending'); expect(mockOwner).toBeNull();
});

it('accepts a current approval exchange without losing the owner binding', async () => {
  await open();
  jest.mocked(deviceAccessService.status).mockResolvedValue({ status: 'approved' } as any);
  jest.mocked(deviceAccessService.exchange).mockResolvedValue(authenticated);
  await act(async () => { await auth.refreshDeviceStatus(); });
  expect(auth.user?._id).toBe('owner-a'); expect(auth.deviceAccess).toBeNull();
});

it('passes the newly issued challenge from automatic registration into the first approval exchange', async () => {
  await open();
  const registration = { authState: 'approved' as const, challengeToken: 's'.repeat(43), challengeExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  jest.mocked(deviceAccessService.register).mockResolvedValue(registration);
  jest.mocked(deviceAccessService.exchange).mockResolvedValue(authenticated);
  await act(async () => { await auth.registerDevice(); });
  expect(deviceAccessService.exchange).toHaveBeenCalledWith(expect.any(Function), registration);
  expect(auth.user?._id).toBe('owner-a'); expect(auth.deviceAccess).toBeNull();
});

it('does not exchange a newly approved registration after logout changes the account operation', async () => {
  await open(); const registration = deferred<any>();
  jest.mocked(deviceAccessService.register).mockReturnValue(registration.promise);
  let request!: Promise<void>;
  await act(() => { request = auth.registerDevice(); });
  const rejected = expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  await act(async () => { await auth.logout(); });
  await act(async () => {
    registration.resolve({ authState: 'approved', challengeToken: 's'.repeat(43), challengeExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    await rejected;
  });
  expect(deviceAccessService.exchange).not.toHaveBeenCalled();
  expect(mockOwner).toBeNull(); expect(auth.user).toBeNull();
});

import axios, { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import API from '@/lib/api';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '@/lib/auth-storage';
import { clearStoredDeviceAccess, getStoredDeviceAccess } from '@/lib/device-access';
import { AuthService, authErrorMessage } from './auth';

const authenticated = { authState: 'authenticated', user: { _id: 'test-user', email: 'test@example.invalid' }, accessToken: 'fixture-access', refreshToken: 'fixture-refresh' };
const pending = { authState: 'pending', code: 'DEVICE_PENDING', challengeToken: 'fixture-challenge' };
const response = (config: InternalAxiosRequestConfig, data: unknown, status = 200) => ({ config, data, status, statusText: 'Fixture', headers: new AxiosHeaders() });
const fail = (config: InternalAxiosRequestConfig, status: number, data: unknown) => new AxiosError(`Request failed with status code ${status}`, undefined, config, undefined, response(config, data, status));
const flows = [
  ['login', () => AuthService.login({ email: 'test@example.invalid', password: 'fixture' })],
  ['verify', () => AuthService.verifyEmail({ email: 'test@example.invalid', verificationCode: '123456' })],
  ['reset code', () => AuthService.resetPasswordByCode({ email: 'test@example.invalid', code: '123456', password: 'fixture' })],
  ['reset link', () => AuthService.resetPassword({ token: 'fixture-token', password: 'fixture' })],
] as const;

describe('public authentication contracts', () => {
  beforeEach(() => {
    clearTokens(); clearStoredDeviceAccess();
    API.defaults.adapter = async () => { throw new Error('Unexpected request: test network is disabled'); };
  });

  it('uses one valid installation identity in the body and header across every session-creating flow', async () => {
    const keys: string[] = [];
    API.defaults.adapter = async (config) => {
      const context = JSON.parse(config.data).deviceContext;
      expect(context).toMatchObject({ platform: 'web' });
      expect(['desktop', 'tablet', 'mobile']).toContain(context.formFactor);
      expect(context.installationKey.length).toBeGreaterThanOrEqual(32);
      expect(config.headers['X-Device-Key']).toBe(context.installationKey);
      keys.push(context.installationKey);
      return response(config, authenticated);
    };
    for (const [, flow] of flows) await flow();
    expect(new Set(keys).size).toBe(1);
  });

  it.each(flows)('%s preserves the device approval response without dispatching an invalidating event', async (_name, flow) => {
    const restricted = vi.fn(), invalidated = vi.fn();
    window.addEventListener('device-access-restricted', restricted);
    window.addEventListener('auth-session-invalidated', invalidated);
    try {
      API.defaults.adapter = async (config) => { throw fail(config, 403, pending); };
      expect(await flow()).toEqual(pending);
      expect(getStoredDeviceAccess()).toEqual(pending);
      expect(getAccessToken()).toBeNull();
      expect(restricted).not.toHaveBeenCalled();
      expect(invalidated).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('device-access-restricted', restricted);
      window.removeEventListener('auth-session-invalidated', invalidated);
    }
  });

  it.each(flows)('%s exposes a missing installation error without inventing a usable device challenge', async (_name, flow) => {
    API.defaults.adapter = async (config) => { throw fail(config, 428, { authState: 'registration_required', code: 'DEVICE_CONTEXT_REQUIRED', message: 'A valid device installation key is required.' }); };
    await expect(flow()).rejects.toThrow('A valid device installation key is required.');
    expect(getStoredDeviceAccess()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it.each(flows)('%s preserves the specific invalid-code or password guidance', async (_name, flow) => {
    API.defaults.adapter = async (config) => { throw fail(config, 400, { message: 'The code has expired. Request another code.' }); };
    await expect(flow()).rejects.toThrow('The code has expired. Request another code.');
  });

  it.each([
    {}, { authState: 'authenticated' }, { authState: 'pending' }, { authState: 'unexpected' },
    { ...authenticated, accessToken: ' \t\n' },
    { ...authenticated, refreshToken: ' \t\n' },
    { ...authenticated, user: { ...authenticated.user, _id: ' \t\n' } },
    { ...authenticated, user: { ...authenticated.user, _id: 123 } },
    { ...authenticated, user: { ...authenticated.user, _id: { id: 'invalid' } } },
    { ...pending, challengeToken: ' \t\n' },
    { ...pending, challengeToken: { token: 'invalid' } },
  ])('does not claim authentication for an incomplete receipt: %j', async (data) => {
    API.defaults.adapter = async (config) => response(config, data);
    await expect(AuthService.resetPasswordByCode({ email: 'test@example.invalid', code: '123456', password: 'fixture' })).rejects.toThrow('response was incomplete');
    expect(getAccessToken()).toBeNull(); expect(getStoredDeviceAccess()).toBeNull();
  });

  it('validates nonblank authentication values without rewriting the receipt', async () => {
    const receipt = { ...authenticated, accessToken: ' exact-access ', refreshToken: ' exact-refresh ', user: { ...authenticated.user, _id: ' exact-user ' } };
    API.defaults.adapter = async (config) => response(config, receipt);
    expect(await AuthService.login({ email: 'test@example.invalid', password: 'fixture' })).toEqual(receipt);
    expect(getAccessToken()).toBe(receipt.accessToken);
    expect(getRefreshToken()).toBe(receipt.refreshToken);
  });

  it('encodes a reset link token as one path segment', async () => {
    const token = 'fixture/token?query=ignored#fragment';
    API.defaults.adapter = async (config) => {
      expect(config.url).toBe(`/auth/reset-password/${encodeURIComponent(token)}`);
      return response(config, authenticated);
    };
    await expect(AuthService.resetPassword({ token, password: 'fixture' })).resolves.toEqual(authenticated);
  });

  it.each([
    ['signup', () => AuthService.signup({ email: 'test@example.invalid', password: 'fixture' })],
    ['forgot', () => AuthService.forgotPassword({ email: 'test@example.invalid' })],
    ['resend verification', () => AuthService.resendVerificationCode('test@example.invalid')],
  ] as const)('%s never refreshes or silently repeats a public mutation after 401', async (_name, flow) => {
    setTokens({ accessToken: 'existing-access', refreshToken: 'existing-refresh' });
    const refresh = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected refresh'));
    const calls: string[] = [];
    API.defaults.adapter = async (config) => { calls.push(config.url || ''); throw fail(config, 401, { message: 'Please check your request.' }); };
    await expect(flow()).rejects.toMatchObject({ response: { status: 401 } });
    expect(calls).toHaveLength(1); expect(refresh).not.toHaveBeenCalled();
    expect(getRefreshToken()).toBe('existing-refresh');
  });

  it('keeps the deliberate web reset-code request mode', async () => {
    API.defaults.adapter = async (config) => {
      expect(JSON.parse(config.data)).toEqual({ email: 'test@example.invalid', clientType: 'mobile' });
      return response(config, { message: 'If an account exists, a code has been sent.' });
    };
    expect(await AuthService.forgotPassword({ email: 'test@example.invalid' })).toMatchObject({ message: expect.any(String) });
  });

  it('renders only safe message strings and keeps server/transport failures uncertain', () => {
    expect(authErrorMessage({ response: { status: 429, data: { message: 'Please wait before requesting another code.' } } }, 'Fallback')).toBe('Please wait before requesting another code.');
    expect(authErrorMessage({ response: { status: 400, data: { message: {} } } }, 'Fallback')).toBe('Fallback');
    expect(authErrorMessage({ response: { status: 503, data: { message: '<html>Proxy error</html>' } } }, 'Fallback')).toBe('Fallback');
    expect(authErrorMessage(new Error('Network Error'), 'Fallback')).toBe('Fallback');
  });
});

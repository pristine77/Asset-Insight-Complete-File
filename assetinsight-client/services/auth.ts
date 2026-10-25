import API, { type RetriableAxiosConfig } from '@/lib/api';
import { advanceAuthSession, assertAuthSessionCurrent, captureAuthSession, clearTokens, getAccessToken, getRefreshToken, setTokens, type AuthSessionSnapshot } from '@/lib/auth-storage';
import {
  buildBasicDeviceContext,
  clearStoredDeviceAccess,
  storeDeviceAccess,
  type RestrictedDeviceAccess,
} from '@/lib/device-access';

export type SignupPayload = {
  email: string;
  password: string;
  username?: string;
  companyName?: string;
  contactEmail?: string;
  contactPhone?: string;
  companyAddress?: string;
};

export type LoginPayload = {
  email: string;
  password: string;
};

export type AuthenticatedResponse = {
  authState: 'authenticated';
  message?: string;
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
  device?: { id: string; status: string; displayName?: string };
};

export type AuthResponse = AuthenticatedResponse | RestrictedDeviceAccess;

export type VerifyEmailPayload = {
  email: string;
  verificationCode: string;
};

export type ForgotPasswordPayload = {
  email: string;
};

export type ResetPasswordPayload = {
  token: string;
  password: string;
};

export type ResetPasswordCodePayload = {
  email: string;
  code: string;
  password: string;
};

export type AuthUser = {
  _id: string;
  id?: string;
  email: string;
  username?: string;
  companyName?: string;
  contactEmail?: string;
  contactPhone?: string;
  companyAddress?: string;
  isVerified?: boolean;
  isReportApprover?: boolean;
  isReleaseManager?: boolean;
  proposalValuationEnabled?: boolean;
  isCrmAgent?: boolean;
  role?: 'user' | 'admin' | 'superadmin';
  crmAddress?: string;
  crmQuadrant?: string;
  crmSpecializations?: string[];
  avatarUrl?: string;
  avatarUploadedAt?: string;
  authProvider?: string;
  createdAt?: string;
  updatedAt?: string;
};

async function deviceAwarePayload<T extends Record<string, unknown>>(payload: T) {
  return { ...payload, deviceContext: await buildBasicDeviceContext() };
}

function applyAuthResponse(data: AuthResponse) {
  if (data.authState === 'authenticated') {
    setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    clearStoredDeviceAccess();
  } else {
    clearTokens();
    storeDeviceAccess(data);
  }
  return data;
}

const authOptions = (session: AuthSessionSnapshot): RetriableAxiosConfig => ({ _retry: true, _authSession: session });

const nonblankString = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());

function completedAuthResponse(data: unknown): data is AuthResponse {
  if (!data || typeof data !== 'object') return false;
  const value = data as Partial<RestrictedDeviceAccess>;
  // The authenticated and restricted variants have distinct required evidence.
  const state = (data as { authState?: unknown }).authState;
  if (state === 'authenticated') {
    const authenticated = data as Partial<AuthenticatedResponse>;
    return nonblankString(authenticated.accessToken) && nonblankString(authenticated.refreshToken) &&
      nonblankString(authenticated.user?._id);
  }
  if (state === 'ip_blocked') return true;
  return ['registration_required', 'pending', 'rerequest_pending', 'rejected', 'revoked'].includes(String(state)) &&
    nonblankString(value.challengeToken);
}

export function authErrorMessage(error: unknown, fallback: string): string {
  const response = (error as { response?: { status?: number; data?: { message?: unknown } } } | null)?.response;
  const message = response?.data?.message;
  if (typeof message === 'string' && message.trim() && (response?.status || 0) < 500) return message;
  if (response) return fallback;
  return error instanceof Error && error.message && error.message !== 'Network Error' ? error.message : fallback;
}

async function authenticate(path: string, payload: Record<string, unknown>, fallback: string): Promise<AuthResponse> {
  const session = advanceAuthSession();
  try {
    const body = await deviceAwarePayload(payload);
    assertAuthSessionCurrent(session);
    const { data } = await API.post<AuthResponse>(path, body, authOptions(session));
    assertAuthSessionCurrent(session);
    if (!completedAuthResponse(data)) throw new Error('The sign-in response was incomplete. Please sign in again.');
    return applyAuthResponse(data);
  } catch (error: unknown) {
    assertAuthSessionCurrent(session);
    const restricted = (error as { response?: { data?: unknown } } | null)?.response?.data;
    if (completedAuthResponse(restricted) && restricted.authState !== 'authenticated') return applyAuthResponse(restricted);
    throw new Error(authErrorMessage(error, fallback));
  }
}

export const AuthService = {
  async signup(payload: SignupPayload): Promise<{ message: string }> {
    const { data } = await API.post<{ message: string }>('/auth/signup', payload, authOptions(captureAuthSession()));
    return data;
  },

  async login(payload: LoginPayload): Promise<AuthResponse> {
    return authenticate('/auth/login', payload, 'Unable to sign in. Check your connection and try again.');
  },

  async verifyEmail(payload: VerifyEmailPayload): Promise<AuthResponse & { message?: string }> {
    return authenticate('/auth/verify-email', payload, 'Unable to verify your email. Check your connection and try again.');
  },

  async resendVerificationCode(email: string): Promise<{ message: string }> {
    const { data } = await API.post<{ message: string }>('/auth/resend-verification-code', { email }, authOptions(captureAuthSession()));
    return data;
  },

  async forgotPassword(payload: ForgotPasswordPayload): Promise<{ message: string }> {
    const { data } = await API.post<{ message: string }>('/auth/forgot-password', {
      ...payload,
      clientType: 'mobile',
    }, authOptions(captureAuthSession()));
    return data;
  },

  async resetPasswordByCode(payload: ResetPasswordCodePayload): Promise<AuthResponse & { message?: string }> {
    return authenticate('/auth/reset-password-code', payload, 'Unable to confirm the password reset. Try signing in with the new password before requesting another code.');
  },

  async resetPassword(payload: ResetPasswordPayload): Promise<AuthResponse & { message?: string }> {
    return authenticate(`/auth/reset-password/${encodeURIComponent(payload.token)}`, { password: payload.password }, 'Unable to confirm the password reset. Try signing in with the new password before requesting another link.');
  },

  async logout() {
    const refreshToken = getRefreshToken();
    const accessToken = getAccessToken();
    clearTokens();
    clearStoredDeviceAccess();
    const session = captureAuthSession();
    if (refreshToken) {
      // Logout is locally complete immediately; a late receipt cannot clear a later login.
      await API.post('/auth/logout', { token: refreshToken }, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
        timeout: 15_000,
        _retry: true,
        _authSession: session,
      } as RetriableAxiosConfig).catch(() => {});
    }
  },
};

import AsyncStorage from "@react-native-async-storage/async-storage";
import api, { STORAGE_KEYS } from "./api";
import { API_ENDPOINTS } from "../config/api";
import { buildNativeDeviceContext } from "./deviceMetadataService";
import { captureAuthOperation, mutateAuthSession } from './authSessionOperation';
import {
  clearDeviceAccess,
  clearSecureSession,
  getMemoryAccessToken,
  getRefreshToken,
  migrateLegacyTokens,
  persistDeviceAccess,
  setMemoryAccessToken,
  setRefreshToken,
  type RestrictedDeviceAccess,
} from "./deviceAccessStorage";

export interface User {
  _id: string;
  email: string;
  username?: string;
  companyName?: string;
  contactEmail?: string;
  contactPhone?: string;
  companyAddress?: string;
  crmAddress?: string;
  crmQuadrant?: string;
  crmSpecializations?: string[];
  isVerified: boolean;
  isCrmAgent?: boolean;
  isReportApprover?: boolean;
  isReleaseManager?: boolean;
  crmAssignedAt?: string;
  role?: string;
  createdAt?: string;
}

export interface LoginResponse {
  authState: "authenticated";
  accessToken: string;
  refreshToken: string;
  user: User;
}

export type AuthResponse = LoginResponse | RestrictedDeviceAccess;

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface SignupPayload {
  email: string;
  password: string;
  username: string;
  companyName?: string;
  contactEmail?: string;
  contactPhone?: string;
  companyAddress?: string;
  crmSpecializations?: string[];
}

export interface VerifyEmailPayload {
  email: string;
  verificationCode: string;
}

export interface AuthMessageResponse {
  message: string;
}

export interface ResetPasswordPayload {
  token: string;
  password: string;
}

export interface ResetPasswordCodePayload {
  email: string;
  code: string;
  password: string;
}

class AuthService {
  private async persistSession(accessToken: string, refreshToken: string, user: User, assertCurrent: () => void) {
    assertCurrent();
    await AsyncStorage.multiRemove([STORAGE_KEYS.SESSION_EXPIRED]);
    assertCurrent();
    setMemoryAccessToken(accessToken);
    await setRefreshToken(refreshToken);
    assertCurrent();
    await clearDeviceAccess(assertCurrent);
    assertCurrent();

    await AsyncStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
    assertCurrent();
    return user;
  }

  private async applyAuthResponse(data: AuthResponse, assertCurrent = captureAuthOperation()): Promise<AuthResponse> {
    const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    if (!data || !['authenticated', 'registration_required', 'pending', 'rerequest_pending', 'rejected', 'revoked', 'ip_blocked'].includes(data.authState)) {
      throw new Error('The sign-in response was incomplete. Please try signing in again.');
    }
    if (data.authState === 'authenticated') {
      if (!data.user || !nonblank(data.user._id || (data.user as any).id) || !nonblank(data.accessToken) || !nonblank(data.refreshToken)) {
        throw new Error('The sign-in response was incomplete. Please sign in again.');
      }
    } else if (data.authState !== 'ip_blocked' && !nonblank(data.challengeToken)) {
      throw new Error('The device approval response was incomplete. Please sign in again.');
    }
    return mutateAuthSession(assertCurrent, async () => {
      if (data.authState === "authenticated") {
        const user = await this.persistSession(data.accessToken, data.refreshToken, data.user, assertCurrent);
        return { ...data, user };
      }
      await clearSecureSession();
      assertCurrent();
      await AsyncStorage.multiRemove([STORAGE_KEYS.USER, STORAGE_KEYS.SESSION_EXPIRED]);
      assertCurrent();
      await persistDeviceAccess(data, assertCurrent);
      return data;
    });
  }

  async acceptAuthenticatedResponse(data: LoginResponse, assertCurrent = captureAuthOperation()): Promise<LoginResponse> {
    return (await this.applyAuthResponse(data, assertCurrent)) as LoginResponse;
  }

  async login(credentials: LoginCredentials, assertCurrent = captureAuthOperation()): Promise<AuthResponse> {
    const deviceContext = await buildNativeDeviceContext();
    assertCurrent();
    const { data } = (await api.post(API_ENDPOINTS.LOGIN, {
      ...credentials,
      deviceContext,
    })) as { data: AuthResponse };
    return this.applyAuthResponse(data, assertCurrent);
  }

  async signup(payload: SignupPayload): Promise<AuthMessageResponse> {
    const { data } = await api.post(API_ENDPOINTS.SIGNUP, payload) as { data: AuthMessageResponse };
    return data;
  }

  async verifyEmail(payload: VerifyEmailPayload): Promise<AuthResponse & AuthMessageResponse> {
    const assertCurrent = captureAuthOperation();
    const deviceContext = await buildNativeDeviceContext();
    assertCurrent();
    const { data } = await api.post(API_ENDPOINTS.VERIFY_EMAIL, {
      ...payload,
      deviceContext,
    }) as {
      data: AuthResponse & AuthMessageResponse;
    };
    return this.applyAuthResponse(data, assertCurrent) as Promise<AuthResponse & AuthMessageResponse>;
  }

  async resendVerificationCode(email: string): Promise<AuthMessageResponse> {
    const { data } = await api.post(API_ENDPOINTS.RESEND_VERIFICATION_CODE, { email }) as {
      data: AuthMessageResponse;
    };
    return data;
  }

  async forgotPassword(email: string): Promise<AuthMessageResponse> {
    const { data } = await api.post(API_ENDPOINTS.FORGOT_PASSWORD, {
      email,
      clientType: "mobile",
    }) as { data: AuthMessageResponse };
    return data;
  }

  async resetPassword(payload: ResetPasswordPayload): Promise<AuthResponse & AuthMessageResponse> {
    const assertCurrent = captureAuthOperation();
    const { token, password } = payload;
    const deviceContext = await buildNativeDeviceContext();
    assertCurrent();
    const { data } = await api.post(
      `${API_ENDPOINTS.RESET_PASSWORD}/${encodeURIComponent(token)}`,
      { password, deviceContext }
    ) as {
      data: AuthResponse & AuthMessageResponse;
    };
    return this.applyAuthResponse(data, assertCurrent) as Promise<AuthResponse & AuthMessageResponse>;
  }

  async resetPasswordByCode(payload: ResetPasswordCodePayload): Promise<AuthResponse & AuthMessageResponse> {
    const assertCurrent = captureAuthOperation();
    const deviceContext = await buildNativeDeviceContext();
    assertCurrent();
    const { data } = await api.post(API_ENDPOINTS.RESET_PASSWORD_CODE, {
      ...payload,
      deviceContext,
    }) as {
      data: AuthResponse & AuthMessageResponse;
    };
    return this.applyAuthResponse(data, assertCurrent) as Promise<AuthResponse & AuthMessageResponse>;
  }

  async logout(): Promise<void> {
    const assertCurrent = captureAuthOperation();
    try {
      const refreshToken = await getRefreshToken();
      assertCurrent();
      if (refreshToken) {
        await api.post(API_ENDPOINTS.LOGOUT, { token: refreshToken }).catch(() => {});
      }
    } finally {
      await mutateAuthSession(assertCurrent, async () => {
        await clearSecureSession(); assertCurrent();
        await clearDeviceAccess(assertCurrent); assertCurrent();
        await AsyncStorage.multiRemove([STORAGE_KEYS.USER, STORAGE_KEYS.SESSION_EXPIRED]);
      });
    }
  }

  async getCurrentUser(): Promise<User | null> {
    try {
      const userStr = await AsyncStorage.getItem(STORAGE_KEYS.USER);
      if (userStr) {
        return JSON.parse(userStr);
      }
      return null;
    } catch {
      return null;
    }
  }

  async refreshCurrentUser(assertCurrent = captureAuthOperation()): Promise<User | null> {
    try {
      const { data } = await api.get(API_ENDPOINTS.ME);
      assertCurrent();
      if (!data) return null;
      await mutateAuthSession(assertCurrent, async () => {
        await AsyncStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data)); assertCurrent();
      });
      return data as User;
    } catch {
      return null;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    await migrateLegacyTokens();
    return Boolean(getMemoryAccessToken() || (await getRefreshToken()));
  }

  async getStoredTokens(): Promise<{ accessToken: string | null; refreshToken: string | null }> {
    const accessToken = getMemoryAccessToken();
    const refreshToken = await getRefreshToken();
    return { accessToken, refreshToken };
  }
}

export default new AuthService();

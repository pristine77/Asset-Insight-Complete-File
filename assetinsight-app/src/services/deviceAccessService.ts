import api from "./api";
import authService, { type LoginResponse } from "./authService";
import {
  getDeviceKey,
  getPersistedDeviceAccess,
  persistDeviceAccess,
  type RestrictedDeviceAccess,
} from "./deviceAccessStorage";
import { collectVerifiedNativeDeviceContext } from "./deviceMetadataService";
import { captureAuthOperation, mutateAuthSession } from './authSessionOperation';

export interface ApprovedDeviceAccess {
  authState: 'approved';
  challengeToken: string;
  challengeExpiresAt: string;
}

function assertApprovedChallenge(value: unknown): asserts value is ApprovedDeviceAccess {
  const challenge = value as ApprovedDeviceAccess | undefined;
  if (challenge?.authState !== 'approved' || typeof challenge.challengeToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge.challengeToken) ||
      typeof challenge.challengeExpiresAt !== 'string' ||
      !Number.isFinite(Date.parse(challenge.challengeExpiresAt)) || Date.parse(challenge.challengeExpiresAt) <= Date.now()) {
    throw new Error('The device approval response was incomplete or expired. Please sign in again.');
  }
}

async function headers(assertCurrent: () => void, approved?: ApprovedDeviceAccess) {
  if (approved !== undefined) assertApprovedChallenge(approved);
  const [state, deviceKey] = await Promise.all([
    approved ?? getPersistedDeviceAccess(),
    getDeviceKey(),
  ]);
  assertCurrent();
  if (approved !== undefined) assertApprovedChallenge(approved);
  if (!state?.challengeToken || !deviceKey) {
    throw new Error("This device request expired. Sign in again.");
  }
  return {
    Authorization: `Bearer ${state.challengeToken}`,
    "X-Device-Key": deviceKey,
  };
}

class DeviceAccessService {
  async register(assertCurrent = captureAuthOperation()): Promise<RestrictedDeviceAccess | ApprovedDeviceAccess> {
    const context = await collectVerifiedNativeDeviceContext();
    assertCurrent();
    const { data } = await api.post(
      "/auth/device-requests/register",
      {
        reinstallId: context.reinstallId,
        platform: context.platform,
        formFactor: context.formFactor,
        displayName: context.displayName,
        metadata: context.metadata,
      },
      { headers: await headers(assertCurrent) }
    );
    assertCurrent();
    if (data?.authState === 'approved') {
      // Enrollment consumes its token. Hand the new status challenge straight to
      // exchange instead of publishing a restriction and invalidating this login.
      assertApprovedChallenge(data);
      return data;
    }
    await mutateAuthSession(assertCurrent, () => persistDeviceAccess(data as RestrictedDeviceAccess, assertCurrent));
    return data as RestrictedDeviceAccess;
  }

  async status(assertCurrent = captureAuthOperation()) {
    const current = await getPersistedDeviceAccess();
    const { data } = await api.get("/auth/device-requests/status", {
      headers: await headers(assertCurrent),
    });
    const status = String(data?.status || data?.authState || "");
    assertCurrent();
    if (status && status !== "approved") {
      const next = {
        ...current,
        ...data,
        authState: status,
        challengeToken: data?.challengeToken || current?.challengeToken,
        challengeExpiresAt: data?.challengeExpiresAt || current?.challengeExpiresAt,
      } as RestrictedDeviceAccess;
      await mutateAuthSession(assertCurrent, () => persistDeviceAccess(next, assertCurrent));
      return next;
    }
    return data as RestrictedDeviceAccess & { status?: string };
  }

  async exchange(assertCurrent = captureAuthOperation(), approved?: ApprovedDeviceAccess) {
    const { data } = await api.post(
      "/auth/device-requests/exchange",
      {},
      { headers: await headers(assertCurrent, approved) }
    );
    assertCurrent();
    return authService.acceptAuthenticatedResponse(data as LoginResponse, assertCurrent);
  }

  async rerequest(assertCurrent = captureAuthOperation()) {
    const context = await collectVerifiedNativeDeviceContext();
    assertCurrent();
    const { data } = await api.post(
      "/auth/device-requests/rerequest",
      {
        reinstallId: context.reinstallId,
        displayName: context.displayName,
        platform: context.platform,
        formFactor: context.formFactor,
        metadata: context.metadata,
      },
      { headers: await headers(assertCurrent) }
    );
    assertCurrent();
    await mutateAuthSession(assertCurrent, () => persistDeviceAccess(data as RestrictedDeviceAccess, assertCurrent));
    return data as RestrictedDeviceAccess;
  }
}

export default new DeviceAccessService();

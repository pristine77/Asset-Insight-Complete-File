import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

const REINSTALL_ID_NAMESPACE = "asset-insight-device-recovery-v1";
const KNOWN_NON_UNIQUE_ANDROID_IDS = new Set(["9774d56d682e549c"]);

let cachedAndroidReinstallId: Promise<string | undefined> | undefined;

/**
 * Builds a privacy-minimized, app-scoped identifier used only to recover an
 * already approved Android device after uninstall removes its SecureStore key.
 * This identifier is not an authentication secret; the random installation
 * key remains the device proof and is rotated by the API after recovery.
 */
export async function deriveAndroidReinstallId(
  applicationId: string | null | undefined,
  nativeIdentifier: string | null | undefined
): Promise<string | undefined> {
  const identifier = String(nativeIdentifier || "").trim().toLowerCase();
  if (!identifier || /^0+$/.test(identifier) || KNOWN_NON_UNIQUE_ANDROID_IDS.has(identifier)) {
    return undefined;
  }
  const appScope = String(applicationId || "com.assetinsight.app").trim().toLowerCase();
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${REINSTALL_ID_NAMESPACE}|android|${appScope}|${identifier}`
  );
  return `android:v1:${digest.toLowerCase()}`;
}

/**
 * ANDROID_ID is stable for the same signing key, package, Android user, and
 * physical device across uninstall/reinstall. iOS intentionally returns no
 * value because IDFV is not guaranteed to survive removal of all vendor apps.
 */
export function getAndroidReinstallId(): Promise<string | undefined> {
  if (Platform.OS !== "android") return Promise.resolve(undefined);
  if (!cachedAndroidReinstallId) {
    cachedAndroidReinstallId = (async () => {
      try {
        return await deriveAndroidReinstallId(
          Application.applicationId,
          Application.getAndroidId()
        );
      } catch {
        return undefined;
      }
    })();
  }
  return cachedAndroidReinstallId;
}

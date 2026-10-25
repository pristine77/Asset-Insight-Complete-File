import { createHash } from "crypto";

jest.mock("react-native-vision-camera", () => ({
  VisionCamera: { cameraPermissionStatus: "authorized", requestCameraPermission: jest.fn() },
  getAllCameraDevices: jest.fn(() => []),
}));
jest.mock("expo-application", () => ({
  applicationId: "com.assetinsight.app",
  getAndroidId: jest.fn(() => "a1b2c3d4e5f60708"),
  nativeApplicationVersion: "1.0.0",
  nativeBuildVersion: "1",
}));
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: jest.fn(),
}));
jest.mock("expo-device", () => ({
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2 },
  getDeviceTypeAsync: jest.fn().mockResolvedValue(1),
  manufacturer: "Samsung",
  modelName: "SM-S906U",
  modelId: "SM-S906U",
  brand: "Samsung",
  osVersion: "15",
}));
jest.mock("expo-file-system/legacy", () => ({
  getTotalDiskCapacityAsync: jest.fn().mockResolvedValue(128 * 1024 ** 3),
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(64 * 1024 ** 3),
}));
jest.mock("./deviceAccessStorage", () => ({
  getOrCreateDeviceKey: jest.fn().mockResolvedValue("a".repeat(64)),
}));

import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import {
  buildNativeDeviceContext,
  resolveNativeHardwareProfile,
} from "./deviceMetadataService";
import { deriveAndroidReinstallId } from "./deviceReinstallIdentity";

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Crypto.digestStringAsync).mockImplementation(async (_algorithm, value) =>
    createHash("sha256").update(value).digest("hex")
  );
});

describe("native reinstall identity", () => {
  it("derives the same app-scoped Android recovery ID after a clean reinstall", async () => {
    const firstInstall = await deriveAndroidReinstallId(
      "com.assetinsight.app",
      "A1B2C3D4E5F60708"
    );
    const cleanReinstall = await deriveAndroidReinstallId(
      "com.assetinsight.app",
      "a1b2c3d4e5f60708"
    );

    expect(cleanReinstall).toBe(firstInstall);
    expect(firstInstall).toMatch(/^android:v1:[a-f0-9]{64}$/);
    expect(Crypto.digestStringAsync).toHaveBeenCalledWith(
      Crypto.CryptoDigestAlgorithm.SHA256,
      "asset-insight-device-recovery-v1|android|com.assetinsight.app|a1b2c3d4e5f60708"
    );
  });

  it("does not create a recovery ID when the native identifier is unavailable", async () => {
    await expect(deriveAndroidReinstallId("com.assetinsight.app", undefined)).resolves.toBeUndefined();
    await expect(
      deriveAndroidReinstallId("com.assetinsight.app", "0000000000000000")
    ).resolves.toBeUndefined();
    await expect(
      deriveAndroidReinstallId("com.assetinsight.app", "9774d56d682e549c")
    ).resolves.toBeUndefined();
    expect(Crypto.digestStringAsync).not.toHaveBeenCalled();
  });

  it("keeps recovery IDs isolated between application IDs and physical devices", async () => {
    const baseline = await deriveAndroidReinstallId("com.assetinsight.app", "device-a");
    const anotherDevice = await deriveAndroidReinstallId(
      "com.assetinsight.app",
      "device-b"
    );
    const anotherApp = await deriveAndroidReinstallId("com.example.other", "device-a");

    expect(anotherDevice).not.toBe(baseline);
    expect(anotherApp).not.toBe(baseline);
  });

  it("includes the stable recovery ID in Android device context", async () => {
    const originalPlatform = Platform.OS;
    Platform.OS = "android";
    try {
      const firstContext = await buildNativeDeviceContext();
      const cleanReinstallContext = await buildNativeDeviceContext();

      expect(firstContext.reinstallId).toMatch(/^android:v1:[a-f0-9]{64}$/);
      expect(cleanReinstallContext.reinstallId).toBe(firstContext.reinstallId);
      expect(Application.getAndroidId).toHaveBeenCalledTimes(1);
    } finally {
      Platform.OS = originalPlatform;
    }
  });

  it("omits Android recovery identity collection on iOS", async () => {
    const originalPlatform = Platform.OS;
    Platform.OS = "ios";
    try {
      const context = await buildNativeDeviceContext();

      expect(context.reinstallId).toBeUndefined();
      expect(Application.getAndroidId).not.toHaveBeenCalled();
    } finally {
      Platform.OS = originalPlatform;
    }
  });
});

describe("native device hardware catalog", () => {
  it("identifies the Samsung Galaxy S22+ variants and their camera sensors", () => {
    expect(resolveNativeHardwareProfile("samsung", "SM-S906U")).toEqual({
      source: "manufacturer_model_catalog",
      marketingName: "Samsung Galaxy S22+",
      modelCode: "SM-S906U",
      camera: {
        lensCount: 4,
        aggregateMegapixels: 82,
        rearMaximumMegapixels: 50,
        lenses: [
          { position: "back", lens: "Wide", megapixels: 50 },
          { position: "back", lens: "Telephoto", megapixels: 10 },
          { position: "back", lens: "Ultra-wide", megapixels: 12 },
          { position: "front", lens: "Selfie", megapixels: 10 },
        ],
      },
    });
  });

  it("does not invent a marketing profile for unknown hardware", () => {
    expect(resolveNativeHardwareProfile("Samsung", "SM-UNKNOWN")).toBeUndefined();
  });
});

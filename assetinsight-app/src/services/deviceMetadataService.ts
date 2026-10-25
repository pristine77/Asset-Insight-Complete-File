import * as Application from "expo-application";
import * as Device from "expo-device";
import * as FileSystem from "expo-file-system/legacy";
import { Dimensions, PixelRatio, Platform } from "react-native";
import {
  VisionCamera,
  getAllCameraDevices,
  type CameraDevice,
} from "react-native-vision-camera";
import { getOrCreateDeviceKey } from "./deviceAccessStorage";
import { getAndroidReinstallId } from "./deviceReinstallIdentity";

export type NativeDeviceContext = {
  installationKey: string;
  reinstallId?: string;
  platform: "android" | "ios";
  formFactor: "mobile" | "tablet";
  displayName: string;
  metadata: Record<string, unknown>;
};

export class NativeCameraVerificationError extends Error {
  constructor(message: string, public code: "denied" | "unavailable") {
    super(message);
  }
}

type CameraSpecification = {
  position: "back" | "front";
  lens: string;
  megapixels: number;
};

type NativeHardwareProfile = {
  source: "manufacturer_model_catalog";
  marketingName: string;
  modelCode: string;
  camera: {
    lensCount: number;
    aggregateMegapixels: number;
    rearMaximumMegapixels: number;
    lenses: CameraSpecification[];
  };
};

const SAMSUNG_S22_CAMERA: CameraSpecification[] = [
  { position: "back", lens: "Wide", megapixels: 50 },
  { position: "back", lens: "Telephoto", megapixels: 10 },
  { position: "back", lens: "Ultra-wide", megapixels: 12 },
  { position: "front", lens: "Selfie", megapixels: 10 },
];

const SAMSUNG_S22_ULTRA_CAMERA: CameraSpecification[] = [
  { position: "back", lens: "Wide", megapixels: 108 },
  { position: "back", lens: "Periscope telephoto", megapixels: 10 },
  { position: "back", lens: "Telephoto", megapixels: 10 },
  { position: "back", lens: "Ultra-wide", megapixels: 12 },
  { position: "front", lens: "Selfie", megapixels: 40 },
];

const SAMSUNG_MODEL_CATALOG: Array<{
  prefix: string;
  marketingName: string;
  cameras: CameraSpecification[];
}> = [
  { prefix: "SM-S901", marketingName: "Samsung Galaxy S22", cameras: SAMSUNG_S22_CAMERA },
  { prefix: "SM-S906", marketingName: "Samsung Galaxy S22+", cameras: SAMSUNG_S22_CAMERA },
  { prefix: "SM-S908", marketingName: "Samsung Galaxy S22 Ultra", cameras: SAMSUNG_S22_ULTRA_CAMERA },
];

export function resolveNativeHardwareProfile(
  manufacturerValue: string | null | undefined,
  modelValue: string | null | undefined
): NativeHardwareProfile | undefined {
  const manufacturer = String(manufacturerValue || "").trim().toLowerCase();
  const modelCode = String(modelValue || "").trim().toUpperCase();
  if (manufacturer !== "samsung" || !modelCode) return undefined;
  const match = SAMSUNG_MODEL_CATALOG.find((entry) => modelCode.startsWith(entry.prefix));
  if (!match) return undefined;
  return {
    source: "manufacturer_model_catalog",
    marketingName: match.marketingName,
    modelCode,
    camera: {
      lensCount: match.cameras.length,
      aggregateMegapixels: match.cameras.reduce((sum, camera) => sum + camera.megapixels, 0),
      rearMaximumMegapixels: Math.max(
        ...match.cameras.filter((camera) => camera.position === "back").map((camera) => camera.megapixels)
      ),
      lenses: match.cameras,
    },
  };
}

function titleCase(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/(^|[\s-])\p{L}/gu, (character) => character.toUpperCase());
}

function nativeDisplayName(
  manufacturerValue: string | null | undefined,
  modelValue: string,
  hardwareProfile?: NativeHardwareProfile
) {
  if (hardwareProfile) return `${hardwareProfile.marketingName} (${hardwareProfile.modelCode})`;
  const manufacturer = titleCase(String(manufacturerValue || ""));
  if (!manufacturer || modelValue.toLowerCase().startsWith(manufacturer.toLowerCase())) return modelValue;
  return `${manufacturer} ${modelValue}`.trim();
}

function bytes(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function formFactor(): Promise<"mobile" | "tablet"> {
  const type = await Device.getDeviceTypeAsync().catch(() => Device.DeviceType.UNKNOWN);
  if (type === Device.DeviceType.TABLET) return "tablet";
  const { width, height } = Dimensions.get("screen");
  return Math.min(width, height) >= 600 ? "tablet" : "mobile";
}

async function diskMetadata() {
  const [totalBytes, freeBytes] = await Promise.all([
    FileSystem.getTotalDiskCapacityAsync().catch(() => undefined),
    FileSystem.getFreeDiskStorageAsync().catch(() => undefined),
  ]);
  return {
    kind: "native_disk",
    totalBytes: bytes(totalBytes),
    freeBytes: bytes(freeBytes),
  };
}

function largestResolution(device: CameraDevice, stream: "photo" | "video") {
  try {
    const resolutions = device.getSupportedResolutions(stream);
    let best: { width: number; height: number } | undefined;
    for (const resolution of resolutions) {
      if (!best || resolution.width * resolution.height > best.width * best.height) {
        best = { width: resolution.width, height: resolution.height };
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

function megapixels(resolution?: { width: number; height: number }) {
  if (!resolution) return undefined;
  return Math.round((resolution.width * resolution.height) / 100_000) / 10;
}

function representativeCameras(cameras: CameraDevice[]) {
  const positions = new Map<string, CameraDevice[]>();
  for (const camera of cameras) {
    const entries = positions.get(camera.position) || [];
    entries.push(camera);
    positions.set(camera.position, entries);
  }
  const representatives: CameraDevice[] = [];
  for (const entries of positions.values()) {
    const virtual = entries
      .filter((camera) => camera.isVirtualDevice || camera.physicalDevices?.length > 1)
      .sort((a, b) => (b.physicalDevices?.length || 0) - (a.physicalDevices?.length || 0))[0];
    if (virtual) representatives.push(virtual);
    else representatives.push(...entries);
  }
  return representatives;
}

function detectedLensCount(cameras: CameraDevice[]) {
  const positions = new Map<string, CameraDevice[]>();
  for (const camera of cameras) {
    positions.set(camera.position, [...(positions.get(camera.position) || []), camera]);
  }
  let count = 0;
  for (const entries of positions.values()) {
    const physicalCount = Math.max(...entries.map((camera) => camera.physicalDevices?.length || 0));
    count += physicalCount > 1 ? physicalCount : entries.length;
  }
  return count;
}

function sanitizeCamera(device: CameraDevice) {
  const photo = largestResolution(device, "photo");
  const video = largestResolution(device, "video");
  const photoMegapixels = megapixels(photo);
  return {
    name: String(device.localizedName || `${device.position} camera`).slice(0, 160),
    manufacturer: String(device.manufacturer || "").slice(0, 100),
    type: device.type,
    position: device.position,
    isVirtual: device.isVirtualDevice,
    physicalLensCount: Math.min(10, device.physicalDevices?.length || 1),
    photoResolution: photo,
    maxPhotoMegapixels: photoMegapixels,
    maxPhotoResolution: photo
      ? `${photo.width} × ${photo.height}${photoMegapixels ? ` · ${photoMegapixels} MP` : ""}`
      : undefined,
    videoResolution: video,
    supportsPhotoHDR: device.supportsPhotoHDR,
    supportedDynamicRanges: device.supportedVideoDynamicRanges.slice(0, 10),
    fpsRanges: device.supportedFPSRanges.slice(0, 10).map((range) => ({
      min: range.min,
      max: range.max,
    })),
  };
}

export async function buildNativeDeviceContext(): Promise<NativeDeviceContext> {
  const factor = await formFactor();
  const screen = Dimensions.get("screen");
  const disk = await diskMetadata();
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const model = Device.modelName || Device.modelId || `${platform} device`;
  const hardwareProfile = resolveNativeHardwareProfile(Device.manufacturer, model);
  const osName = platform === "android" ? "Android" : factor === "tablet" ? "iPadOS" : "iOS";
  const [installationKey, reinstallId] = await Promise.all([
    getOrCreateDeviceKey(),
    getAndroidReinstallId(),
  ]);
  return {
    installationKey,
    reinstallId,
    platform,
    formFactor: factor,
    displayName: nativeDisplayName(Device.manufacturer, model, hardwareProfile),
    metadata: {
      manufacturer: Device.manufacturer || undefined,
      model,
      marketingName: hardwareProfile?.marketingName,
      brand: Device.brand || undefined,
      hardwareProfile,
      os: { name: osName, version: Device.osVersion || String(Platform.Version) },
      app: {
        version: Application.nativeApplicationVersion || undefined,
        build: Application.nativeBuildVersion || undefined,
      },
      screen: {
        width: Math.round(screen.width),
        height: Math.round(screen.height),
        pixelRatio: PixelRatio.get(),
        fontScale: PixelRatio.getFontScale(),
      },
      formFactor: factor,
      storage: disk,
    },
  };
}

export async function collectVerifiedNativeDeviceContext(): Promise<NativeDeviceContext> {
  const context = await buildNativeDeviceContext();
  let cameras: CameraDevice[];
  try {
    cameras = getAllCameraDevices();
  } catch {
    throw new NativeCameraVerificationError(
      "Camera hardware could not be checked. Restart the app and try again.",
      "unavailable"
    );
  }
  if (cameras.length === 0) {
    return {
      ...context,
      metadata: {
        ...context.metadata,
        camera: {
          verification: "no_camera",
          verificationMethod: "vision_camera_enumeration",
          count: 0,
          devices: [],
        },
      },
    };
  }
  const authorized =
    VisionCamera.cameraPermissionStatus === "authorized" ||
    (await VisionCamera.requestCameraPermission());
  if (!authorized) {
    throw new NativeCameraVerificationError(
      "Camera access is blocked. Allow camera access in system settings, then try again.",
      "denied"
    );
  }
  cameras = getAllCameraDevices();
  if (cameras.length === 0) {
    return {
      ...context,
      metadata: {
        ...context.metadata,
        camera: {
          verification: "no_camera",
          verificationMethod: "vision_camera_enumeration",
          count: 0,
          devices: [],
        },
      },
    };
  }
  return {
    ...context,
    metadata: {
      ...context.metadata,
      camera: {
        verification: "granted",
        verificationMethod: "vision_camera_enumeration",
        count:
          ((context.metadata.hardwareProfile as NativeHardwareProfile | undefined)?.camera.lensCount) ||
          detectedLensCount(cameras),
        reportedDeviceCount: cameras.length,
        devices: representativeCameras(cameras).slice(0, 12).map(sanitizeCamera),
      },
    },
  };
}

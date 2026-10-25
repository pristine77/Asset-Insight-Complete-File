import * as Application from 'expo-application';
import * as Device from 'expo-device';
import { Dimensions, Platform } from 'react-native';

import type { SupportDiagnostics } from './supportService';

const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const MAX_ERROR_CODE_LENGTH = 120;
const MAX_STACK_LENGTH = 4_000;

function cleanText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, limit) : undefined;
}

/**
 * Keep diagnostics intentionally small and non-identifying. Authentication
 * tokens, installation IDs, storage contents, location and network addresses
 * never enter this object, so it is safe to attach to a support conversation.
 */
export function collectSupportDiagnostics(input: {
  route: string;
  errorCode?: unknown;
  errorMessage?: unknown;
  stack?: unknown;
}): SupportDiagnostics {
  const screen = Dimensions.get('screen');
  const platform: SupportDiagnostics['platform'] =
    Platform.OS === 'ios' ? 'ios' : Platform.OS === 'web' ? 'web' : 'android';
  const manufacturer = cleanText(Device.manufacturer, 80);
  const model = cleanText(Device.modelName || Device.modelId, 120);
  const deviceModel = [manufacturer, model]
    .filter(Boolean)
    .filter((value, index, values) => index === 0 || value !== values[0])
    .join(' ');

  return {
    appVersion: cleanText(Application.nativeApplicationVersion, 80),
    buildNumber: cleanText(Application.nativeBuildVersion, 80),
    platform,
    osVersion: cleanText(Device.osVersion || String(Platform.Version), 80) || 'unknown',
    deviceModel: deviceModel || undefined,
    screen: `${Math.round(screen.width)}x${Math.round(screen.height)} @${Number(screen.scale || 1)}x; font ${Number(screen.fontScale || 1)}x`,
    route: cleanText(input.route, 240) || 'support',
    errorCode: cleanText(input.errorCode, MAX_ERROR_CODE_LENGTH),
    errorMessage: cleanText(input.errorMessage, MAX_ERROR_MESSAGE_LENGTH),
    stack: cleanText(input.stack, MAX_STACK_LENGTH),
    occurredAt: new Date().toISOString(),
  };
}

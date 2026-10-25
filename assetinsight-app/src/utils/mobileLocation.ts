import * as Location from 'expo-location';

export const CURRENT_MOBILE_LOCATION_LABEL = 'Current Browser Location';

export type HiddenLocationSnapshot = {
  location: string;
  latitude?: number;
  longitude?: number;
};

export const hasValidHiddenCoordinates = (
  latitude: unknown,
  longitude: unknown
): boolean => Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));

const snapshotFromPosition = (position: Location.LocationObject): HiddenLocationSnapshot => ({
  location: CURRENT_MOBILE_LOCATION_LABEL,
  latitude: position.coords.latitude,
  longitude: position.coords.longitude,
});

export async function getHiddenCurrentLocation(): Promise<HiddenLocationSnapshot> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) {
      return { location: CURRENT_MOBILE_LOCATION_LABEL };
    }

    const lastKnown = await Location.getLastKnownPositionAsync({
      maxAge: 5 * 60 * 1000,
      requiredAccuracy: 500,
    });
    if (lastKnown) {
      return snapshotFromPosition(lastKnown);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Location request timed out')), 8000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    return snapshotFromPosition(current);
  } catch (error) {
    console.warn('[Location] Hidden location detection failed:', error);
    return { location: CURRENT_MOBILE_LOCATION_LABEL };
  }
}

export function normalizeHiddenLocation(
  location?: unknown,
  latitude?: unknown,
  longitude?: unknown
): HiddenLocationSnapshot {
  const normalized: HiddenLocationSnapshot = {
    location: String(location || CURRENT_MOBILE_LOCATION_LABEL).trim() || CURRENT_MOBILE_LOCATION_LABEL,
  };

  if (hasValidHiddenCoordinates(latitude, longitude)) {
    normalized.latitude = Number(latitude);
    normalized.longitude = Number(longitude);
  }

  return normalized;
}

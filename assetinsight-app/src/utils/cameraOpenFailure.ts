/**
 * Why the camera did not open (2026-10-02).
 *
 * Both report forms save the draft on the phone before opening the camera, so
 * the camera's photos have a draft to belong to. When that save failed, the tap
 * on "Open camera" used to be ignored without a word: no camera, no message,
 * the same on every tap. Field users read it as a frozen camera. The forms now
 * show this explanation, with the reason from the save, and a Try again button.
 */
import type { AlertButton } from 'react-native';

export const CAMERA_NOT_OPENED_TITLE = 'Camera not opened';

export function describeCameraOpenFailure(error: unknown): string {
  const reason = error instanceof Error && error.message.trim() ? error.message.trim() : '';
  return [
    'This draft could not be saved on the phone first, so the camera did not open.',
    reason ? `Reason: ${reason}` : '',
    'Your form and photos are still here. Fix the problem, then tap Try again.',
  ].filter(Boolean).join('\n\n');
}

/**
 * "Not now" closes the alert; "Try again" saves and opens the camera again.
 * The caller decides whether a retry may still act (same account, same form).
 */
export function cameraOpenFailureButtons(retry: () => void): AlertButton[] {
  return [
    { text: 'Not now', style: 'cancel' },
    { text: 'Try again', onPress: retry },
  ];
}

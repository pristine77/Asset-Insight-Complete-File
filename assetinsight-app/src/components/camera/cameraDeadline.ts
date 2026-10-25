export class CameraDeadlineError extends Error {}

// Only preparation/persistence is bounded. An inspection itself has no deadline.
export async function cameraDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CameraDeadlineError('Preparing the camera or saving the inspection is taking too long. Your current form is kept. Check device storage and retry; do not clear app data.')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

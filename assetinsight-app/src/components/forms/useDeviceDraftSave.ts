import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import OfflineCaptureStore from '../../services/offlineCaptureStore';

/** Flush older autosaves before the explicit snapshot; never starts cloud work. */
export default function useDeviceDraftSave<T>(
  save: () => Promise<T | null>,
  pending: MutableRefObject<Promise<unknown> | null>,
  timer: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  const lock = useRef(false);
  const [saving, setSaving] = useState(false);
  const saveOnDevice = useCallback(async (onSaved?: (draft: T) => void | Promise<void>) => {
    if (lock.current) return;
    const owner = OfflineCaptureStore.getOwnerId();
    const assertOwner = () => {
      if (!owner || owner !== OfflineCaptureStore.getOwnerId()) throw new Error('The account changed. Reopen this draft from its owner account.');
    };
    lock.current = true;
    setSaving(true);
    if (timer.current) clearTimeout(timer.current);
    try {
      // A failed previous autosave must not prevent an explicit retry.
      await pending.current?.catch(() => undefined);
      assertOwner();
      const draft = await save();
      assertOwner();
      if (!draft) throw new Error('The draft could not be saved. Keep this form open and try again.');
      await onSaved?.(draft);
    } finally {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      lock.current = false;
      setSaving(false);
    }
  }, [pending, save, timer]);
  return { saving, saveOnDevice, saveLock: lock };
}

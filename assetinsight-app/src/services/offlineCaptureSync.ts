import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import api from './api';
import OfflineCaptureStore from './offlineCaptureStore';
import type { OfflineReportDraft } from './autoSaveService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';

async function inventoryInstallationId() {
  const key = '@asset-insight:capture-installation-v1';
  const existing = await AsyncStorage.getItem(key);
  if (existing) return existing;
  const id = randomUUID();
  await AsyncStorage.setItem(key, id);
  return id;
}

export function captureInventorySnapshot(draft: OfflineReportDraft, installationId: string) {
  const timestamps: number[] = [];
  const lots = draft.lots.map((lot, index) => {
    const photos = [...lot.mainImages, ...lot.extraImages];
    let missingPhotoCount = 0;
    for (const photo of photos) {
      if (typeof photo !== 'string') {
        if (photo.availability === 'missing') missingPhotoCount++;
        const value = Number(photo.captureTimestamp);
        if (Number.isFinite(value) && value > 0) timestamps.push(value);
      }
    }
    return { id: lot.id, lotNumber: String((lot as any).lot_number ?? (lot as any).lotNumber ?? index + 1),
      title: String((lot as any).title || '').slice(0, 200), mainPhotoCount: lot.mainImages.length,
      extraPhotoCount: lot.extraImages.length, availablePhotoCount: photos.length - missingPhotoCount, missingPhotoCount };
  });
  return { schemaVersion: 1, revision: draft.localRevision || 1, reportType: draft.type,
    clientSubmissionId: draft.formData.clientSubmissionId || '', contractNo: draft.contractNo || draft.formData.contractNo || '',
    device: { installationId, appVersion: draft.inventoryAppVersion || 'unknown', platform: draft.inventoryPlatform || 'android' },
    localStatus: draft.submissionState === 'discarded' ? 'discarded' : draft.submissionState === 'paused' ? 'paused' : 'saved',
    lots, deviceCreatedAt: draft.createdAt, deviceSavedAt: draft.updatedAt,
    firstCapturedAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    lastCapturedAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null };
}

let epoch = 0;
let active = false;
let flight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let removeNetwork: (() => void) | undefined;
let removeAppState: (() => void) | undefined;
let controller: AbortController | undefined;
const isForeground = () => AppState.currentState === 'active';

async function run() {
  const owner = OfflineCaptureStore.getOwnerId();
  const generation = epoch;
  const current = () => active && isForeground() && generation === epoch && owner === OfflineCaptureStore.getOwnerId();
  if (!owner || !current()) return;
  const network = await NetInfo.fetch();
  if (!current() || network.isConnected !== true || network.isInternetReachable === false) return;
  const installationId = await inventoryInstallationId();
  // Observations only: reconnect never invokes an upload or report submission.
  for (let batchIndex = 0; batchIndex < 10 && current(); batchIndex++) {
    const events = await OfflineCaptureStore.pendingActivity();
    if (!events.length || !current()) break;
    controller = new AbortController();
    try {
      const response = await api.post('/report-activity/events', { ownerId: owner, events }, { signal: controller.signal, timeout: 15000 });
      if (!current()) return;
      const acknowledgements = response.data?.data?.acknowledgements;
      if (!Array.isArray(acknowledgements)) break;
      const sent = new Set(events.map(event => event.eventId));
      const ids = acknowledgements.filter((ack: any) => sent.has(ack.eventId)).map((ack: any) => ack.eventId);
      await OfflineCaptureStore.acknowledgeActivity(ids, owner);
      if (ids.length !== events.length) break;
    } catch { break; } // Stable event IDs remain pending after ambiguous responses.
  }
  const visited: string[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!current()) return;
    // Read one manifest at a time; twenty 5,000-photo drafts must not occupy memory together.
    const [item] = await OfflineCaptureStore.inventoryCandidates(1, visited);
    if (!item || visited.includes(item.draftId)) break;
    visited.push(item.draftId);
    if (!current()) return;
    if (!item.draft.captureId) continue;
    controller = new AbortController();
    try {
      const response = await api.put(`/capture-inventory/${encodeURIComponent(item.draft.captureId)}`,
        captureInventorySnapshot(item.draft, installationId), { signal: controller.signal, timeout: 15000 });
      if (!current()) return;
      if (response.data?.data?.acknowledgedRevision === item.revision) {
        await OfflineCaptureStore.acknowledgeInventory(item.draftId, item.revision);
      }
    } catch (error: any) {
      if (!current()) return;
      if (error?.response?.status === 410 && error?.response?.data?.code === 'CAPTURE_REMOVED') {
        await OfflineCaptureStore.acknowledgeInventory(item.draftId, item.revision);
      } else if (error?.response?.status === 400 || error?.response?.status === 409 || error?.response?.status === 413) {
        await OfflineCaptureStore.recordInventoryError(item.draftId, item.revision,
          'Operational metadata needs attention. Open and save this draft to retry. Photos remain on this device.');
      } else {
        // A durable outbox retains the snapshot. Never fall back to a draft/photo upload.
        break;
      }
    }
  }
}

const OfflineCaptureSync = {
  syncOnce(): Promise<void> {
    if (flight) return flight;
    flight = run().catch(() => undefined).finally(() => { flight = null; });
    return flight;
  },
  init() {
    if (active) return;
    active = true;
    void this.syncOnce();
    timer = setInterval(() => void this.syncOnce(), 30000);
    removeNetwork = NetInfo.addEventListener((state) => { if (state.isConnected) void this.syncOnce(); });
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void this.syncOnce();
      else { epoch++; controller?.abort(); }
    });
    removeAppState = () => listener.remove();
  },
  cleanup() {
    active = false; epoch++; controller?.abort();
    if (timer) clearInterval(timer);
    timer = undefined; removeNetwork?.(); removeAppState?.(); removeNetwork = undefined; removeAppState = undefined;
  },
};
export default OfflineCaptureSync;

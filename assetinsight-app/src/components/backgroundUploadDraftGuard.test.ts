/**
 * Opening a saved draft while the background upload line holds it
 * (2026-10-02). Every way into a saved draft in the app -- Drafts, Offline
 * captures, the upload bar -- goes through App's handleContinueOfflineDraft,
 * which asks claimDraftForEditing() first.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Alert } from 'react-native';
import { claimDraftForEditing } from './backgroundUploadDraftGuard';
import backgroundUploadManager, { type BackgroundUploadRequest } from '../services/backgroundUploadManager';
import { setUploadOwner } from '../services/uploadCancellation';

jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn(async () => ({ isConnected: true })), addEventListener: jest.fn(() => () => undefined) } }));
jest.mock('../services/offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: () => 'owner', setSubmissionState: jest.fn(async () => undefined) } }));
jest.mock('../services/offlineSubmissionService', () => ({ prepareOfflineSubmission: jest.fn(async (draft: unknown) => draft) }));
jest.mock('../services/offlineQueueService', () => ({ __esModule: true, default: {
  getConnectivityStatus: jest.fn(async () => ({ status: 'online' })), getSubmissionError: jest.fn(() => ({ title: 'Upload failed', message: 'Retry.' })),
} }));
jest.mock('../services/autoSaveService', () => ({ __esModule: true, default: { cleanupOrphanedMedia: jest.fn(async () => 0) } }));

const flush = async () => { for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
/** An upload in the line that never finishes during the test. */
const upload = (draftId: string): BackgroundUploadRequest => ({
  draftId, type: 'lotListing', ownerId: 'owner', title: `QA-${draftId}`, totalFiles: 40,
  draft: { id: draftId, ownerId: 'owner' } as any, upload: jest.fn(() => new Promise(() => {})),
});

beforeEach(() => {
  setUploadOwner('owner');
  backgroundUploadManager.resetForTests();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => {
  backgroundUploadManager.resetForTests();
  jest.restoreAllMocks();
});

it('keeps a draft that is uploading or waiting in line closed, and says how to edit it', async () => {
  backgroundUploadManager.enqueue(upload('draft-a'));
  backgroundUploadManager.enqueue(upload('draft-b'));
  await flush();
  expect(claimDraftForEditing('draft-a')).toBe(false);
  expect(claimDraftForEditing('draft-b')).toBe(false);
  expect(Alert.alert).toHaveBeenCalledTimes(2);
  expect(Alert.alert).toHaveBeenCalledWith('Uploading in the background', expect.stringContaining('Pause it from the upload bar'));
  // Still uploading and still in line: refusing to open changes nothing.
  expect(backgroundUploadManager.getSnapshot().active).toMatchObject({ draftId: 'draft-a', status: 'uploading' });
  expect(backgroundUploadManager.getSnapshot().queued).toEqual([expect.objectContaining({ draftId: 'draft-b' })]);
});

it('hands a paused background upload back to the form that opens it', async () => {
  backgroundUploadManager.enqueue(upload('draft-a'));
  await flush();
  backgroundUploadManager.pause(backgroundUploadManager.getSnapshot().active!.id);
  await flush();
  expect(backgroundUploadManager.statusFor('draft-a')).toMatchObject({ status: 'paused' });
  expect(claimDraftForEditing('draft-a')).toBe(true);
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(backgroundUploadManager.statusFor('draft-a')).toBeUndefined();
  expect(backgroundUploadManager.getSnapshot().held).toEqual([]);
});

it('opens any other draft', () => {
  expect(claimDraftForEditing('draft-z')).toBe(true);
  expect(Alert.alert).not.toHaveBeenCalled();
});

describe('App', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');

  it('asks the guard before opening any saved draft', () => {
    const handler = app.match(/const handleContinueOfflineDraft = useCallback\(\(draftId: string, type: OfflineDraftType\) => \{([\s\S]*?)\}, \[\]\);/)?.[1];
    expect(handler).toBeDefined();
    const guard = handler!.indexOf('if (!claimDraftForEditing(draftId)) return;');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(handler!.indexOf('setOfflineDraftToLoad({ id: draftId, type });'));
  });

  it('renders the upload bar once, after the screen, opening drafts through the same handler', () => {
    expect(app.match(/<UploadBar /g)).toHaveLength(1);
    expect(app).toContain('<UploadBar onOpenDraft={handleContinueOfflineDraft} />');
    expect(app.indexOf('{renderScreen()}')).toBeLessThan(app.indexOf('<UploadBar '));
  });
});

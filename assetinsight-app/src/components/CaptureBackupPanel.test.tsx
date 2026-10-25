import React from 'react';
import { Linking } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import CaptureBackupPanel, { describeCaptureBackup } from './CaptureBackupPanel';
import service, { type BackupView, type BackupStatus } from '../services/captureBackupService';

jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { text: '#111', textSecondary: '#444', surface: '#fff', border: '#ddd', warning: '#a50', accent: '#c00' } }) }));
jest.mock('../services/captureBackupService', () => ({ __esModule: true, default: {
  subscribe: jest.fn(() => () => undefined), getSnapshot: jest.fn(), pause: jest.fn(), resume: jest.fn(), tick: jest.fn(), setNetworkPolicy: jest.fn(), setConsent: jest.fn(),
} }));
const job = (status: BackupStatus['status'], extra = {}): BackupStatus => ({ clientDraftId: 'draft', contractNo: '00000', revision: 2, total: 224, verified: 50, status, ...extra });
let view: BackupView;
beforeEach(() => {
  jest.clearAllMocks();
  view = { ownerId: 'owner-a', supported: true, consent: 'enabled', networkPolicy: 'unmetered', jobs: [job('paused')] };
  jest.mocked(service.getSnapshot).mockImplementation(() => view);
});
afterEach(async () => { await cleanup(); });
test('shows a prominent optional disclosure before enable without sending or resuming anything', async () => {
  view.consent = 'required';
  await render(<CaptureBackupPanel />);
  expect(screen.getByText(/uploads photos, videos and report details/)).toBeTruthy();
  expect(screen.getByText(/background even when this app is closed/)).toBeTruthy();
  expect(screen.getByText(/never submits a report automatically/)).toBeTruthy();
  expect(screen.getByText(/does not delete originals or earlier cloud backups/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Enable cloud backup' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Not now — keep cloud backup off' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Privacy policy' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Resume backup 00000' })).toBeNull();
  expect(screen.queryByLabelText('Allow mobile data for photo backups')).toBeNull();
  expect(service.setConsent).not.toHaveBeenCalled(); expect(service.resume).not.toHaveBeenCalled(); expect(service.tick).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Enable cloud backup' }));
  expect(service.setConsent).toHaveBeenCalledWith(true);
});
test('Not now saves an explicit off choice and never enables backup', async () => {
  view.consent = 'required'; await render(<CaptureBackupPanel />);
  await fireEvent.press(screen.getByRole('button', { name: 'Not now — keep cloud backup off' }));
  expect(service.setConsent).toHaveBeenCalledTimes(1); expect(service.setConsent).toHaveBeenCalledWith(false);
});
test('turning backup off remains available while another control is waiting', async () => {
  let finish!: () => void;
  jest.mocked(service.resume).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render(<CaptureBackupPanel />);
  await fireEvent.press(screen.getByRole('button', { name: 'Resume backup 00000' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Turn off cloud backup' }));
  expect(service.setConsent).toHaveBeenCalledWith(false);
  await act(async () => finish());
});
test('does not conceal consent storage failure behind a successful enabled state', async () => {
  view.consent = 'required'; jest.mocked(service.setConsent).mockRejectedValueOnce(new Error('Storage failed'));
  await render(<CaptureBackupPanel />);
  await fireEvent.press(screen.getByRole('button', { name: 'Enable cloud backup' }));
  expect(screen.getByText(/could not be saved/)).toBeTruthy();
  expect(screen.getByText(/Cloud backup is off/)).toBeTruthy();
});
test('opens the public privacy policy without enabling backup', async () => {
  view.consent = 'required'; const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await render(<CaptureBackupPanel />);
  await fireEvent.press(screen.getByRole('link', { name: 'Privacy policy' }));
  expect(open).toHaveBeenCalledWith('https://assetinsightvaluator.com/privacy'); expect(service.setConsent).not.toHaveBeenCalled();
  open.mockRestore();
});
test('shows exact partial verified count, distinct backup/manual-submit copy and Resume', async () => {
  await render(<CaptureBackupPanel />);
  expect(screen.getByText('Backed up 50 of 224 files · paused')).toBeTruthy();
  expect(screen.queryByText(/Fully backed up/)).toBeNull();
  expect(screen.getByText(/separately from report submission/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Resume backup 00000' }));
  expect(service.resume).toHaveBeenCalledWith('draft');
  expect(service.pause).not.toHaveBeenCalled();
});
test('explicit Pause goes only to the backup service', async () => {
  view.jobs = [job('uploading')];
  await render(<CaptureBackupPanel />);
  await fireEvent.press(screen.getByRole('button', { name: 'Pause backup 00000' }));
  expect(service.pause).toHaveBeenCalledWith('draft');
  expect(service.resume).not.toHaveBeenCalled();
});
test('does not offer Resume on an explicitly deleted draft', async () => {
  view.jobs = [job('paused', { pauseReason: 'draft_deleted' })];
  await render(<CaptureBackupPanel />);
  expect(screen.getByText(/paused after draft deletion/)).toBeTruthy();
  expect(screen.queryByText('Resume backup')).toBeNull();
});
test('prevents double actions while native pause is pending', async () => {
  let finish!: () => void;
  jest.mocked(service.resume).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render(<CaptureBackupPanel />);
  await fireEvent.press(screen.getByRole('button', { name: 'Resume backup 00000' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Resume backup 00000' }));
  expect(service.resume).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});
test('offers mobile-data control without disguising possible data charges', async () => {
  view.networkPolicy = 'connected';
  await render(<CaptureBackupPanel />);
  expect(screen.getByText(/data charges/)).toBeTruthy();
  await fireEvent(screen.getByLabelText('Allow mobile data for photo backups'), 'valueChange', false);
  expect(service.setNetworkPolicy).toHaveBeenCalledWith('unmetered');
});
test('keeps unsupported binaries and signed-out accounts from advertising a running service', async () => {
  view.supported = false;
  await render(<CaptureBackupPanel />);
  expect(screen.queryByText('Photo cloud backup')).toBeNull();
});
test('never claims fully backed up for a partial or empty completed record', () => {
  expect(describeCaptureBackup(job('completed'))).toContain('verification pending');
  expect(describeCaptureBackup(job('completed', { verified: 0, total: 0 }))).not.toContain('Fully');
  expect(describeCaptureBackup(job('completed', { verified: 224 }))).toBe('Fully backed up · 224 files');
});
test('keeps earlier pending revisions visible without adding their counts to the latest revision', async () => {
  view.jobs = [job('completed', { verified: 50, total: 50, retainedEarlierRevisionsPending: 1 })];
  await render(<CaptureBackupPanel />);
  expect(screen.getByText('Current revision verified · 50 files')).toBeTruthy();
  expect(screen.getByText(/Earlier saved revision still backing up/)).toBeTruthy();
  expect(screen.queryByText(/Fully backed up/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Pause backup 00000' })).toBeTruthy();
});
test('can resume an older paused revision even after the current revision is verified', async () => {
  view.jobs = [job('completed', { verified: 50, total: 50, retainedEarlierRevisionsPending: 1, retainedEarlierRevisionsStatus: 'paused' })];
  await render(<CaptureBackupPanel />);
  expect(screen.getByText(/Earlier saved revision needs to resume/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Resume backup 00000' }));
  expect(service.resume).toHaveBeenCalledWith('draft');
});
test('an empty completed snapshot does not claim photos are safe or wait forever for verification', async () => {
  view.jobs = [job('completed', { verified: 0, total: 0 })];
  await render(<CaptureBackupPanel />);
  expect(screen.getByText('No files in this saved revision')).toBeTruthy();
  expect(screen.queryByText(/verification pending|Fully backed up/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Pause backup 00000' })).toBeNull();
});

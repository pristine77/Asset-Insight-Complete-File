import { Alert } from 'react-native';
import { isUploadManifestConflict, showUploadManifestRecovery } from './uploadManifestRecovery';

const conflict = (data: Record<string, unknown>, code = 'SUBMISSION_MANIFEST_CHANGED') => ({
  response: { status: 409, data: { code, data } },
});

beforeEach(() => jest.spyOn(Alert, 'alert').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

it.each([
  { reportId: 'reserved-report' },
  { reportId: 'reserved-report', accepted: false, canSupersede: false },
  { accepted: 'false', canSupersede: true },
])('does not infer acceptance or permission to replace from incomplete evidence: %j', data => {
  showUploadManifestRecovery(conflict(data), { replace: jest.fn() });
  const [title, message, buttons] = jest.mocked(Alert.alert).mock.calls[0];
  expect(title).toBe('Upload needs checking');
  expect(message).not.toContain('already belongs to a report');
  expect(buttons?.map(button => button.text)).toEqual(['Keep Draft']);
});

it('offers replacement only for a confirmed replaceable unfinished upload', () => {
  const replace = jest.fn();
  showUploadManifestRecovery(conflict({ accepted: false, canSupersede: true }), { replace });
  const buttons = jest.mocked(Alert.alert).mock.calls[0][2];
  expect(replace).not.toHaveBeenCalled();
  buttons?.find(button => button.text === 'Upload updated version')?.onPress?.();
  expect(replace).toHaveBeenCalledTimes(1);
});

it('offers a separate report only for the authoritative unavailable accepted-report receipt', () => {
  const startSeparate = jest.fn();
  showUploadManifestRecovery(conflict({ accepted: true, reportAvailable: false, canCreateSeparate: true }, 'UPLOAD_SESSION_REPORT_UNAVAILABLE'), { startSeparate });
  const [title, message, buttons] = jest.mocked(Alert.alert).mock.calls[0];
  expect(title).toBe('Earlier report unavailable');
  expect(message).toContain('new report');
  expect(startSeparate).not.toHaveBeenCalled();
  expect(buttons?.map(button => button.text)).toEqual(['Keep Draft', 'Start separate report']);
  buttons?.[1].onPress?.();
  expect(startSeparate).toHaveBeenCalledTimes(1);
});

it.each([
  { accepted: true, reportAvailable: false },
  { accepted: true, reportAvailable: true, canCreateSeparate: true },
  { accepted: false, reportAvailable: false, canCreateSeparate: true },
])('does not authorize fresh work from ambiguous evidence: %j', data => {
  showUploadManifestRecovery(conflict(data, 'UPLOAD_SESSION_REPORT_UNAVAILABLE'), { replace: jest.fn(), startSeparate: jest.fn() });
  const buttons = jest.mocked(Alert.alert).mock.calls[0][2];
  expect(buttons?.some(button => button.text === 'Start separate report')).not.toBe(true);
  expect(buttons?.some(button => button.text === 'Upload updated version')).not.toBe(true);
});

it('keeps Incoming on the same assignment even when ordinary separate creation is permitted', () => {
  showUploadManifestRecovery(conflict({ accepted: true, reportAvailable: false, canCreateSeparate: true }, 'UPLOAD_SESSION_REPORT_UNAVAILABLE'));
  expect(jest.mocked(Alert.alert).mock.calls[0][1]).toContain('Incoming');
  expect(jest.mocked(Alert.alert).mock.calls[0][2]?.map(button => button.text)).toEqual(['Keep Draft']);
});

// The background upload line asks this instead of showing the prompt, then
// leaves the draft for the form, where the prompt appears (2026-10-02).
it.each([
  [conflict({ accepted: false, canSupersede: true }), true],
  [conflict({ accepted: true, reportAvailable: false }, 'UPLOAD_SESSION_REPORT_UNAVAILABLE'), true],
  [conflict({}, 'ACTIVE_REPORT_EXISTS'), false],
  [{ response: { status: 503, data: { code: 'SUBMISSION_MANIFEST_CHANGED' } } }, false],
  [{ message: 'Network Error' }, false],
  [undefined, false],
])('recognises exactly the conflicts the prompt handles: %j', (error, expected) => {
  expect(isUploadManifestConflict(error)).toBe(expected);
  expect(showUploadManifestRecovery(error)).toBe(expected);
});

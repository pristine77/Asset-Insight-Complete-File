import { assertReportUploadAccepted, isExistingReportUploadReceipt } from './reportUploadReceipt';

const identity = { reportId: 'report', jobId: 'job' };

it.each([
  {}, { status: 'preparing' }, { status: 'uploading' }, { readyToComplete: true },
  { accepted: false, phase: 'processing' }, { accepted: 'true' },
  { accepted: true, status: 'uploading' }, { reportAvailable: false, phase: 'done' },
  { accepted: true, phase: 'upload' }, { accepted: true, status: 'upload' },
  { accepted: true, status: 'unavailable' }, { accepted: true, phase: 'unavailable' },
])('rejects pre-acceptance or ambiguous responses despite reserved identities: %j', state => {
  expect(() => assertReportUploadAccepted({ ...identity, ...state })).toThrow('did not confirm');
});

it.each([{ accepted: true }, { phase: 'processing' }, { phase: 'done' }, { status: 'preview' }, { phase: 'error' }])('accepts explicit authority or documented legacy final receipts: %j', state => {
  expect(() => assertReportUploadAccepted({ ...identity, ...state })).not.toThrow();
});

it('recognizes the first successful completion even when the worker finished quickly', () => {
  const receipt = { ...identity, accepted: true, reportAvailable: true, processed: true, reusedAcceptance: false, phase: 'done' };
  expect(() => assertReportUploadAccepted(receipt)).not.toThrow();
  expect(isExistingReportUploadReceipt(receipt)).toBe(false);
  expect(isExistingReportUploadReceipt({ ...receipt, reusedAcceptance: true })).toBe(true);
});

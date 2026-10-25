import { realEstateSubmissionPath, shouldResubmitRealEstate } from './realEstateSubmission';

it.each(['approved', 'pending_approval'])('resubmits %s reports even from an outdated pending screen', (status) => {
  expect(shouldResubmitRealEstate(status, 'pending')).toBe(true);
  expect(realEstateSubmissionPath('report-id', status, 'pending')).toBe('/real-estate/report-id/resubmit');
});

it.each(['preview', 'declined'])('submits %s previews even if the navigation mode is stale', (status) => {
  expect(shouldResubmitRealEstate(status, 'submitted')).toBe(false);
  expect(realEstateSubmissionPath('report-id', status, 'submitted')).toBe('/real-estate/preview/report-id/submit');
});

it('retains older navigation compatibility only when no status has loaded', () => {
  expect(realEstateSubmissionPath('report-id', '', 'submitted')).toBe('/real-estate/report-id/resubmit');
});

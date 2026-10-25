import { captureContinuationDetails } from './continuationDetails';

it('copies only editable details, preserves explicit false/empty values and owns its arrays', () => {
  const selectedValuationMethods = ['FML', 'TKV'] as const;
  const details = captureContinuationDetails({
    clientSubmissionId: 'old', supersedesClientSubmissionId: 'older', auctioneerWorkItemId: 'old-work',
    captureMode: 'offline', manualSubmissionRequired: true, auctionCloseContract: true,
    auctioneerSnapshot: {} as any, auctionServiceSelections: { 0: ['old-service'] },
    contractNo: 'contract', ownerName: '', bankPhotosEnabled: false, currency: 'CAD',
    selectedValuationMethods: [...selectedValuationMethods],
  });
  expect(details).toEqual({ contractNo: 'contract', ownerName: '', bankPhotosEnabled: false, currency: 'CAD', selectedValuationMethods: ['FML', 'TKV'] });
  expect(captureContinuationDetails()).toBeUndefined();
  const second = captureContinuationDetails(details);
  second?.selectedValuationMethods?.push('FLV');
  expect(details?.selectedValuationMethods).toEqual(['FML', 'TKV']);
});

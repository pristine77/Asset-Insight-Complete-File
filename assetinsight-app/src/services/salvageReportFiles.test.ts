import { groupSalvageReportFiles } from './salvageReportFiles';

it('groups all report artifacts without bypassing individual download/release decisions', () => {
  const base = { report: 'report-one', reportType: 'Salvage', address: 'Claim 123', status: 'approved', release_status: 'released' as const };
  const [group] = groupSalvageReportFiles([
    { ...base, _id: 'file-pdf', fileType: 'pdf', downloadable: true },
    { ...base, _id: 'file-docx', fileType: 'docx', downloadable: true },
    { ...base, _id: 'file-xlsx', fileType: 'xlsx', downloadable: false, release_status: 'pending_release' },
    { ...base, _id: 'file-zip', fileType: 'images' },
    { ...base, _id: 'asset', reportType: 'Asset', fileType: 'pdf', downloadable: true },
  ]);
  expect(group.id).toBe('report-one');
  expect(group.files).toEqual({ pdf: 'file-pdf', docx: 'file-docx' });
  expect(group.releaseStatus).toBe('pending_release');
});

it('keeps pending/declined salvage visible without enabling unsupported editable previews or downloads', () => {
  const [group] = groupSalvageReportFiles([{ _id: 'file', reportType: 'Salvage', status: 'rejected', downloadable: false, fileType: 'pdf' }]);
  expect(group.status).toBe('declined');
  expect(group.downloadable).toBe(false);
  expect(group.files).toEqual({});
});

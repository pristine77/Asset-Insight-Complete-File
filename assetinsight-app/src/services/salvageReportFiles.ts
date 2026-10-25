export type SalvageFileKey = 'pdf' | 'docx' | 'excel' | 'images';
type FileRecord = {
  _id: string;
  report?: string | { _id?: string };
  reportType?: string;
  type?: string;
  status?: string;
  release_status?: 'pending_release' | 'released';
  downloadable?: boolean;
  fileType?: string;
  address?: string;
  fairMarketValue?: string;
  createdAt?: string;
};

/** Use approval/release-aware PdfReport rows, never the raw /salvage document paths. */
export function groupSalvageReportFiles(rows: FileRecord[]) {
  const groups = new Map<string, FileRecord[]>();
  for (const row of rows) {
    if (String(row.reportType || row.type).toLowerCase() !== 'salvage') continue;
    const id = typeof row.report === 'object' ? row.report?._id : row.report;
    const key = String(id || row._id);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()].map(([id, records]) => {
    const first = records[0];
    const files: Partial<Record<SalvageFileKey, string>> = {};
    for (const record of records) {
      if (record.status !== 'approved' || record.downloadable !== true) continue;
      const key = record.fileType === 'xlsx' ? 'excel' : record.fileType;
      if (key === 'pdf' || key === 'docx' || key === 'excel' || key === 'images') {
        // Existing list is newest-first. Do not overwrite with an older artifact.
        files[key] ||= record._id;
      }
    }
    return {
      id,
      name: first.address || 'Salvage Report',
      status: records.every((row) => row.status === 'approved') ? 'approved' : records.some((row) => row.status === 'rejected' || row.status === 'declined') ? 'declined' : 'pending_approval',
      releaseStatus: records.every((row) => row.release_status === 'released') ? 'released' as const : 'pending_release' as const,
      downloadable: Object.keys(files).length > 0,
      fmv: String(first.fairMarketValue || 'CAD -'),
      createdAt: first.createdAt || '',
      files,
    };
  });
}

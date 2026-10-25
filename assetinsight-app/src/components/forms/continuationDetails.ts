import type { AutoSaveFormData } from '../../services/autoSaveService';

// Carry editable report details only. Submission, draft, activity, lot/media and
// integration identities belong to the fresh server-validated form, never here.
const detailKeys = [
  'clientName', 'effectiveDate', 'appraisalPurpose', 'ownerName', 'appraiser',
  'appraisalCompany', 'industry', 'inspectionDate', 'contractNo', 'location',
  'latitude', 'longitude', 'salesDate', 'language', 'currency', 'preparedFor',
  'factorsAgeCondition', 'factorsQuality', 'factorsAnalysis', 'includeDamageAnalysis',
  'enhanceImages', 'bankPhotosEnabled', 'watermarkImages', 'includeValuationTable',
  'selectedValuationMethods',
] as const satisfies readonly (keyof AutoSaveFormData)[];

export type ContinuationDetails = Pick<AutoSaveFormData, typeof detailKeys[number]>;

export function captureContinuationDetails(data?: AutoSaveFormData): ContinuationDetails | undefined {
  if (!data) return undefined;
  return Object.fromEntries(detailKeys.filter(key => data[key] !== undefined).map(key => [
    key, Array.isArray(data[key]) ? [...data[key]] : data[key],
  ])) as ContinuationDetails;
}

import {
  getCurrentR2StorageTarget,
  isCurrentR2StorageTarget,
  resolvePersistedR2StorageTarget,
  type R2StorageTarget,
} from "./r2Storage/r2Upload.js";

export type CrmImportStorageSnapshot = {
  sourceFileBucket?: unknown;
  sourceFilePublicBaseUrl?: unknown;
};

export function snapshotCurrentCrmImportStorage(): {
  sourceFileBucket: string;
  sourceFilePublicBaseUrl: string;
} {
  const target = getCurrentR2StorageTarget();
  return {
    sourceFileBucket: target.bucketName,
    sourceFilePublicBaseUrl: target.publicBaseUrl,
  };
}

export function resolveCrmImportStorageTarget(
  value?: CrmImportStorageSnapshot | null
): R2StorageTarget {
  return resolvePersistedR2StorageTarget({
    r2Bucket: value?.sourceFileBucket,
    r2PublicBaseUrl: value?.sourceFilePublicBaseUrl,
  });
}

export function isCurrentCrmImportStorageTarget(
  value?: CrmImportStorageSnapshot | null
): boolean {
  return isCurrentR2StorageTarget(resolveCrmImportStorageTarget(value));
}

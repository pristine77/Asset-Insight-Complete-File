import type { ArrivalPhotoRequest } from './auctioneerService';

/** Local recovery metadata only. Arrival captures must never become AI reports. */
export interface ArrivalPhotoDraftData {
  capturePurpose?: 'arrivalPhotos';
  arrivalPhotoRequestId?: string;
  arrivalPhotoRequest?: ArrivalPhotoRequest;
}

export function isArrivalPhotoDraft(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' &&
    ((value as ArrivalPhotoDraftData).capturePurpose === 'arrivalPhotos' ||
      (value as ArrivalPhotoDraftData).arrivalPhotoRequestId || (value as ArrivalPhotoDraftData).arrivalPhotoRequest));
}

export function assertOrdinaryReport(value: unknown): void {
  if (isArrivalPhotoDraft(value)) {
    throw new Error('These are Arrival Photos. Open the saved capture and use Send to send them to the selected Auctioneer lot. They cannot create a report or cloud preview.');
  }
}

import { requireNativeView } from 'expo';
import * as React from 'react';

import { AuctionCameraViewProps } from './AuctionCamera.types';

const NativeView: React.ComponentType<AuctionCameraViewProps> =
  requireNativeView('AuctionCamera');

export default function AuctionCameraView(props: AuctionCameraViewProps) {
  return <NativeView {...props} />;
}

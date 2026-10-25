import * as React from 'react';

import { AuctionCameraViewProps } from './AuctionCamera.types';

export default function AuctionCameraView(props: AuctionCameraViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}

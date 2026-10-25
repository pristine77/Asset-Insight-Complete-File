import { registerWebModule, NativeModule } from 'expo';

import { ChangeEventPayload } from './AuctionCamera.types';

type AuctionCameraModuleEvents = {
  onChange: (params: ChangeEventPayload) => void;
}

class AuctionCameraModule extends NativeModule<AuctionCameraModuleEvents> {
  PI = Math.PI;
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
  hello() {
    return 'Hello world! 👋';
  }
};

export default registerWebModule(AuctionCameraModule, 'AuctionCameraModule');

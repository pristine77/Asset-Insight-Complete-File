declare module "heic-decode" {
  type HeicImageDescriptor = {
    width: number;
    height: number;
    decode(): Promise<{
      width: number;
      height: number;
      data: Uint8ClampedArray;
    }>;
  };

  type HeicImageDescriptors = HeicImageDescriptor[] & {
    dispose(): void;
  };

  type DecodeHeic = {
    (args: { buffer: Buffer }): Promise<{
      width: number;
      height: number;
      data: Uint8ClampedArray;
    }>;
    all(args: { buffer: Buffer }): Promise<HeicImageDescriptors>;
  };

  const decode: DecodeHeic;
  export = decode;
}

declare module "heic-convert" {
  type HeicConvertInput = {
    buffer: Buffer | ArrayBuffer | Uint8Array;
    format: "JPEG" | "PNG";
    quality?: number;
  };

  function convert(input: HeicConvertInput): Promise<Buffer | ArrayBuffer | Uint8Array>;

  export = convert;
}

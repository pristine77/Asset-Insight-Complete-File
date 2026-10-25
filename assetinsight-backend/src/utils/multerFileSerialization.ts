export type SerializedMulterFile = {
  fieldname?: string;
  originalname?: string;
  encoding?: string;
  mimetype?: string;
  destination?: string;
  filename?: string;
  path?: string;
  size?: number;
  r2Key?: string;
  r2Bucket?: string;
  r2PublicUrl?: string;
  lotIndex?: number;
  imageIndex?: number;
  captureOrder?: number;
  originalOrder?: number;
  role?: "main" | "extra" | "video";
};

export function serializeMulterFiles(
  files: Express.Multer.File[] | undefined
): SerializedMulterFile[] {
  if (!Array.isArray(files)) return [];

  return files.map((file: any) => ({
    fieldname: file.fieldname,
    originalname: file.originalname,
    encoding: file.encoding,
    mimetype: file.mimetype,
    destination: file.destination,
    filename: file.filename,
    path: file.path,
    size: file.size,
    r2Key: file.r2Key,
    r2Bucket: file.r2Bucket,
    r2PublicUrl: file.r2PublicUrl,
    lotIndex: file.lotIndex,
    imageIndex: file.imageIndex,
    captureOrder: file.captureOrder,
    originalOrder: file.originalOrder,
    role: file.role,
  }));
}

export function deserializeMulterFiles(
  files: SerializedMulterFile[] | undefined
): Express.Multer.File[] {
  if (!Array.isArray(files)) return [];

  return files.map((file) => ({ ...file }) as Express.Multer.File);
}

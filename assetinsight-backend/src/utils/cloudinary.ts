import { v2 as cloudinary } from "cloudinary";

// Configure Cloudinary with env variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export { cloudinary };

export function isCloudinaryFetchConfigured(): boolean {
  const enabled = /^(?:1|true|yes|on)$/i.test(
    String(process.env.CLOUDINARY_FETCH_ENABLED || "").trim()
  );

  // A cloud name alone does not guarantee that remote Fetch delivery is enabled
  // for the account. Require an explicit opt-in to avoid a failed request per image.
  return enabled && Boolean(String(process.env.CLOUDINARY_CLOUD_NAME || "").trim());
}

/**
 * AI Enhancement Presets for Cloudinary
 * These provide the best quality/size balance with AI features
 */
export const CLOUDINARY_PRESETS = {
  // Best for web - AI optimized, excellent quality, small size (~150-300KB)
  webOptimized: {
    fetch_format: "auto",
    quality: "auto:good",
    width: 1400,
    height: 1050,
    crop: "limit",
    effect: "improve", // AI color/contrast enhancement
  },
  
  // High quality for print/documents (~300-500KB)
  highQuality: {
    fetch_format: "auto",
    quality: "auto:best",
    width: 1920,
    height: 1440,
    crop: "limit",
    effect: "improve",
  },
  
  // Thumbnail/mobile (~50-100KB)
  thumbnail: {
    fetch_format: "auto",
    quality: "auto:eco",
    width: 800,
    height: 600,
    crop: "limit",
  },
  
  // Document/report images (~100-200KB)
  document: {
    format: "jpg",
    quality: "auto:good",
    width: 1200,
    height: 900,
    crop: "limit",
    effect: "improve",
  },
  
  // Maximum AI enhancement
  aiEnhanced: {
    fetch_format: "auto",
    quality: "auto:best",
    width: 1920,
    height: 1440,
    crop: "limit",
    effect: "improve:outdoor", // Best for outdoor/landscape
  },
} as const;

/**
 * Generate optimized Cloudinary URL for an external image using Fetch
 */
export function getCloudinaryFetchUrl(
  imageUrl: string,
  preset: keyof typeof CLOUDINARY_PRESETS = "webOptimized"
): string {
  const settings = CLOUDINARY_PRESETS[preset];
  
  return cloudinary.url(imageUrl, {
    type: "fetch",
    ...settings,
  });
}

/**
 * Generate Cloudinary URL with custom transformations
 */
export function getCloudinaryCustomUrl(
  imageUrl: string,
  options: {
    width?: number;
    height?: number;
    quality?: "auto:best" | "auto:good" | "auto:eco" | "auto:low" | number;
    format?: "auto" | "jpg" | "webp" | "png";
    enhance?: boolean;
  }
): string {
  const { width, height, quality = "auto:good", format = "auto", enhance = true } = options;

  const transformations: any = {
    type: "fetch",
    fetch_format: format,
    quality,
  };

  if (width) transformations.width = width;
  if (height) transformations.height = height;
  if (width || height) transformations.crop = "limit";
  if (enhance) transformations.effect = "improve";

  return cloudinary.url(imageUrl, transformations);
}

/**
 * Upload image to Cloudinary (for permanent storage)
 */
export async function uploadToCloudinary(
  imageBuffer: Buffer,
  options: {
    folder?: string;
    publicId?: string;
    tags?: string[];
  } = {}
): Promise<{ url: string; publicId: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || "gallery",
        public_id: options.publicId,
        tags: options.tags,
        resource_type: "image",
        transformation: [
          { quality: "auto:best" },
          { fetch_format: "auto" },
        ],
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error("No result from Cloudinary"));
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          bytes: result.bytes,
        });
      }
    );

    uploadStream.end(imageBuffer);
  });
}

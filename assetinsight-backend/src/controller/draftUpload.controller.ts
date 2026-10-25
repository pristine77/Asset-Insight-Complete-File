/**
 * Legacy user-scoped local-media staging for saved-input drafts.
 *
 * Files are isolated beneath an authenticated-user directory and returned as relative
 * URLs for existing clients. Client file ids and modification times survive upload so
 * autosave reconciliation can match browser/mobile files without relying on filenames.
 */
import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create uploads/drafts directory if it doesn't exist
const DRAFTS_DIR = path.join(__dirname, '../../uploads/drafts');

const ensureDraftDir = (userId: string) => {
  const userDir = path.join(DRAFTS_DIR, userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
};

// Configure multer for fast file uploads
const storage = multer.diskStorage({
  destination: (req: any, file, cb) => {
    const userId = req.userId;
    if (!userId) {
      return cb(new Error('User not authenticated'), '');
    }
    const userDir = ensureDraftDir(userId);
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp-random-originalname
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${uniqueSuffix}-${baseName}${ext}`);
  },
});

// Multer upload config - no file size limit, optimized for speed
export const draftUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Accept images and videos
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  },
});

// Type for uploaded file info
export type DraftImageInfo = {
  clientFileId: string;
  lotId: string;
  type: 'main' | 'extra' | 'video';
  name: string;
  url: string;
  mimeType: string;
  size: number;
  lastModified?: number;
};

const optionalFiniteNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const parseUploadMetadata = (value: unknown): any[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// @desc    Upload draft images (multiple files)
// @route   POST /api/saved-inputs/draft/upload
// @access  Private
export const uploadDraftImages = async (req: AuthRequest, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    const { lotId, type } = req.body;

    if (!files || files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }

    if (!lotId) {
      return res.status(400).json({ message: 'lotId is required' });
    }

    const imageType = type || 'main';
    const metadata = parseUploadMetadata(req.body.metadata);
    
    // Store relative URLs - frontend will add API base URL
    const uploadedImages: DraftImageInfo[] = files.map((file, index) => {
      const meta = metadata[index] || {};
      const clientFileId =
        typeof meta.clientFileId === 'string' && meta.clientFileId.trim()
          ? meta.clientFileId.trim().slice(0, 200)
          : randomUUID();
      const lastModified = optionalFiniteNumber(meta.lastModified);
      return {
        clientFileId,
        lotId,
        type: imageType,
        name: file.originalname,
        url: `/uploads/drafts/${req.userId}/${file.filename}`,
        mimeType: file.mimetype,
        size: file.size,
        ...(lastModified !== undefined ? { lastModified } : {}),
      };
    });

    res.status(200).json({
      message: `${files.length} files uploaded successfully`,
      data: uploadedImages,
    });
  } catch (error: any) {
    console.error('Error uploading draft images:', error);
    res.status(500).json({ message: error?.message || 'Failed to upload images' });
  }
};

// @desc    Delete all draft images for a user
// @route   DELETE /api/saved-inputs/draft/images
// @access  Private
export const deleteDraftImages = async (req: AuthRequest, res: Response) => {
  try {
    const userDir = path.join(DRAFTS_DIR, req.userId!);
    
    if (fs.existsSync(userDir)) {
      // Delete all files in user's draft directory
      const files = fs.readdirSync(userDir);
      for (const file of files) {
        fs.unlinkSync(path.join(userDir, file));
      }
      // Optionally remove the directory itself
      fs.rmdirSync(userDir);
    }

    res.status(200).json({ message: 'Draft images deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting draft images:', error);
    res.status(500).json({ message: error?.message || 'Failed to delete draft images' });
  }
};

// @desc    Delete specific draft images by URLs
// @route   POST /api/saved-inputs/draft/delete-images
// @access  Private
export const deleteSpecificDraftImages = async (req: AuthRequest, res: Response) => {
  try {
    const { urls } = req.body;
    
    if (!urls || !Array.isArray(urls)) {
      return res.status(400).json({ message: 'urls array is required' });
    }

    const userDir = path.join(DRAFTS_DIR, req.userId!);
    let deletedCount = 0;

    for (const url of urls) {
      try {
        // Extract filename from URL
        const filename = path.basename(url);
        const filePath = path.join(userDir, filename);
        
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      } catch (e) {
        console.warn('Failed to delete file:', url);
      }
    }

    res.status(200).json({ 
      message: `${deletedCount} files deleted successfully`,
      deletedCount,
    });
  } catch (error: any) {
    console.error('Error deleting specific draft images:', error);
    res.status(500).json({ message: error?.message || 'Failed to delete images' });
  }
};

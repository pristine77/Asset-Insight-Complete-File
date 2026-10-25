/**
 * Authenticated self-service profile, CV and account lifecycle controller.
 *
 * The actor always comes from the session; callers cannot select another user. Profile
 * writes are allow-listed, secrets are excluded from responses, and account deletion
 * cascades device/security records so revoked identity material cannot outlive the user.
 */
import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import User, { CRM_SPECIALIZATION_VALUES } from '../models/user.model.js';
import { AuthRequest } from '../middleware/auth.middleware.js';
import {
  deleteFromR2,
  getCurrentR2StorageTarget,
  isCurrentR2StorageTarget,
  resolvePersistedR2StorageTarget,
  uploadBufferToR2,
  uploadToR2,
} from '../utils/r2Storage/r2Upload.js';
import { normalizeCrmGeoLocation } from '../service/crmGeoAssignmentService.js';
import { attachUserCapabilities } from '../utils/userCapabilities.js';
import { cascadeDeleteSecurityRecords } from '../service/deviceAccessService.js';
import { disconnectProposalValuationUser } from '../service/proposalValuationRealtimeService.js';

const CRM_SPECIALIZATION_SET = new Set<string>(CRM_SPECIALIZATION_VALUES as readonly string[]);

const CRM_QUADRANT_OPTIONS = ['NW', 'NE', 'SW', 'SE', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'CENTRAL'] as const;
const CRM_QUADRANT_SET = new Set<string>(CRM_QUADRANT_OPTIONS);

function normalizeCrmQuadrants(value: unknown): string {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  return Array.from(
    new Set(
      rawValues
        .map((item) => String(item || '').trim().toUpperCase())
        .filter((item) => CRM_QUADRANT_SET.has(item as (typeof CRM_QUADRANT_OPTIONS)[number]))
    )
  ).join(',');
}

function normalizeCrmSpecializations(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  return Array.from(
    new Set(
      rawValues
        .map((item) => String(item || '').trim().toLowerCase())
        .filter((item) => CRM_SPECIALIZATION_SET.has(item))
    )
  );
}

// @desc    Get user profile
// @route   GET /api/user/me
// @access  Private
export const getUserProfile = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select('-password -refreshTokens');
    if (user) {
      res.json(await attachUserCapabilities(user));
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Upload/replace appraiser CV to R2 and save URL on user
// @route   POST /api/user/cv
// @access  Private
export const uploadUserCv = async (req: AuthRequest, res: Response) => {
  try {
    const file = (req as any)?.file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({ message: 'No file provided' });
    }

    const safeName = String(file.originalname || 'cv').replace(/\s+/g, '_');
    const cvFilename = `${req.userId}-${Date.now()}-${safeName}`;
    const key = `cv/${cvFilename}`;
    const storage = getCurrentR2StorageTarget();
    if (!storage.bucketName) throw new Error('R2 bucket is not configured');

    const publicUrl = await uploadToR2(file, storage.bucketName, key);

    const updated = await User.findByIdAndUpdate(
      req.userId,
      {
        $set: {
          cvUrl: publicUrl,
          cvFilename,
          cvKey: key,
          cvBucket: storage.bucketName,
          cvPublicBaseUrl: storage.publicBaseUrl,
          cvUploadedAt: new Date(),
        },
      },
      { new: true }
    ).select('-password -refreshTokens');

    if (!updated) return res.status(404).json({ message: 'User not found' });
    res.json(await attachUserCapabilities(updated));
  } catch (error: any) {
    res.status(500).json({ message: error?.message || 'Failed to upload CV' });
  }
};

// @desc    Delete CV link from user (does not remove from R2)
// @route   DELETE /api/user/cv
// @access  Private
export const deleteUserCv = async (req: AuthRequest, res: Response) => {
  try {
    const updated = await User.findByIdAndUpdate(
      req.userId,
      {
        $unset: {
          cvUrl: 1,
          cvFilename: 1,
          cvKey: 1,
          cvBucket: 1,
          cvPublicBaseUrl: 1,
          cvUploadedAt: 1,
        },
      },
      { new: true }
    ).select('-password -refreshTokens');
    if (!updated) return res.status(404).json({ message: 'User not found' });
    res.json(await attachUserCapabilities(updated));
  } catch (error: any) {
    res.status(500).json({ message: error?.message || 'Failed to delete CV' });
  }
};

// @desc    Upload or replace the authenticated user's profile picture
// @route   POST /api/user/avatar
// @access  Private
export const uploadUserAvatar = async (req: AuthRequest, res: Response) => {
  try {
    const file = (req as any)?.file as Express.Multer.File | undefined;
    if (!file?.buffer) {
      return res.status(400).json({ message: 'Select a profile picture to upload' });
    }

    let normalized: Buffer;
    try {
      normalized = await sharp(file.buffer)
        .rotate()
        .resize(512, 512, { fit: 'cover', position: 'attention' })
        .webp({ quality: 86, effort: 4 })
        .toBuffer();
    } catch {
      return res.status(400).json({ message: 'The selected profile picture is not a valid image' });
    }

    const user = await User.findById(req.userId).select(
      'avatarKey avatarBucket avatarPublicBaseUrl'
    );
    if (!user) return res.status(404).json({ message: 'User not found' });

    const key = `avatars/${req.userId}/${Date.now()}-${randomUUID()}.webp`;
    const storage = getCurrentR2StorageTarget();
    if (!storage.bucketName) throw new Error('R2 bucket is not configured');

    // Upload first and update Mongo second. The previous image remains valid if
    // either operation fails, avoiding broken avatars during replacement.
    const avatarUrl = await uploadBufferToR2(
      normalized,
      'image/webp',
      storage.bucketName,
      key
    );
    const previousKey = String((user as any).avatarKey || '');
    const previousStorage = resolvePersistedR2StorageTarget({
      r2Bucket: (user as any).avatarBucket,
      r2PublicBaseUrl: (user as any).avatarPublicBaseUrl,
    });
    const updated = await User.findByIdAndUpdate(
      req.userId,
      {
        $set: {
          avatarUrl,
          avatarKey: key,
          avatarBucket: storage.bucketName,
          avatarPublicBaseUrl: storage.publicBaseUrl,
          avatarUploadedAt: new Date(),
        },
      },
      { new: true, runValidators: true }
    ).select('-password -refreshTokens');

    if (!updated) return res.status(404).json({ message: 'User not found' });
    if (previousKey && previousKey !== key && isCurrentR2StorageTarget(previousStorage)) {
      void deleteFromR2(previousStorage.bucketName, previousKey).catch((cleanupError) => {
        console.warn('[ProfileAvatar] previous image cleanup failed:', cleanupError);
      });
    }
    return res.json(await attachUserCapabilities(updated));
  } catch (error: any) {
    console.error('[ProfileAvatar] upload failed:', error);
    return res.status(500).json({ message: error?.message || 'Failed to upload profile picture' });
  }
};

// @desc    Remove the authenticated user's profile picture
// @route   DELETE /api/user/avatar
// @access  Private
export const deleteUserAvatar = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select(
      'avatarKey avatarBucket avatarPublicBaseUrl'
    );
    if (!user) return res.status(404).json({ message: 'User not found' });

    const previousKey = String((user as any).avatarKey || '');
    const previousStorage = resolvePersistedR2StorageTarget({
      r2Bucket: (user as any).avatarBucket,
      r2PublicBaseUrl: (user as any).avatarPublicBaseUrl,
    });
    const updated = await User.findByIdAndUpdate(
      req.userId,
      {
        $unset: {
          avatarUrl: 1,
          avatarKey: 1,
          avatarBucket: 1,
          avatarPublicBaseUrl: 1,
          avatarUploadedAt: 1,
        },
      },
      { new: true }
    ).select('-password -refreshTokens');
    if (!updated) return res.status(404).json({ message: 'User not found' });

    if (previousKey && isCurrentR2StorageTarget(previousStorage)) {
      void deleteFromR2(previousStorage.bucketName, previousKey).catch((cleanupError) => {
        console.warn('[ProfileAvatar] image cleanup failed:', cleanupError);
      });
    }
    return res.json(await attachUserCapabilities(updated));
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'Failed to remove profile picture' });
  }
};

// @desc    Update user profile (excluding email)
// @route   PATCH /api/user
// @access  Private
export const updateUserProfile = async (req: AuthRequest, res: Response) => {
  try {
    const allowedFields = [
      'username',
      'companyName',
      'contactEmail',
      'contactPhone',
      'companyAddress',
      'crmAddress',
      'crmQuadrant',
      'crmSpecializations',
    ];

    const update: Record<string, any> = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        if (key === 'crmSpecializations') {
          update[key] = normalizeCrmSpecializations((req.body as any)[key]);
        } else if (key === 'crmQuadrant') {
          update[key] = normalizeCrmQuadrants((req.body as any)[key]);
        } else if (key === 'crmAddress') {
          const address = String((req.body as any)[key] || '').trim();
          update[key] = address;
          update.crmGeo = address ? await normalizeCrmGeoLocation(address) : undefined;
        } else {
          update[key] = (req.body as any)[key];
        }
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: update },
      { new: true, runValidators: true }
    ).select('-password -refreshTokens');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(await attachUserCapabilities(user));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Delete user account
// @route   DELETE /api/user
// @access  Private
export const deleteUserAccount = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select('+password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // If the user signed up with email, we need to verify their password
    if (user.authProvider === 'email') {
      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ message: 'Password is required' });
      }

      // This should not happen for email provider, but as a safeguard
      if (!user.password) {
        return res.status(400).json({ message: 'Password not set for this account.' });
      }

      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }
    }

    // For Google-authenticated users, or if email/password is a match, proceed with deletion.
    await cascadeDeleteSecurityRecords(String(req.userId));
    await User.findByIdAndDelete(req.userId);
    disconnectProposalValuationUser(String(req.userId), 'account-self-deleted');

    res.json({ message: 'User account deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

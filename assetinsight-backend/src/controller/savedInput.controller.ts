/**
 * User-owned saved form inputs and legacy autosave endpoints.
 *
 * Every lookup and mutation combines the resource id with the authenticated user id;
 * a valid id from another account therefore behaves as not found. Autosave normally
 * reuses the first matching user/report-type draft, but database uniqueness is not
 * enforced for concurrent creates.
 */
import { Response } from 'express';
import SavedInput from '../models/savedInput.model.js';
import { AuthRequest } from '../middleware/auth.middleware.js';

const optionalFiniteNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

// @desc    Create a new saved input
// @route   POST /api/saved-inputs
// @access  Private
export const createSavedInput = async (req: AuthRequest, res: Response) => {
  try {
    const { name, formData, formType } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    if (!formData || typeof formData !== 'object') {
      return res.status(400).json({ message: 'Form data is required' });
    }

    const savedInput = new SavedInput({
      user: req.userId as any,
      name: name.trim(),
      formType: formType || 'asset',
      formData,
    });

    await savedInput.save();

    res.status(201).json({
      message: 'Input saved successfully',
      data: savedInput,
    });
  } catch (error: any) {
    console.error('Error creating saved input:', error);
    res.status(500).json({ message: error?.message || 'Failed to save input' });
  }
};

// @desc    Get all saved inputs for current user
// @route   GET /api/saved-inputs
// @access  Private
export const getSavedInputs = async (req: AuthRequest, res: Response) => {
  try {
    const formType =
      typeof req.query.formType === 'string' ? req.query.formType : undefined;
    const filter: any = { user: req.userId as any };
    if (formType && (formType === 'asset' || formType === 'realEstate')) {
      filter.formType = formType;
    }
    const savedInputs = await SavedInput.find(filter)
      .sort({ createdAt: -1 })
      .select('-__v');

    res.status(200).json({
      message: 'Saved inputs fetched successfully',
      data: savedInputs,
    });
  } catch (error: any) {
    console.error('Error fetching saved inputs:', error);
    res.status(500).json({ message: error?.message || 'Failed to fetch saved inputs' });
  }
};

// @desc    Get a single saved input by ID
// @route   GET /api/saved-inputs/:id
// @access  Private
export const getSavedInputById = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const savedInput = await SavedInput.findOne({
      _id: id as any,
      user: req.userId as any,
    }).select('-__v');

    if (!savedInput) {
      return res.status(404).json({ message: 'Saved input not found' });
    }

    res.status(200).json({
      message: 'Saved input fetched successfully',
      data: savedInput,
    });
  } catch (error: any) {
    console.error('Error fetching saved input:', error);
    res.status(500).json({ message: error?.message || 'Failed to fetch saved input' });
  }
};

// @desc    Update a saved input
// @route   PUT /api/saved-inputs/:id
// @access  Private
export const updateSavedInput = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, formData } = req.body;

    const savedInput = await SavedInput.findOne({
      _id: id as any,
      user: req.userId as any,
    });

    if (!savedInput) {
      return res.status(404).json({ message: 'Saved input not found' });
    }

    if (name && name.trim()) {
      savedInput.name = name.trim();
    }

    if (formData && typeof formData === 'object') {
      savedInput.formData = formData;
    }

    await savedInput.save();

    res.status(200).json({
      message: 'Input updated successfully',
      data: savedInput,
    });
  } catch (error: any) {
    console.error('Error updating saved input:', error);
    res.status(500).json({ message: error?.message || 'Failed to update input' });
  }
};

// @desc    Delete a saved input
// @route   DELETE /api/saved-inputs/:id
// @access  Private
export const deleteSavedInput = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const savedInput = await SavedInput.findOneAndDelete({
      _id: id as any,
      user: req.userId as any,
    });

    if (!savedInput) {
      return res.status(404).json({ message: 'Saved input not found' });
    }

    res.status(200).json({
      message: 'Input deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting saved input:', error);
    res.status(500).json({ message: error?.message || 'Failed to delete input' });
  }
};

// ===================
// DRAFT ENDPOINTS (Cross-device sync)
// ===================

// @desc    Save or update auto-draft (upsert - one draft per user per formType)
// @route   POST /api/saved-inputs/draft
// @access  Private
export const saveAutoDraft = async (req: AuthRequest, res: Response) => {
  try {
    const { formType, formData, draftImages } = req.body;

    if (!formData || typeof formData !== 'object') {
      return res.status(400).json({ message: 'Form data is required' });
    }

    // Find existing draft or create new one (one draft per user per formType)
    const existingDraft = await SavedInput.findOne({
      user: req.userId as any,
      formType: formType || 'asset',
      isDraft: true,
    });

    // draftImages should now contain URLs (not base64)
    const imageData = (Array.isArray(draftImages) ? draftImages : []).map((img: any) => {
      const clientFileId =
        typeof img?.clientFileId === 'string' && img.clientFileId.trim()
          ? img.clientFileId.trim().slice(0, 200)
          : undefined;
      const size = optionalFiniteNumber(img?.size);
      const lastModified = optionalFiniteNumber(img?.lastModified);
      return {
        ...(clientFileId ? { clientFileId } : {}),
        lotId: img?.lotId,
        type: img?.type,
        name: img?.name,
        url: img?.url, // Store URL, not base64
        mimeType: img?.mimeType,
        ...(size !== undefined ? { size } : {}),
        ...(lastModified !== undefined ? { lastModified } : {}),
      };
    });

    if (existingDraft) {
      // Update existing draft
      existingDraft.formData = formData;
      existingDraft.draftImages = imageData as any;
      existingDraft.name = `Auto-Draft (${new Date().toLocaleString()})`;
      await existingDraft.save();

      return res.status(200).json({
        message: 'Draft updated successfully',
        data: existingDraft,
      });
    }

    // Create new draft
    const newDraft = new SavedInput({
      user: req.userId as any,
      name: `Auto-Draft (${new Date().toLocaleString()})`,
      formType: formType || 'asset',
      formData,
      isDraft: true,
      draftImages: imageData,
    });

    await newDraft.save();

    res.status(201).json({
      message: 'Draft saved successfully',
      data: newDraft,
    });
  } catch (error: any) {
    console.error('Error saving draft:', error);
    res.status(500).json({ message: error?.message || 'Failed to save draft' });
  }
};

// @desc    Get current user's auto-draft
// @route   GET /api/saved-inputs/draft
// @access  Private
export const getAutoDraft = async (req: AuthRequest, res: Response) => {
  try {
    const formType =
      typeof req.query.formType === 'string' ? req.query.formType : undefined;

    const draft = await SavedInput.findOne({
      user: req.userId as any,
      formType: formType || 'asset',
      isDraft: true,
    }).select('-__v');

    if (!draft) {
      return res.status(404).json({ message: 'No draft found' });
    }

    res.status(200).json({
      message: 'Draft fetched successfully',
      data: draft,
    });
  } catch (error: any) {
    console.error('Error fetching draft:', error);
    res.status(500).json({ message: error?.message || 'Failed to fetch draft' });
  }
};

// @desc    Delete current user's auto-draft
// @route   DELETE /api/saved-inputs/draft
// @access  Private
export const deleteAutoDraft = async (req: AuthRequest, res: Response) => {
  try {
    const formType =
      typeof req.query.formType === 'string' ? req.query.formType : undefined;

    const draft = await SavedInput.findOneAndDelete({
      user: req.userId as any,
      formType: formType || 'asset',
      isDraft: true,
    });

    if (!draft) {
      return res.status(404).json({ message: 'No draft found' });
    }

    res.status(200).json({
      message: 'Draft deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting draft:', error);
    res.status(500).json({ message: error?.message || 'Failed to delete draft' });
  }
};

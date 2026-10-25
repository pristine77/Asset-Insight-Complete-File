import mongoose from 'mongoose';

const savedInputSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  formType: {
    type: String,
    enum: ['asset', 'realEstate'],
    default: 'asset',
    index: true,
  },
  formData: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  // Auto-draft support
  isDraft: {
    type: Boolean,
    default: false,
    index: true,
  },
  // Store draft image URLs (files stored on server disk)
  draftImages: [{
    clientFileId: { type: String, trim: true },
    lotId: String,
    type: { type: String, enum: ['main', 'extra', 'video'] },
    name: String,
    url: String, // Server file URL
    mimeType: String,
    size: Number,
    lastModified: Number,
  }],
}, { timestamps: true });

// Index for faster queries
savedInputSchema.index({ user: 1, createdAt: -1 });

const SavedInput = mongoose.model('SavedInput', savedInputSchema);

export default SavedInput;

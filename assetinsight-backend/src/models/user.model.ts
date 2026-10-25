import mongoose from 'mongoose';

export const CRM_SPECIALIZATION_VALUES = [
  'industrial_construction',
  'farm_equipment_sales',
  'others',
] as const;

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: function(this: any) { return this.authProvider === 'email'; },
    sparse: true, // Allows multiple documents to have a null value for a unique field
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: function(this: any) { return this.authProvider === 'email'; },
    minlength: 6,
    select: false,
  },
  companyName: {
    type: String,
  },
  contactEmail: {
    type: String,
  },
  contactPhone: {
    type: String,
  },
  companyAddress: {
    type: String,
  },
  crmAddress: {
    type: String,
  },
  crmGeo: {
    type: mongoose.Schema.Types.Mixed,
  },
  crmQuadrant: {
    type: String,
    index: true,
  },
  crmSpecializations: {
    type: [{ type: String, enum: CRM_SPECIALIZATION_VALUES }],
    default: [],
  },
  isCrmAgent: {
    type: Boolean,
    default: false,
    index: true,
  },
  // Server-managed isolation boundary, never an editable profile/signup field.
  // Only the audited reviewer provisioning command may enroll an empty account.
  isReviewAccount: {
    type: Boolean,
    default: false,
  },
  reviewAccountSetupAudit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SecurityAuditEvent',
  },
  crmAssignedAt: {
    type: Date,
  },
  crmAssignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  crmDigestLastSentAt: {
    type: Date,
  },
  expoPushTokens: {
    type: [String],
    default: [],
  },
  msOutlookCalendarConnected: {
    type: Boolean,
    default: false,
    index: true,
  },
  msOutlookConnectedEmail: {
    type: String,
  },
  msOutlookConnectedAt: {
    type: Date,
  },
  msOutlookAccessToken: {
    type: String,
    select: false,
  },
  msOutlookRefreshToken: {
    type: String,
    select: false,
  },
  msOutlookTokenExpiresAt: {
    type: Date,
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'superadmin'],
    default: 'user',
    index: true,
  },
  // Support inbox access is an explicit capability, not an implication of the
  // broad admin role. Existing and newly created accounts remain requester-only
  // until an operator grants this flag with the audited CLI.
  canManageSupport: {
    type: Boolean,
    default: false,
  },
  // Proposal Valuation is an explicit per-user capability. It is intentionally
  // independent from report ownership and admin role so access can be revoked
  // without changing the user's account or workflow assignments.
  proposalValuationEnabled: {
    type: Boolean,
    default: false,
  },
  reportApprover: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  releaseManager: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  isBlocked: {
    type: Boolean,
    default: false,
    index: true,
  },
  deviceApprovalMode: {
    type: String,
    enum: ['per_device', 'all_devices'],
    default: 'per_device',
    index: true,
  },
  deviceApprovalModeChangedAt: {
    type: Date,
  },
  deviceApprovalModeChangedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  authProvider: {
    type: String,
    required: true,
    enum: ['email'],
    default: 'email',
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  verificationCode: {
    type: String,
  },
  verificationCodeExpires: {
    type: Date,
  },
  // Legacy single refresh token (kept for backward-compatible migration only)
  refreshToken: {
    type: String,
    select: false,
  },
  refreshTokens: [
    {
      tokenHash: { type: String, required: true },
      expiresAt: { type: Date, required: true },
      createdAt: { type: Date, default: Date.now },
      deviceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'DeviceRegistration',
        default: undefined,
      },
    },
  ],
  passwordResetToken: {
    type: String,
  },
  passwordResetExpires: {
    type: Date,
  },
  passwordResetCode: {
    type: String,
  },
  passwordResetCodeExpires: {
    type: Date,
  },
  // Appraiser CV / Resume
  cvUrl: {
    type: String,
  },
  cvFilename: {
    type: String,
  },
  cvKey: {
    type: String,
  },
  cvBucket: {
    type: String,
  },
  cvPublicBaseUrl: {
    type: String,
  },
  cvUploadedAt: {
    type: Date,
  },
  // Profile images are normalized before upload so every client can render a
  // small, predictable asset without downloading an original camera image.
  avatarUrl: {
    type: String,
  },
  avatarKey: {
    type: String,
  },
  avatarBucket: {
    type: String,
  },
  avatarPublicBaseUrl: {
    type: String,
  },
  avatarUploadedAt: {
    type: Date,
  },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

export default User;

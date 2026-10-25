import mongoose, { Schema } from "mongoose";

export interface IYoutubeConnection {
  _id: string;
  revision: number;
  connected: boolean;
  channelId?: string;
  channelTitle?: string;
  connectedAt?: Date;
  connectedBy?: string;
  consentVersion?: string;
  consentedAt?: Date;
  consentedBy?: string;
  disconnectedAt?: Date;
  disconnectedBy?: string;
  needsReconnect?: boolean;
  clientFingerprint?: string;
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  accessTokenExpiresAt?: Date;
  tokenVersion: number;
  refreshLeaseToken?: string;
  refreshLeaseUntil?: Date;
  dataCleanupStatus?: "pending" | "completed";
  dataCleanupRequestedAt?: Date;
  dataCleanupCompletedAt?: Date;
  dataCleanupThroughRevision?: number;
  dataCleanupReason?: "admin_revoke" | "admin_erase" | "authorization_invalid" | "authorizing_admin_unavailable" | "authorization_stale";
  revocationStatus?: "pending" | "completed" | "unavailable" | "needs_attention" | "manually_confirmed";
  revocationRequestedAt?: Date;
  revocationCompletedAt?: Date;
  revocationManuallyConfirmedAt?: Date;
  revocationManuallyConfirmedBy?: string;
  encryptedRevocationToken?: string;
  revocationTokenContext?: string;
  revocationAttempts?: number;
  revocationNextAttemptAt?: Date;
  lifecycleLeaseToken?: string;
  lifecycleLeaseUntil?: Date;
  authorizationCheckedAt?: Date;
  channelDataCheckedAt?: Date;
  oauthExchangeUntil?: Date;
  oauthExchangeToken?: string;
  authorizationCheckNextAt?: Date;
}

const connectionSchema = new Schema<IYoutubeConnection>({
  // Keep the disconnected singleton as a revision tombstone for old OAuth states.
  _id: { type: String, required: true },
  revision: { type: Number, required: true, default: 0 },
  connected: { type: Boolean, required: true, default: false },
  channelId: String,
  channelTitle: String,
  connectedAt: Date,
  connectedBy: String,
  consentVersion: String,
  consentedAt: Date,
  consentedBy: String,
  disconnectedAt: Date,
  disconnectedBy: String,
  needsReconnect: { type: Boolean, default: false },
  clientFingerprint: { type: String, select: false },
  encryptedAccessToken: { type: String, select: false },
  encryptedRefreshToken: { type: String, select: false },
  accessTokenExpiresAt: { type: Date, select: false },
  tokenVersion: { type: Number, required: true, default: 0, select: false },
  refreshLeaseToken: { type: String, select: false },
  refreshLeaseUntil: { type: Date, select: false },
  dataCleanupStatus: { type: String, enum: ["pending", "completed"] },
  dataCleanupRequestedAt: Date,
  dataCleanupCompletedAt: Date,
  dataCleanupThroughRevision: { type: Number, select: false },
  dataCleanupReason: { type: String, enum: ["admin_revoke", "admin_erase", "authorization_invalid", "authorizing_admin_unavailable", "authorization_stale"] },
  revocationStatus: { type: String, enum: ["pending", "completed", "unavailable", "needs_attention", "manually_confirmed"] },
  revocationRequestedAt: Date,
  revocationCompletedAt: Date,
  revocationManuallyConfirmedAt: Date,
  revocationManuallyConfirmedBy: { type: String, select: false },
  encryptedRevocationToken: { type: String, select: false },
  revocationTokenContext: { type: String, select: false },
  revocationAttempts: { type: Number, select: false },
  revocationNextAttemptAt: { type: Date, select: false },
  lifecycleLeaseToken: { type: String, select: false },
  lifecycleLeaseUntil: { type: Date, select: false },
  authorizationCheckedAt: Date,
  channelDataCheckedAt: Date,
  oauthExchangeUntil: { type: Date, select: false },
  oauthExchangeToken: { type: String, select: false },
  authorizationCheckNextAt: { type: Date, select: false },
}, { timestamps: true });

export interface IYoutubeOAuthState {
  _id: string;
  adminId: string;
  expectedRevision: number;
  expectedChannelId?: string;
  configFingerprint: string;
  encryptedVerifier: string;
  expiresAt: Date;
  consumedAt?: Date;
  consentVersion: string;
  consentedAt: Date;
}

const stateSchema = new Schema<IYoutubeOAuthState>({
  // Only the digest is retained; the authorization URL carries the random state.
  _id: { type: String, required: true },
  adminId: { type: String, required: true },
  expectedRevision: { type: Number, required: true },
  expectedChannelId: String,
  configFingerprint: { type: String, required: true, select: false },
  encryptedVerifier: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  consumedAt: Date,
  consentVersion: { type: String, required: true },
  consentedAt: { type: Date, required: true },
}, { timestamps: true });
stateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Defense in depth for accidental document serialization; controllers use DTOs.
for (const schema of [connectionSchema, stateSchema]) {
  schema.set("toJSON", { transform: (_document: unknown, value: Record<string, any>) => {
    for (const key of Object.keys(value)) {
      if (key.startsWith("encrypted") || ["clientFingerprint", "configFingerprint", "tokenVersion", "refreshLeaseToken", "refreshLeaseUntil", "accessTokenExpiresAt", "revocationTokenContext", "revocationAttempts", "revocationNextAttemptAt", "lifecycleLeaseToken", "lifecycleLeaseUntil", "dataCleanupThroughRevision", "authorizationCheckNextAt", "oauthExchangeUntil", "oauthExchangeToken"].includes(key)) delete value[key];
    }
    return value;
  } });
}

export const YoutubeOAuthState = mongoose.model<IYoutubeOAuthState>("YoutubeOAuthState", stateSchema);
export default mongoose.model<IYoutubeConnection>("YoutubeConnection", connectionSchema);

import { Response } from "express";
import ApiKey from "../models/apiKey.model.js";
import { type AdminAuthRequest } from "../middleware/admin.middleware.js";
import { createApiKey } from "../service/apiKeyService.js";

/**
 * Administrative HTTP boundary for API-key lifecycle operations.
 *
 * The controller deliberately returns only identifying metadata for stored keys.
 * The complete credential crosses the API boundary once, in the create response,
 * because the service persists a verifier rather than a recoverable secret.
 */

function formatApiKey(apiKey: any) {
  // Keep this projection stable: admin clients use it for both list and mutation responses.
  const createdBy = apiKey.createdBy;
  return {
    _id: String(apiKey._id),
    name: apiKey.name,
    keyId: apiKey.keyId,
    prefix: `cvak_${apiKey.keyId}`,
    last4: apiKey.last4,
    status: apiKey.revokedAt ? "revoked" : "active",
    createdBy:
      createdBy && typeof createdBy === "object"
        ? {
            _id: String(createdBy._id || ""),
            email: createdBy.email,
            username: createdBy.username,
            role: createdBy.role,
          }
        : null,
    createdAt: apiKey.createdAt,
    updatedAt: apiKey.updatedAt,
    lastUsedAt: apiKey.lastUsedAt,
    revokedAt: apiKey.revokedAt,
  };
}

function validateName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new Error("API key name is required");
  }
  if (name.length > 120) {
    throw new Error("API key name must be 120 characters or fewer");
  }
  return name;
}

export const listApiKeys = async (_req: AdminAuthRequest, res: Response) => {
  try {
    const apiKeys = await ApiKey.find({})
      .populate("createdBy", "email username role")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ data: apiKeys.map(formatApiKey) });
  } catch (error) {
    console.error("listApiKeys error", error);
    return res.status(500).json({ message: "Failed to fetch API keys" });
  }
};

export const postApiKey = async (req: AdminAuthRequest, res: Response) => {
  try {
    const name = validateName(req.body?.name);
    const createdBy = req.userId || String((req.user as any)?._id || "");
    if (!createdBy) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const result = await createApiKey({ name, createdBy });
    const apiKey = await ApiKey.findById(result.apiKey._id)
      .populate("createdBy", "email username role")
      .lean();

    // `apiKey` is intentionally separate from the reusable metadata in `item` so
    // consumers can treat it as a one-time secret and discard it after display.
    return res.status(201).json({
      apiKey: result.rawKey,
      item: formatApiKey(apiKey),
    });
  } catch (error: any) {
    return res
      .status(400)
      .json({ message: error?.message || "Failed to create API key" });
  }
};

export const renameApiKey = async (req: AdminAuthRequest, res: Response) => {
  try {
    const name = validateName(req.body?.name);
    const apiKey = await ApiKey.findByIdAndUpdate(
      req.params.id,
      { $set: { name } },
      { new: true }
    )
      .populate("createdBy", "email username role")
      .lean();

    if (!apiKey) {
      return res.status(404).json({ message: "API key not found" });
    }

    return res.status(200).json({ item: formatApiKey(apiKey) });
  } catch (error: any) {
    return res
      .status(400)
      .json({ message: error?.message || "Failed to rename API key" });
  }
};

export const revokeApiKey = async (req: AdminAuthRequest, res: Response) => {
  try {
    // Soft revocation retains the key identity. Repeated calls keep the key revoked
    // but refresh revokedAt, so this is retry-safe state rather than event history.
    const apiKey = await ApiKey.findByIdAndUpdate(
      req.params.id,
      { $set: { revokedAt: new Date() } },
      { new: true }
    )
      .populate("createdBy", "email username role")
      .lean();

    if (!apiKey) {
      return res.status(404).json({ message: "API key not found" });
    }

    return res.status(200).json({ item: formatApiKey(apiKey) });
  } catch (error) {
    console.error("revokeApiKey error", error);
    return res.status(500).json({ message: "Failed to revoke API key" });
  }
};

import { Request, Response, NextFunction } from "express";
import ApiKey from "../models/apiKey.model.js";
import {
  hashApiKeySecret,
  parseApiKey,
  secretHashesMatch,
} from "../service/apiKeyService.js";

type RateBucket = {
  windowStart: number;
  count: number;
};

const RATE_LIMIT_WINDOW_MS = Math.max(
  1_000,
  Number(process.env.API_KEY_RATE_LIMIT_WINDOW_MS || 60_000)
);
const RATE_LIMIT_MAX_REQUESTS = Math.max(
  1,
  Number(process.env.API_KEY_RATE_LIMIT_MAX_REQUESTS || 600)
);
const LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000;
const rateBuckets = new Map<string, RateBucket>();

export interface ApiKeyRequest extends Request {
  apiKey?: {
    id: string;
    keyId: string;
    name: string;
    createdBy: string;
  };
}

function apiError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

function extractApiKey(req: Request) {
  const authorization = req.headers.authorization || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  const headerValue = req.headers["x-api-key"];
  if (Array.isArray(headerValue)) return headerValue[0]?.trim() || "";
  return typeof headerValue === "string" ? headerValue.trim() : "";
}

function isRateLimited(keyId: string) {
  const now = Date.now();
  const current = rateBuckets.get(keyId);
  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(keyId, { windowStart: now, count: 1 });
    return false;
  }

  current.count += 1;
  return current.count > RATE_LIMIT_MAX_REQUESTS;
}

export const apiKeyProtect = async (
  req: ApiKeyRequest,
  res: Response,
  next: NextFunction
) => {
  const rawKey = extractApiKey(req);
  if (!rawKey) {
    return apiError(res, 401, "missing_api_key", "Missing API key");
  }

  const parsed = parseApiKey(rawKey);
  if (!parsed) {
    return apiError(res, 401, "invalid_api_key", "Invalid API key");
  }

  try {
    const apiKey = await ApiKey.findOne({ keyId: parsed.keyId }).select(
      "+secretHash name keyId revokedAt lastUsedAt createdBy"
    );
    if (!apiKey) {
      return apiError(res, 401, "invalid_api_key", "Invalid API key");
    }
    if (apiKey.revokedAt) {
      return apiError(res, 403, "revoked_api_key", "API key has been revoked");
    }

    const candidateHash = hashApiKeySecret(parsed.secret);
    if (!secretHashesMatch(apiKey.secretHash, candidateHash)) {
      return apiError(res, 401, "invalid_api_key", "Invalid API key");
    }

    if (isRateLimited(apiKey.keyId)) {
      return apiError(
        res,
        429,
        "rate_limited",
        "API key rate limit exceeded"
      );
    }

    req.apiKey = {
      id: String(apiKey._id),
      keyId: apiKey.keyId,
      name: apiKey.name,
      createdBy: String(apiKey.createdBy || ""),
    };

    const lastUsedAt = apiKey.lastUsedAt?.getTime() || 0;
    if (Date.now() - lastUsedAt > LAST_USED_UPDATE_INTERVAL_MS) {
      void ApiKey.updateOne(
        { _id: apiKey._id },
        { $set: { lastUsedAt: new Date() } }
      ).catch((error) => {
        console.error("Failed to update API key lastUsedAt", error);
      });
    }

    return next();
  } catch (error) {
    console.error("API key auth error", error);
    return apiError(res, 500, "server_error", "Failed to authenticate API key");
  }
};

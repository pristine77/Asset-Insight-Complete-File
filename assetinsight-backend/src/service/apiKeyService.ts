/**
 * Creates opaque API credentials while persisting only an HMAC digest and display-safe
 * suffix. The public id supports indexed lookup, the secret is shown once, and constant-
 * time comparison prevents authentication behavior from leaking digest information.
 */
import crypto from "crypto";
import ApiKey, { type IApiKey } from "../models/apiKey.model.js";

export const API_KEY_PREFIX = "cvak";

type ParsedApiKey = {
  keyId: string;
  secret: string;
};

function getApiKeyPepper() {
  return (
    process.env.API_KEY_PEPPER ||
    process.env.JWT_SECRET ||
    "clearvalue-local-api-key-pepper"
  );
}

export function hashApiKeySecret(secret: string) {
  return crypto
    .createHmac("sha256", getApiKeyPepper())
    .update(secret)
    .digest("hex");
}

export function parseApiKey(rawKey: string): ParsedApiKey | null {
  const key = rawKey.trim();
  const match = /^cvak_([a-f0-9]{16})_([A-Za-z0-9_-]{32,96})$/.exec(key);
  if (!match) return null;
  return { keyId: match[1], secret: match[2] };
}

export function secretHashesMatch(expectedHash: string, candidateHash: string) {
  const expected = Buffer.from(expectedHash, "hex");
  const candidate = Buffer.from(candidateHash, "hex");
  if (expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(expected, candidate);
}

export async function createApiKey(input: {
  name: string;
  createdBy: string;
}): Promise<{ apiKey: IApiKey; rawKey: string }> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("API key name is required");
  }
  if (name.length > 120) {
    throw new Error("API key name must be 120 characters or fewer");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const keyId = crypto.randomBytes(8).toString("hex");
    const secret = crypto.randomBytes(32).toString("base64url");
    const rawKey = `${API_KEY_PREFIX}_${keyId}_${secret}`;
    try {
      const apiKey = await ApiKey.create({
        name,
        keyId,
        secretHash: hashApiKeySecret(secret),
        last4: rawKey.slice(-4),
        createdBy: input.createdBy as any,
      });
      return { apiKey, rawKey };
    } catch (error: any) {
      if (error?.code !== 11000 || attempt === 2) {
        throw error;
      }
    }
  }

  throw new Error("Failed to generate API key");
}

import type cors from "cors";

/**
 * A typed edge-policy rejection lets the application return a controlled 403
 * without converting unrelated route errors into a new global response shape.
 */
export class CorsOriginDeniedError extends Error {
  constructor() {
    super("Origin is not allowed.");
    this.name = "CorsOriginDeniedError";
  }
}

export const allowedOrigins = [
  "https://www.assetinsightvaluator.com",
  "https://assetinsightvaluator.com",
  "https://admin.assetinsightvaluator.com",
  "https://admin.assetinsightvaluation.com",
  "http://localhost:3000",
  "http://localhost:3001",
];

/**
 * CORS is an API boundary policy. Exporting it from configuration keeps the
 * allow-list visible and prevents route modules from creating divergent rules.
 */
export const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new CorsOriginDeniedError());
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-File-Size",
    "X-Device-Key",
    "X-Activity-Source",
    "X-Activity-Id",
    "X-App-Version",
    "X-Device-Reinstall-Id",
    "X-Device-Platform",
    "X-Device-Form-Factor",
    "x-api-key",
    "x-apk-upload-token",
  ],
};

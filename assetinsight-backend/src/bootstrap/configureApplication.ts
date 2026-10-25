import cors from "cors";
import express, { type ErrorRequestHandler, type Express } from "express";
import path from "path";
import {
  CorsOriginDeniedError,
  corsOptions,
} from "../config/cors.config.js";
import { readHttpApplicationConfig } from "../config/http.config.js";
import { registerRoutes } from "../routes/registerRoutes.js";
import { reportActivityRequestContext } from "../utils/reportActivityContext.js";

/**
 * Composes infrastructure middleware and domain routers without opening a
 * network socket. Tests can import the configured application independently of
 * database and process lifecycle concerns.
 */
export function configureApplication(app: Express): Express {
  const httpConfig = readHttpApplicationConfig();

  // The API does not advertise its framework and returns baseline browser
  // protections even when a response is generated before domain routing.
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  if (httpConfig.trustedProxyHops !== undefined) {
    app.set("trust proxy", httpConfig.trustedProxyHops);
  }

  app.use((req, res, next) => {
    req.setTimeout(httpConfig.requestTimeoutMs);
    res.setTimeout(httpConfig.requestTimeoutMs);
    next();
  });

  app.use("/api/report-activity", express.json({ limit: "256kb" }));
  app.use(express.json({ limit: httpConfig.jsonBodyLimit }));
  app.use(
    express.urlencoded({
      extended: true,
      limit: httpConfig.urlencodedBodyLimit,
    })
  );

  // These relative paths intentionally resolve from the server working
  // directory; PM2 and the documented development commands set that directory.
  app.use(express.static("public"));
  app.use("/reports", express.static("reports"));
  app.use(
    "/uploads/drafts",
    express.static(path.resolve(process.cwd(), "uploads/drafts"))
  );
  app.use(
    "/uploads/report-drafts",
    express.static(path.resolve(process.cwd(), "uploads/report-drafts"))
  );

  app.use(cors(corsOptions));
  app.get("/api/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, service: "asset-insight-api" });
  });
  app.options("/{*corsPreflight}", cors(corsOptions));

  app.use(reportActivityRequestContext);
  registerRoutes(app);

  // CORS denials are an expected edge-policy result. Keep this handler
  // deliberately narrow so every other Express error retains its established
  // response behavior during this behavior-preserving hardening change.
  const corsErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if (!(error instanceof CorsOriginDeniedError)) return next(error);
    res.setHeader("Cache-Control", "no-store");
    return res.status(403).json({
      error: {
        code: "cors_origin_denied",
        message: error.message,
      },
    });
  };
  app.use(corsErrorHandler);
  return app;
}

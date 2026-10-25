export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 15 * 60_000;
export const MINIMUM_HTTP_REQUEST_TIMEOUT_MS = 60_000;

export type HttpApplicationConfig = {
  trustedProxyHops?: number;
  requestTimeoutMs: number;
  jsonBodyLimit: string;
  urlencodedBodyLimit: string;
};

/**
 * Reads the HTTP settings in one place while preserving the server's existing
 * defaults. Keeping this function side-effect free makes configuration changes
 * easy to review and test without booting Express.
 */
export function readHttpApplicationConfig(
  environment: NodeJS.ProcessEnv = process.env
): HttpApplicationConfig {
  const parsedTrustedProxyHops = Number.parseInt(
    environment.TRUST_PROXY_HOPS || "0",
    10
  );
  const trustedProxyHops =
    Number.isFinite(parsedTrustedProxyHops) && parsedTrustedProxyHops > 0
      ? parsedTrustedProxyHops
      : undefined;

  return {
    trustedProxyHops,
    requestTimeoutMs: Math.max(
      MINIMUM_HTTP_REQUEST_TIMEOUT_MS,
      Number(environment.HTTP_REQUEST_TIMEOUT_MS) ||
        DEFAULT_HTTP_REQUEST_TIMEOUT_MS
    ),
    jsonBodyLimit: environment.JSON_BODY_LIMIT || "25mb",
    urlencodedBodyLimit: environment.URLENCODED_BODY_LIMIT || "2mb",
  };
}

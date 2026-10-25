const DEFAULT_LISTEN_BACKLOG = 8192;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000;
const MINIMUM_REQUEST_TIMEOUT_MS = 60_000;

export type ApiServerConfig = {
  port: string | number;
  host: string;
  listenBacklog: number;
  requestTimeoutMs: number;
};

/** Reads API listener settings without starting infrastructure. */
export function readApiServerConfig(
  environment: NodeJS.ProcessEnv = process.env
): ApiServerConfig {
  const configuredListenBacklog = Number(environment.HTTP_LISTEN_BACKLOG);

  return {
    port: environment.PORT || 4000,
    host:
      environment.HOST ||
      (environment.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0"),
    listenBacklog:
      Number.isFinite(configuredListenBacklog) && configuredListenBacklog > 0
        ? Math.floor(configuredListenBacklog)
        : DEFAULT_LISTEN_BACKLOG,
    requestTimeoutMs: Math.max(
      MINIMUM_REQUEST_TIMEOUT_MS,
      Number(environment.HTTP_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS
    ),
  };
}

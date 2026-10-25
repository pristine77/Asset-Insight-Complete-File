import { describe, expect, it } from "vitest";
import { readApiServerConfig } from "../src/config/apiServer.config.js";
import {
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  MINIMUM_HTTP_REQUEST_TIMEOUT_MS,
  readHttpApplicationConfig,
} from "../src/config/http.config.js";

describe("HTTP application configuration", () => {
  it("keeps the established parser, body, and timeout defaults", () => {
    expect(readHttpApplicationConfig({})).toEqual({
      trustedProxyHops: undefined,
      requestTimeoutMs: DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
      jsonBodyLimit: "25mb",
      urlencodedBodyLimit: "2mb",
    });
  });

  it("applies overrides with the existing lower timeout bound", () => {
    expect(
      readHttpApplicationConfig({
        TRUST_PROXY_HOPS: "2",
        HTTP_REQUEST_TIMEOUT_MS: "1000",
        JSON_BODY_LIMIT: "10mb",
        URLENCODED_BODY_LIMIT: "1mb",
      })
    ).toEqual({
      trustedProxyHops: 2,
      requestTimeoutMs: MINIMUM_HTTP_REQUEST_TIMEOUT_MS,
      jsonBodyLimit: "10mb",
      urlencodedBodyLimit: "1mb",
    });
  });
});

describe("API listener configuration", () => {
  it("binds development to all interfaces with the established defaults", () => {
    expect(readApiServerConfig({ NODE_ENV: "development" })).toEqual({
      port: 4000,
      host: "0.0.0.0",
      listenBacklog: 8192,
      requestTimeoutMs: 15 * 60_000,
    });
  });

  it("binds production to loopback and normalizes numeric overrides", () => {
    expect(
      readApiServerConfig({
        NODE_ENV: "production",
        PORT: "4100",
        HTTP_LISTEN_BACKLOG: "1024.9",
        HTTP_REQUEST_TIMEOUT_MS: "30000",
      })
    ).toEqual({
      port: "4100",
      host: "127.0.0.1",
      listenBacklog: 1024,
      requestTimeoutMs: 60_000,
    });
  });
});

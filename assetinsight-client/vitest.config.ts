import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    {
      name: "vitest-css-module-stub",
      enforce: "pre",
      resolveId(id) {
        return id.endsWith(".module.css")
          ? "\0vitest-css-module-stub"
          : undefined;
      },
      load(id) {
        if (id !== "\0vitest-css-module-stub") return undefined;
        return `
          export default new Proxy({}, {
            get: (_target, property) =>
              typeof property === "string" ? property : undefined
          });
        `;
      },
    },
    react(),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: import.meta.dirname },
    ],
  },
  test: {
    environment: "jsdom",
    // Node 26 exposes process-level Web Storage globals. VM workers keep
    // jsdom's isolated localStorage/sessionStorage authoritative in tests.
    pool: "vmThreads",
    setupFiles: ["./tests/setup.ts"],
    // Rendering whole screens in jsdom while ~125 files run in parallel took
    // Salvage, Preview and Proposal Valuation tests past 5 s, then 15 s, on a
    // Windows laptop; each passed well inside that run alone (2026-10-28).
    testTimeout: 30_000,
    restoreMocks: true,
    css: false,
    exclude: [
      "e2e/**",
      "node_modules/**",
      ".next/**",
      ".playwright-output/**",
    ],
  },
});

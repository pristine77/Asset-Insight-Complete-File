import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function packageScripts(): Record<string, string> {
  const contents = fs.readFileSync(
    path.join(repositoryRoot, "package.json"),
    "utf8",
  );
  return JSON.parse(contents).scripts;
}

describe("production deployment command order", () => {
  it("quiesces every backend writer before index and report-claim migration work", () => {
    const scripts = packageScripts();
    expect(scripts["quiesce:backend"]).toBe("pm2 stop ecosystem.config.cjs");

    const deploy = scripts.deploy;
    const build = deploy.indexOf("npm run build");
    const quiesce = deploy.indexOf("npm run quiesce:backend");
    const indexes = deploy.indexOf("npm run ensure:auctioneer2-indexes");
    const migration = deploy.indexOf("npm run migrate:report-draft-indexes");
    const restart = deploy.indexOf(
      "pm2 startOrReload ecosystem.config.cjs --update-env",
    );

    expect(build).toBeGreaterThanOrEqual(0);
    expect(quiesce).toBeGreaterThan(build);
    expect(indexes).toBeGreaterThan(quiesce);
    expect(migration).toBeGreaterThan(indexes);
    expect(restart).toBeGreaterThan(migration);
  });
});

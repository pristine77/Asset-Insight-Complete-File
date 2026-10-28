import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// With every core rendering jsdom screens, a findBy or waitFor that needs well
// under a second alone overran the 1 s default on a Windows laptop (2026-10-28).
// A passing wait returns as soon as it succeeds; only a failing one waits longer.
configure({ asyncUtilTimeout: 5_000 });

afterEach(cleanup);

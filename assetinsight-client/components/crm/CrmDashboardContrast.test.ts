import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const themes = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const dashboard = readFileSync(resolve(process.cwd(), "components/crm/CrmDashboard.module.css"), "utf8");
const channelWeight = Number(dashboard.match(/\.dueColumn time\[data-overdue="true"\]\s*\{\s*color:\s*color-mix\(in srgb, var\(--app-danger\) (\d+)%, var\(--app-text-strong\)\)/)?.[1]) / 100;

function color(block: string, token: string) {
  const hex = block.match(new RegExp(`${token}:\\s*#([\\da-f]{6})`, "i"))?.[1];
  if (!hex) throw new Error(`Missing ${token} theme token`);
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}
function luminance(rgb: number[]) {
  const linear = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

describe("dashboard overdue text contrast policy", () => {
  it.each(["light", "dark"])("keeps 13px %s overdue dates readable at rest and when the row is hovered", (theme) => {
    const block = themes.match(theme === "light" ? /:root\s*\{([^}]+)\}/ : /\[data-theme="dark"\]\s*\{([^}]+)\}/)?.[1];
    if (!block) throw new Error(`Missing ${theme} theme`);
    expect(channelWeight).toBeGreaterThan(0);
    expect(channelWeight).toBeLessThanOrEqual(1);
    const danger = color(block, "--app-danger");
    const strong = color(block, "--app-text-strong");
    const foreground = luminance(danger.map((channel, index) => channel * channelWeight + strong[index] * (1 - channelWeight)));
    for (const token of ["--app-panel", "--app-accent-soft"]) {
      const background = luminance(color(block, token));
      const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      expect(contrast, `${theme} overdue date on ${token}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UXP panel version identity", () => {
  it("keeps the panel PANEL_VERSION constant in sync with manifest.json", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../uxp-plugin/manifest.json", import.meta.url), "utf8"),
    ) as { version: string };
    const panelSource = readFileSync(new URL("../../uxp-plugin/index.cjs", import.meta.url), "utf8");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(panelSource).toContain(`const PANEL_VERSION = "${manifest.version}"`);
  });

  it("ships the server build-info record inside the npm package", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { files: Array<string> };
    expect(pkg.files).toContain("dist/build-info.json");
  });
});

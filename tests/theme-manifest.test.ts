import { describe, expect, it } from "vitest";
import { minimalAssistantTheme } from "../packages/theme-minimal-assistant/src/manifest";
import { validateThemeManifest } from "../packages/theme-sdk/src/index";

describe("theme manifest", () => {
  it("accepts the bundled free theme", () => {
    expect(validateThemeManifest(minimalAssistantTheme)).toBe(true);
  });

  it("rejects unsafe IDs and empty scheme lists", () => {
    expect(validateThemeManifest({ ...minimalAssistantTheme, id: "Bad Theme", colorSchemes: [] })).toBe(false);
  });
});

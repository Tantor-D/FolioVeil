import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, migrateSettings } from "../packages/storage/src/index";

describe("settings migration", () => {
  it("returns safe defaults for unknown values", () => {
    expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(undefined).autoPrivacy).toBe(false);
  });

  it("defaults old preferences to Chinese and persists an explicit English choice", () => {
    expect(migrateSettings({ version: 2 }).displayLanguage).toBe('zh');
    expect(migrateSettings({ displayLanguage: 'en' }).displayLanguage).toBe('en');
    expect(migrateSettings({ displayLanguage: 'fr' }).displayLanguage).toBe('zh');
  });

  it("clamps numeric settings and refuses implicit enablement", () => {
    const result = migrateSettings({ fontSize: 100, lineHeight: 0, contentWidth: 1200, enabledSites: { weread: "yes" } });
    expect(result.fontSize).toBe(26);
    expect(result.lineHeight).toBe(1.4);
    expect(result.contentWidth).toBe(1000);
    expect(result.enabledSites.weread).toBe(false);
  });

  it("migrates old preferences without enabling a new source or exposing images", () => {
    const result = migrateSettings({ version: 1, enabledSites: { weread: true }, fontSize: 20 });
    expect(result.version).toBe(2);
    expect(result.enabledSites).toEqual({ weread: true, arxiv: false });
    expect(result.fontSize).toBe(20);
    expect(result.imageMode).toBe("hidden");
    expect(result.autoPrivacy).toBe(false);
    expect(result.disguiseTab).toBe(true);
  });

  it.each([true, false])("preserves the existing automatic privacy preference %s", autoPrivacy => {
    const migrated = migrateSettings({ version: 1, autoPrivacy });
    expect(migrated.autoPrivacy).toBe(autoPrivacy);
    expect(migrateSettings({ ...migrated, fontSize: 20 }).autoPrivacy).toBe(autoPrivacy);
  });

  it.each([{}, { version: 2 }, { autoPrivacy: undefined }, { autoPrivacy: null }, { autoPrivacy: "true" }])("keeps automatic privacy off without an explicit boolean choice: %j", stored => {
    expect(migrateSettings(stored).autoPrivacy).toBe(false);
  });

  it("only persists the allowlisted preferences, not content or temporary visibility", () => {
    const result = migrateSettings({ imageMode: "full", hotzoneDelay: -100, panelHideDelay: Infinity, panelOpen: true, privacy: false, document: { title: "private" }, sourceUrl: "https://example.test/private" });
    expect(result.imageMode).toBe("full");
    expect(result.hotzoneDelay).toBe(200);
    expect(result.panelHideDelay).toBe(500);
    expect(result).not.toHaveProperty("panelOpen");
    expect(result).not.toHaveProperty("privacy");
    expect(result).not.toHaveProperty("document");
    expect(result).not.toHaveProperty("sourceUrl");
  });
});

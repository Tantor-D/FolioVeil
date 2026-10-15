import { describe, expect, it } from "vitest";
import { createSafeLogEntry } from "../packages/core-runtime/src/safe-log";

describe("privacy-safe diagnostics", () => {
  it("drops details that could contain content or URLs", () => {
    const entry = createSafeLogEntry("weread", "0.1.0", "mount_failed", "https://weread.qq.com/book/secret title");
    expect(entry.detail).toBeUndefined();
    expect(entry).not.toHaveProperty("url");
  });

  it("keeps bounded machine-readable error codes", () => {
    expect(createSafeLogEntry("weread", "0.1.0", "health_failed", "surface_detached").detail).toBe("surface_detached");
  });
});

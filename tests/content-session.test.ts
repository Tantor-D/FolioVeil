import { describe, expect, it } from "vitest";
import type { ContentBatch, ContentBlock } from "../packages/content-model/src/index";
import { LocalContentSession } from "../packages/content-model/src/session";

const paragraph = (id: string): ContentBlock => ({ id, type: "paragraph", html: "A meaningful repeated statement." });
function batch(batchId: string, ids: string[], direction: "append" | "prepend" = "append", end = false): ContentBatch {
  return { documentId: "paper", batchId, blocks: ids.map(paragraph), direction, end };
}

describe("local content batches", () => {
  it("deduplicates batch and block identity while preserving repeated text", () => {
    const session = new LocalContentSession("paper");
    expect(session.applyBatch(batch("one", ["p1", "p2"])) ).toBe(true);
    expect(session.applyBatch(batch("one", ["p1", "p2"])) ).toBe(false);
    session.applyBatch(batch("two", ["p2", "p3", "p3"]));
    expect(session.getBlocks().map((block) => block.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("prepends in order without confusing document end or accepting another document", () => {
    const session = new LocalContentSession("paper");
    session.applyBatch(batch("last", ["p3", "p4"], "append", true));
    session.applyBatch(batch("first", ["p1", "p2"], "prepend", false));
    expect(session.getBlocks().map((block) => block.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(session.isAtEnd()).toBe(true);
    expect(() => session.applyBatch({ ...batch("foreign", ["p5"]), documentId: "another" })).toThrow("document_mismatch");
    expect(session.getBlocks()).toHaveLength(4);
    session.clear();
    expect(session.getBlocks()).toEqual([]);
    expect(session.isAtEnd()).toBe(false);
    expect(session.applyBatch(batch("first", ["p1"]))).toBe(true);
  });
});

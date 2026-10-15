import type { ContentBatch, ContentBlock } from "./index";

/** In-memory batches; IDs express identity, never equality of paragraph text. */
export class LocalContentSession {
  private blocks: ContentBlock[] = [];
  private readonly batchIds = new Set<string>();
  private readonly blockIds = new Set<string>();
  private atEnd = false;

  constructor(readonly documentId: string) {}

  applyBatch(batch: ContentBatch): boolean {
    if (batch.documentId !== this.documentId) throw new Error("document_mismatch");
    if (this.batchIds.has(batch.batchId)) return false;
    const incomingIds = new Set<string>();
    const incoming = batch.blocks.filter((block) => {
      if (this.blockIds.has(block.id) || incomingIds.has(block.id)) return false;
      incomingIds.add(block.id);
      return true;
    });
    for (const id of incomingIds) this.blockIds.add(id);
    this.blocks = batch.direction === "prepend" ? [...incoming, ...this.blocks] : [...this.blocks, ...incoming];
    this.batchIds.add(batch.batchId);
    if (batch.direction === "append") this.atEnd = batch.end;
    return true;
  }

  getBlocks(): readonly ContentBlock[] { return this.blocks; }
  isAtEnd(): boolean { return this.atEnd; }

  clear(): void {
    this.blocks = [];
    this.batchIds.clear();
    this.blockIds.clear();
    this.atEnd = false;
  }
}

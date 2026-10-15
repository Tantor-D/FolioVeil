/** Session-only, source-independent content. Never persist this contract. */
export interface BlockBase { id: string; sourceId?: string }
export type ContentBlock =
  | (BlockBase & { type: "paragraph" | "quote"; html: string })
  | (BlockBase & { type: "heading"; level: number; html: string })
  | (BlockBase & { type: "list"; ordered: boolean; items: string[] })
  | (BlockBase & { type: "code"; text: string })
  | (BlockBase & { type: "math"; html: string; text: string })
  | (BlockBase & { type: "table"; html: string; caption?: string; captionHtml?: string })
  | (BlockBase & { type: "image"; src?: string; label: string; caption: string; captionHtml?: string; resourceKind: "image" | "svg" | "canvas" | "background" | "formula"; unavailableReason?: string });
export type ImageBlock = Extract<ContentBlock, { type: "image" }>;
export interface ReaderDocument {
  id: string;
  title: string;
  source: { kind: "html" | "pdf" | "fixture"; url?: string; label?: string };
  blocks: ContentBlock[];
  toc: Array<{ id: string; label: string; level: number }>;
  warnings: string[];
}
export interface ContentBatch {
  documentId: string;
  batchId: string;
  blocks: ContentBlock[];
  direction: "append" | "prepend";
  end: boolean;
}

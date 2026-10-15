/** Original rendered document package. Deliberately unrelated to ThemeTemplate. */
export type CapturedBlockKind = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6' | 'orderedList' | 'unorderedList' | 'listItem' | 'quote' | 'code' | 'table' | 'image' | 'math';
export interface CapturedTemplateSpec {
  /** Unique selector in the captured document. Never inferred from a tag name. */
  selector: string;
  /** Relative to the cloned root; ':scope' means the root itself. */
  contentSelector: string;
  /** A supplementary captured branch stored inertly in an HTML template. */
  templateElement?: boolean;
}
export interface CapturedFrameManifest {
  format: 'folioveil-captured-document';
  formatVersion: 1;
  id: 'chatgpt';
  packageHash: string;
  document: { file: 'frame.html'; sha256: string; bytes: number };
  files: Array<{ file: string; sha256: string; bytes: number; kind: 'style' | 'font' | 'image' | 'document' }>;
  tabIcons?: { ico: string; svg: string };
  selectors: { scroller: string; messageFlow: string; sidebar: string; conversationList: string; composer: string };
  messages: { user: CapturedTemplateSpec; assistant: CapturedTemplateSpec; sidebarItem: CapturedTemplateSpec };
  blocks: Partial<Record<CapturedBlockKind, CapturedTemplateSpec>>;
  appearance?: Partial<Record<'light' | 'dark' | 'sidebar-collapsed' | 'sidebar-expanded' | 'narrow-dark-collapsed', { captureHash: string; patches: Array<{ selector: string; attributes: Record<string, string | null> }> }>>;
  codeAppearance?: { wrapperSelector: string; light: { rootClass: string; wrapperClass: string; theme: string }; dark: { rootClass: string; wrapperClass: string; theme: string } };
  evidence: { captureHash: string; state: string; capturedAt: string | null; viewport: { width: number; height: number; dpr: number }; missingTemplates: CapturedBlockKind[]; browserReplay: 'not-checked'; visualComparison: 'not-checked' };
  transformations: string[];
  substitutedUnusedAssets: Array<{ file: string; reason: string }>;
}
export interface CapturedClone { root: HTMLElement; content: HTMLElement }
export interface LoadedCapturedFrame { manifest: CapturedFrameManifest; html: string; packageURL: string }
export interface MountedCapturedFrame {
  readonly root: HTMLElement;
  readonly scroller: HTMLElement;
  readonly messageFlow: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly conversationList: HTMLElement;
  readonly composer: HTMLElement;
  readonly manifest: CapturedFrameManifest;
  cloneMessage(role: 'user' | 'assistant'): CapturedClone;
  cloneSidebarItem(): CapturedClone;
  supportsBlock(kind: CapturedBlockKind): boolean;
  cloneBlock(kind: CapturedBlockKind): CapturedClone;
  /** Returns unavailable states; does not invent uncollected appearance rules. */
  applyAppearance(value: { colorScheme: 'light' | 'dark'; sidebarCollapsed: boolean }): { missing: string[] };
  dispose(): void;
}

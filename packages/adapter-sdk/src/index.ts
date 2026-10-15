export type ReaderPageKind = "reader" | "library" | "login" | "unsupported";

export interface AdapterProbeResult {
  kind: ReaderPageKind;
  confidence: number;
  reason?: string;
}

export interface ReaderState {
  status: "ready" | "loading" | "signed-out" | "unsupported" | "error";
  bookTitle?: string;
  chapterTitle?: string;
  progressLabel?: string;
  errorCode?: string;
}

export interface ReaderCapabilities {
  nextPage: boolean;
  previousPage: boolean;
  tableOfContents: boolean;
  /** The adapter exposes the original control for direct user interaction. */
  tableOfContentsPresentation?: "native-control";
  textSelection: boolean;
  nativeAnnotations: boolean;
}

export type ReaderAction =
  | { type: "next-page" }
  | { type: "previous-page" }
  | { type: "open-toc" }
  | { type: "restore-native-view" };

export interface ActionResult {
  ok: boolean;
  reason?: "unsupported" | "not-found" | "failed";
}

export interface ContentSurface {
  mode: "native-overlay" | "mirrored-text";
  element: HTMLElement;
  /** Paginated/canvas renderers own their typography, colors and child coordinates. */
  layout?: "flow" | "native-paginated";
}

export interface AdapterHealth {
  healthy: boolean;
  code: "ok" | "surface-detached" | "surface-hidden" | "signed-out" | "unknown";
}

export interface AdapterContext {
  document: Document;
  location: Location;
}

export type ReaderStateListener = (state: ReaderState) => void;

export interface AdapterSession {
  getState(): Promise<ReaderState>;
  getContentSurface(): Promise<ContentSurface>;
  getCapabilities(): ReaderCapabilities;
  perform(action: ReaderAction): Promise<ActionResult>;
  subscribe(listener: ReaderStateListener): () => void;
  healthCheck(): Promise<AdapterHealth>;
  unmount(): Promise<void>;
}

export interface ReaderAdapter {
  readonly id: string;
  readonly version: string;
  matches(location: Location): boolean;
  probe(document: Document): Promise<AdapterProbeResult>;
  mount(context: AdapterContext): Promise<AdapterSession>;
}

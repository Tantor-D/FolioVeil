import type {
  ActionResult,
  AdapterContext,
  AdapterHealth,
  AdapterProbeResult,
  AdapterSession,
  ContentSurface,
  ReaderAction,
  ReaderAdapter,
  ReaderCapabilities,
  ReaderState,
  ReaderStateListener
} from "../../adapter-sdk/src/index";
import { findContentSurface, isPaginatedSurface, normalizedText, queryFirst, WEREAD_SELECTORS } from "./selectors";
import { NativeTableOfContents } from "./native-toc";

const MIN_CONTENT_TEXT = 80;

export class WeReadAdapter implements ReaderAdapter {
  readonly id = "weread";
  readonly version = "0.1.2";

  matches(location: Location): boolean {
    return location.protocol === "https:"
      && location.hostname === "weread.qq.com"
      && /^\/web\/reader(?:\/|$)/.test(location.pathname);
  }

  async probe(document: Document): Promise<AdapterProbeResult> {
    if (queryFirst(document, WEREAD_SELECTORS.login)) {
      return { kind: "login", confidence: 0.95, reason: "signed_out" };
    }

    const surface = findContentSurface(document);
    if (!surface) return { kind: "unsupported", confidence: 0, reason: "content_not_found" };

    // A rendered page may contain only canvas and interaction layers. Do not
    // infer readiness from book CSS or hidden pre-render text in that case.
    if (isPaginatedSurface(surface)) {
      const ready = !!surface.querySelector(".renderTargetContainer canvas, .renderTargetContainer .wr_canvasContainer");
      return { kind: ready ? "reader" : "unsupported", confidence: ready ? 0.95 : 0, reason: ready ? undefined : "renderer_not_ready" };
    }

    const textLength = surface.textContent?.replace(/\s/g, "").length ?? 0;
    const paragraphCount = surface.querySelectorAll("p").length;
    let confidence = 0.55;
    if (textLength >= MIN_CONTENT_TEXT) confidence += 0.25;
    if (paragraphCount >= 2) confidence += 0.1;
    if (queryFirst(document, WEREAD_SELECTORS.chapterTitle)) confidence += 0.1;

    return {
      kind: confidence >= 0.65 ? "reader" : "unsupported",
      confidence: Math.min(1, confidence),
      reason: confidence >= 0.65 ? undefined : "content_too_short"
    };
  }

  async mount(context: AdapterContext): Promise<AdapterSession> {
    const surface = findContentSurface(context.document);
    if (!surface) throw new Error("content_not_found");
    return new WeReadSession(context.document, surface);
  }
}

class WeReadSession implements AdapterSession {
  private readonly listeners = new Set<ReaderStateListener>();
  private readonly observer: MutationObserver;
  private stopped = false;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly nativeToc: NativeTableOfContents | undefined;

  constructor(private readonly document: Document, private readonly surface: HTMLElement) {
    if (isPaginatedSurface(surface)) this.nativeToc = NativeTableOfContents.mount(document, surface);
    this.observer = new MutationObserver(() => this.scheduleEmit());
    this.observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "aria-label"]
    });
  }

  async getState(): Promise<ReaderState> {
    if (queryFirst(this.document, WEREAD_SELECTORS.login)) return { status: "signed-out" };
    if (!this.surface.isConnected) return { status: "error", errorCode: "surface_detached" };
    return {
      status: "ready",
      bookTitle: normalizedText(queryFirst(this.document, WEREAD_SELECTORS.bookTitle)),
      chapterTitle: normalizedText(queryFirst(this.document, WEREAD_SELECTORS.chapterTitle)),
      progressLabel: normalizedText(queryFirst(this.document, WEREAD_SELECTORS.progress))
    };
  }

  async getContentSurface(): Promise<ContentSurface> {
    return { mode: "native-overlay", element: this.surface, layout: isPaginatedSurface(this.surface) ? "native-paginated" : "flow" };
  }

  getCapabilities(): ReaderCapabilities {
    return {
      nextPage: !!this.findActionTarget("next-page"),
      previousPage: !!this.findActionTarget("previous-page"),
      tableOfContents: !!this.findActionTarget("open-toc"),
      ...(this.nativeToc ? { tableOfContentsPresentation: "native-control" as const } : {}),
      textSelection: true,
      nativeAnnotations: true
    };
  }

  async perform(action: ReaderAction): Promise<ActionResult> {
    if (action.type === "restore-native-view") return { ok: true };
    // This reader requires direct interaction with its original TOC control.
    // Do not synthesize events or bypass its input checks.
    if (action.type === "open-toc" && this.nativeToc) return { ok: false, reason: "unsupported" };
    if (this.stopped) return { ok: false, reason: "not-found" };
    const target = this.findActionTarget(action.type);
    if (!target) return { ok: false, reason: "not-found" };
    try {
      target.click();
      return { ok: true };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }

  subscribe(listener: ReaderStateListener): () => void {
    this.listeners.add(listener);
    void this.getState().then(listener);
    return () => this.listeners.delete(listener);
  }

  async healthCheck(): Promise<AdapterHealth> {
    if (queryFirst(this.document, WEREAD_SELECTORS.login)) return { healthy: false, code: "signed-out" };
    if (!this.surface.isConnected) return { healthy: false, code: "surface-detached" };
    const style = getComputedStyle(this.surface);
    if (style.display === "none" || style.visibility === "hidden") {
      return { healthy: false, code: "surface-hidden" };
    }
    return { healthy: true, code: "ok" };
  }

  async unmount(): Promise<void> {
    this.stopped = true;
    this.observer.disconnect();
    this.nativeToc?.unmount();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.listeners.clear();
  }

  private scheduleEmit(): void {
    if (this.stopped || this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      void this.getState().then((state) => {
        for (const listener of this.listeners) listener(state);
      });
    }, 120);
  }

  private findActionTarget(action: Exclude<ReaderAction["type"], "restore-native-view">): HTMLElement | null {
    const selectorMap = {
      "next-page": WEREAD_SELECTORS.nextPage,
      "previous-page": WEREAD_SELECTORS.previousPage,
      "open-toc": WEREAD_SELECTORS.tableOfContents
    } as const;
    const selected = queryFirst<HTMLElement>(this.document, selectorMap[action]);
    if (selected) return selected;

    const labelMap = { "next-page": "下一页", "previous-page": "上一页", "open-toc": "目录" } as const;
    const expected = labelMap[action];
    return [...this.document.querySelectorAll<HTMLElement>("button, [role='button']")]
      .find((element) => `${element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""}`.includes(expected)) ?? null;
  }
}

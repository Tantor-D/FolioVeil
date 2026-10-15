// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlsController, type ControlsSurface } from "../packages/core-runtime/src/controls-controller";
import { DEFAULT_SETTINGS } from "../packages/storage/src/index";

describe("hidden controls lifecycle", () => {
  let surface: ControlsSurface;
  let controller: ControlsController;
  let privacy = false;
  let preview = false;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    privacy = false; preview = false;
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const scroller = document.createElement("main");
    const panel = document.createElement("section");
    panel.hidden = true;
    shadow.append(scroller, panel); document.documentElement.append(host);
    surface = {
      host, shadow, scroller, panel,
      togglePanel: vi.fn(() => { panel.hidden = !panel.hidden; }),
      closePanel: vi.fn(() => { panel.hidden = true; }),
      isPanelOpen: () => !panel.hidden,
      isPreviewOpen: () => preview,
      closePreview: vi.fn(() => { preview = false; }),
      navigate: vi.fn(), requestFetchMore: vi.fn(), getPrivacy: () => privacy,
      setPrivacy: vi.fn(value => { privacy = value; panel.hidden = true; preview = false; })
    };
    controller = new ControlsController(surface, structuredClone(DEFAULT_SETTINGS)); controller.mount();
  });
  afterEach(() => { controller.unmount(); surface.host.remove(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.useRealTimers(); });
  const pointer = (x: number, y: number, type = "pointermove") => window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
  const key = (code: string, ctrlKey = true) => window.dispatchEvent(new KeyboardEvent("keydown", { code, key: code === "Escape" ? "Escape" : "", ctrlKey, shiftKey: ctrlKey, bubbles: true, cancelable: true }));
  const next = (init: KeyboardEventInit = {}, target: EventTarget = surface.scroller, type = 'keydown') => target.dispatchEvent(new KeyboardEvent(type, { key: 'n', code: 'KeyN', bubbles: true, composed: true, cancelable: true, ...init }));

  it('loads with N independently of arrows and extension commands, once per release', () => {
    controller.unmount(); controller = new ControlsController(surface, { ...DEFAULT_SETTINGS, arrowNavigation: false }, { keyboardCommands: false }); controller.mount();
    next();
    for (let i = 0; i < 10; i++) next({ repeat: true });
    next(); // Also guard duplicate downs without a repeat flag.
    expect(surface.requestFetchMore).toHaveBeenCalledTimes(1);
    next({}, window, 'keyup'); next();
    expect(surface.requestFetchMore).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('blur')); next({ repeat: true });
    expect(surface.requestFetchMore).toHaveBeenCalledTimes(2);
  });

  it('does not load while editing, composing, using modifiers, viewing images or in privacy', () => {
    for (const html of ['<input>', '<textarea></textarea>', '<select></select>', '<div contenteditable><span>edit</span></div>', '<div contenteditable="plaintext-only"><span>edit</span></div>']) {
      const wrapper = document.createElement('div'); wrapper.innerHTML = html; surface.scroller.append(wrapper);
      next({}, wrapper.querySelector('span') ?? wrapper.firstElementChild!); next({}, window, 'keyup'); wrapper.remove();
    }
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) { next(init); next({}, window, 'keyup'); }
    privacy = true; next(); next({}, window, 'keyup'); privacy = false;
    preview = true; next(); next({}, window, 'keyup'); preview = false;
    const setting = document.createElement('button'); surface.panel.append(setting); controller.togglePanel(); setting.focus();
    next({}, setting); next({}, window, 'keyup'); controller.togglePanel(); setting.blur();
    expect(surface.requestFetchMore).not.toHaveBeenCalled();
    next(); expect(surface.requestFetchMore).toHaveBeenCalledOnce();
  });

  it("requires dwell, respects close-until-leave, and does not mount a transparent hit target", () => {
    const roots = document.documentElement.childElementCount;
    pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(300); pointer(200, 200); vi.advanceTimersByTime(1000);
    expect(surface.isPanelOpen()).toBe(false);
    pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(500); expect(surface.isPanelOpen()).toBe(true);
    controller.togglePanel(); pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(700); expect(surface.isPanelOpen()).toBe(false);
    pointer(200, 200); pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(500); expect(surface.isPanelOpen()).toBe(true);
    expect(document.documentElement.childElementCount).toBe(roots);
  });
  it("keeps privacy independent from opening controls and closes temporary surfaces on blur", () => {
    controller.updateSettings({ ...DEFAULT_SETTINGS, autoPrivacy: true });
    key("KeyO"); expect(surface.isPanelOpen()).toBe(true); expect(privacy).toBe(false);
    preview = true; window.dispatchEvent(new Event("blur"));
    expect(surface.isPanelOpen()).toBe(false); expect(preview).toBe(false); expect(privacy).toBe(true);
    window.dispatchEvent(new Event("focus")); expect(privacy).toBe(true);
    expect(surface.closePanel).toHaveBeenLastCalledWith(false);
    expect(surface.closePreview).toHaveBeenLastCalledWith(false);
    key("KeyO"); expect(surface.isPanelOpen()).toBe(true); expect(privacy).toBe(true);
    key("KeyP"); expect(privacy).toBe(false); expect(surface.isPanelOpen()).toBe(false);
  });
  it("keeps automatic privacy off by default while retaining explicit manual privacy", () => {
    key("KeyO"); preview = true;
    window.dispatchEvent(new Event("blur"));
    expect(surface.isPanelOpen()).toBe(false); expect(preview).toBe(false); expect(privacy).toBe(false);
    key("KeyP"); expect(privacy).toBe(true);
    window.dispatchEvent(new Event("focus")); expect(privacy).toBe(true);
    key("KeyP"); expect(privacy).toBe(false);
  });
  it("does not reveal during selection drag or image viewing; Escape closes preview first", () => {
    pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(200);
    pointer(window.innerWidth - 16, 20, "pointerdown"); pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(700);
    expect(surface.isPanelOpen()).toBe(false);
    pointer(200, 200, "pointerup"); preview = true;
    pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(700); expect(surface.isPanelOpen()).toBe(false);
    key("Escape", false); expect(preview).toBe(false); expect(surface.closePreview).toHaveBeenCalledWith(true);
  });
  it("leaves browser extension commands to the background listener when fallback is disabled", () => {
    controller.unmount(); controller = new ControlsController(surface, DEFAULT_SETTINGS, { keyboardCommands: false }); controller.mount();
    key("KeyO"); key("KeyP"); expect(surface.isPanelOpen()).toBe(false); expect(privacy).toBe(false);
  });

  it("suppresses dwell with a persistent text selection, including selection made during the delay", () => {
    const text = document.createElement("p"); text.textContent = "Selected reading text"; document.body.append(text);
    const selection = window.getSelection()!;
    const range = document.createRange(); range.selectNodeContents(text);
    selection.addRange(range);
    expect(selection.toString()).toBe("Selected reading text");
    pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(700);
    expect(surface.isPanelOpen()).toBe(false);
    selection.removeAllRanges(); pointer(200, 200);
    pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(300);
    selection.addRange(range); vi.advanceTimersByTime(400);
    expect(surface.isPanelOpen()).toBe(false);
    selection.removeAllRanges(); text.remove();
    pointer(200, 200); pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(500);
    expect(surface.isPanelOpen()).toBe(true);
  });

  it("also suppresses dwell when selection is reported only by the reading ShadowRoot", () => {
    Object.defineProperty(surface.shadow, "getSelection", { configurable: true, value: () => ({ toString: () => "Selected shadow text" }) });
    pointer(window.innerWidth - 16, 20); vi.advanceTimersByTime(700);
    expect(surface.isPanelOpen()).toBe(false);
  });

  it("keeps controls open while a setting has focus, including focus acquired during the hide delay", () => {
    const setting = document.createElement("input"); surface.panel.append(setting);
    controller.togglePanel(); setting.focus();
    expect(surface.shadow.activeElement).toBe(setting);
    pointer(200, 200); vi.advanceTimersByTime(700);
    expect(surface.isPanelOpen()).toBe(true);
    setting.blur(); pointer(200, 200); vi.advanceTimersByTime(300); setting.focus(); vi.advanceTimersByTime(400);
    expect(surface.isPanelOpen()).toBe(true);
    setting.blur(); pointer(200, 200); vi.advanceTimersByTime(500);
    expect(surface.isPanelOpen()).toBe(false);
  });

  it("leaves arrow keys untouched during image preview and resumes reading navigation after close", () => {
    preview = true;
    for (const name of ["ArrowLeft", "ArrowRight"]) {
      const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, composed: true });
      surface.scroller.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(surface.navigate).not.toHaveBeenCalled();
    preview = false;
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true, composed: true });
    surface.scroller.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(surface.navigate).toHaveBeenCalledExactlyOnceWith("next");
  });
});

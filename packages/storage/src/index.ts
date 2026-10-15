export type ColorScheme = "system" | "light" | "dark";
export type DisplayLanguage = "zh" | "en";

export type ImageMode = "hidden" | "thumbnail" | "full";
export type HotzoneCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left";

export interface SettingsV2 {
  version: 2;
  enabledSites: { weread: boolean; arxiv: boolean };
  colorScheme: ColorScheme;
  displayLanguage: DisplayLanguage;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  sidebarCollapsed: boolean;
  telemetryEnabled: boolean;
  imageMode: ImageMode;
  sessionName: string;
  disguiseTab: boolean;
  autoPrivacy: boolean;
  arrowNavigation: boolean;
  hotzoneEnabled: boolean;
  hotzoneCorner: HotzoneCorner;
  hotzoneDelay: number;
  panelHideDelay: number;
}

/** Historical modules compile against the current preference shape. */
export type SettingsV1 = SettingsV2;

export const DEFAULT_SETTINGS: SettingsV2 = {
  version: 2,
  enabledSites: { weread: false, arxiv: false },
  colorScheme: "light",
  displayLanguage: "zh",
  fontSize: 17,
  lineHeight: 1.75,
  contentWidth: 760,
  sidebarCollapsed: false,
  telemetryEnabled: false,
  imageMode: "hidden",
  sessionName: "项目方案讨论",
  disguiseTab: true,
  autoPrivacy: false,
  arrowNavigation: true,
  hotzoneEnabled: true,
  hotzoneCorner: "top-right",
  hotzoneDelay: 500,
  panelHideDelay: 500
};

export function displaySessionName(settings: SettingsV2): string {
  return settings.displayLanguage === 'en' && settings.sessionName === DEFAULT_SETTINGS.sessionName
    ? 'Project proposal' : settings.sessionName;
}

export function migrateSettings(value: unknown): SettingsV2 {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SETTINGS);
  const input = value as Partial<SettingsV2>;
  const scheme = ["system", "light", "dark"].includes(input.colorScheme ?? "")
    ? input.colorScheme as ColorScheme
    : DEFAULT_SETTINGS.colorScheme;
  return {
    version: 2,
    enabledSites: { weread: input.enabledSites?.weread === true, arxiv: input.enabledSites?.arxiv === true },
    colorScheme: scheme,
    displayLanguage: input.displayLanguage === "en" ? "en" : "zh",
    fontSize: clampNumber(input.fontSize, 14, 26, DEFAULT_SETTINGS.fontSize),
    lineHeight: clampNumber(input.lineHeight, 1.4, 2.2, DEFAULT_SETTINGS.lineHeight),
    contentWidth: clampNumber(input.contentWidth, 560, 1000, DEFAULT_SETTINGS.contentWidth),
    sidebarCollapsed: input.sidebarCollapsed === true,
    telemetryEnabled: input.telemetryEnabled === true,
    imageMode: ["hidden", "thumbnail", "full"].includes(input.imageMode ?? "") ? input.imageMode! : "hidden",
    sessionName: typeof input.sessionName === "string" && input.sessionName.trim() ? input.sessionName.trim().slice(0, 60) : DEFAULT_SETTINGS.sessionName,
    disguiseTab: input.disguiseTab !== false,
    autoPrivacy: input.autoPrivacy === true,
    arrowNavigation: input.arrowNavigation !== false,
    hotzoneEnabled: input.hotzoneEnabled !== false,
    hotzoneCorner: ["top-right", "top-left", "bottom-right", "bottom-left"].includes(input.hotzoneCorner ?? "") ? input.hotzoneCorner! : DEFAULT_SETTINGS.hotzoneCorner,
    hotzoneDelay: clampNumber(input.hotzoneDelay, 200, 2000, DEFAULT_SETTINGS.hotzoneDelay),
    panelHideDelay: clampNumber(input.panelHideDelay, 200, 2000, DEFAULT_SETTINGS.panelHideDelay)
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export async function loadSettings(): Promise<SettingsV2> {
  const result = await chrome.storage.local.get("settings");
  return migrateSettings(result.settings);
}

export async function saveSettings(settings: SettingsV2): Promise<void> {
  await chrome.storage.local.set({ settings: migrateSettings(settings) });
}

export interface TxtPosition { fingerprint: string; encoding: string; rules: string; sectionLength: number; unitId: string; sequence: number; start: number }
const txtKey = (fingerprint: string) => `txt-position:${fingerprint}`;
export async function loadTxtPosition(fingerprint: string): Promise<TxtPosition | undefined> {
  const value = (await chrome.storage.local.get(txtKey(fingerprint)))[txtKey(fingerprint)];
  return value && value.fingerprint === fingerprint && Number.isSafeInteger(value.sequence) && typeof value.unitId === 'string' ? value as TxtPosition : undefined;
}
export async function saveTxtPosition(value: TxtPosition): Promise<void> {
  await chrome.storage.local.set({ [txtKey(value.fingerprint)]: value });
}

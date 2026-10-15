import { message } from "../../../packages/i18n/src/index";
import { DEFAULT_SETTINGS, loadSettings, migrateSettings, saveSettings } from "../../../packages/storage/src/index";

const fields = ["colorScheme", "displayLanguage", "fontSize", "lineHeight", "contentWidth", "imageMode", "sessionName", "sidebarCollapsed", "hotzoneEnabled", "hotzoneCorner", "hotzoneDelay", "panelHideDelay", "arrowNavigation", "autoPrivacy"] as const;
const numeric = new Set<string>(["fontSize", "lineHeight", "contentWidth", "hotzoneDelay", "panelHideDelay"]);
const boolean = new Set<string>(["sidebarCollapsed", "hotzoneEnabled", "arrowNavigation", "autoPrivacy"]);
const saved = document.querySelector<HTMLElement>("#saved")!;
let settings = structuredClone(DEFAULT_SETTINGS);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const field = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
void initialize();

async function initialize(): Promise<void> {
  settings = await loadSettings();
  for (const key of fields) {
    if (boolean.has(key)) (field(key) as HTMLInputElement).checked = settings[key] as boolean;
    else field(key).value = String(settings[key]);
  }
  updateOutputs();
  const commands = await chrome.commands.getAll();
  document.querySelector("#commandBindings")!.textContent = commands.filter(command => command.name?.startsWith("toggle-")).map(command => `${command.name === "toggle-controls" ? "操作面板" : "快速隐私"}：${command.shortcut || "尚未分配，请设置"}`).join("；");
}
for (const key of fields) field(key).addEventListener("input", () => {
  const next: Record<string, unknown> = { ...settings };
  for (const name of fields) next[name] = boolean.has(name) ? (field(name) as HTMLInputElement).checked : numeric.has(name) ? Number(field(name).value) : field(name).value;
  settings = migrateSettings(next);
  updateOutputs();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSettings(settings).then(() => showSaved()), 180);
});
document.querySelector("#editCommands")!.addEventListener("click", () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
document.querySelector("#exportLogs")!.addEventListener("click", async () => {
  const { safeLogs = [] } = await chrome.storage.local.get("safeLogs");
  const blob = new Blob([JSON.stringify({ schemaVersion: 1, events: safeLogs }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `folioveil-local-log-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); URL.revokeObjectURL(link.href);
});
document.querySelector("#clearData")!.addEventListener("click", async () => {
  if (saveTimer) clearTimeout(saveTimer);
  await chrome.storage.local.clear(); await saveSettings(structuredClone(DEFAULT_SETTINGS)); await initialize(); showSaved(message("localDataCleared"));
});
function updateOutputs(): void {
  for (const key of ["fontSize", "lineHeight", "contentWidth"]) (document.getElementById(`${key}Output`) as HTMLOutputElement).value = `${field(key).value}${key === "lineHeight" ? "" : "px"}`;
}
function showSaved(text = message("settingsSaved")): void { saved.textContent = text; setTimeout(() => { saved.textContent = ""; }, 1800); }

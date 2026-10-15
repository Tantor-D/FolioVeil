export type SafeEventCode =
  | "mount_succeeded"
  | "mount_skipped"
  | "mount_failed"
  | "health_failed"
  | "restored"
  | "privacy_toggled";

export interface SafeLogEntry {
  at: string;
  adapterId: string;
  adapterVersion: string;
  code: SafeEventCode;
  detail?: string;
}

const ALLOWED_DETAIL = /^[a-z0-9_-]{1,64}$/i;

export function createSafeLogEntry(
  adapterId: string,
  adapterVersion: string,
  code: SafeEventCode,
  detail?: string
): SafeLogEntry {
  return {
    at: new Date().toISOString(),
    adapterId: adapterId.replace(/[^a-z0-9_-]/gi, "").slice(0, 32),
    adapterVersion: adapterVersion.replace(/[^0-9.]/g, "").slice(0, 16),
    code,
    ...(detail && ALLOWED_DETAIL.test(detail) ? { detail } : {})
  };
}

export async function appendSafeLog(entry: SafeLogEntry): Promise<void> {
  const result = await chrome.storage.local.get("safeLogs");
  const logs = Array.isArray(result.safeLogs) ? result.safeLogs.slice(-99) : [];
  logs.push(entry);
  await chrome.storage.local.set({ safeLogs: logs });
}

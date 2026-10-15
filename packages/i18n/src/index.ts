const FALLBACK: Record<string, string> = {
  appName: "FolioVeil",
  assistantName: "Reading workspace",
  untitledBook: "Current reading",
  untitledChapter: "Reading session",
  restoreNative: "Restore original page",
  privacyMode: "Privacy scene",
  exitPrivacy: "Return to reading",
  previousPage: "Previous page",
  nextPage: "Next page",
  tableOfContents: "Contents",
  statusReady: "Original reading controls remain active",
  decorativeComposer: "Ask about this reading (coming later)",
  privacyHeading: "Weekly planning notes",
  privacyBody: "Review open items, confirm priorities, and prepare the next project update.",
  adapterFailed: "FolioVeil could not safely adapt this page. The original page has been restored.",
  adapterWaiting: "Open a supported WeRead reading page and wait for the chapter to load."
};

export function message(key: string): string {
  try {
    return chrome.i18n.getMessage(key) || FALLBACK[key] || key;
  } catch {
    return FALLBACK[key] || key;
  }
}

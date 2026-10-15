export type ThemeSlot = "header" | "sidebar" | "message" | "composer" | "statusbar";

export interface ThemeTokens {
  background: string;
  surface: string;
  sidebar: string;
  text: string;
  mutedText: string;
  border: string;
  accent: string;
  shadow: string;
}

export interface ThemeManifest {
  schemaVersion: 1;
  id: string;
  displayNameKey: string;
  version: string;
  entitlement: "free" | "pro";
  shell: "chat" | "terminal" | "document" | "team";
  colorSchemes: Array<"light" | "dark">;
  supportedSlots: ThemeSlot[];
  componentVariants: {
    header: string;
    sidebar: string;
    message: string;
    composer: string;
    statusbar?: string;
  };
  tokens: Record<"light" | "dark", ThemeTokens>;
  assets: Record<string, string>;
}

const THEME_SLOTS = new Set<ThemeSlot>(["header", "sidebar", "message", "composer", "statusbar"]);

export function validateThemeManifest(value: unknown): value is ThemeManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<ThemeManifest>;
  return manifest.schemaVersion === 1
    && typeof manifest.id === "string"
    && /^[a-z0-9-]+$/.test(manifest.id)
    && typeof manifest.displayNameKey === "string"
    && typeof manifest.version === "string"
    && (manifest.entitlement === "free" || manifest.entitlement === "pro")
    && ["chat", "terminal", "document", "team"].includes(manifest.shell ?? "")
    && Array.isArray(manifest.colorSchemes)
    && manifest.colorSchemes.length > 0
    && manifest.colorSchemes.every((scheme) => scheme === "light" || scheme === "dark")
    && Array.isArray(manifest.supportedSlots)
    && manifest.supportedSlots.every((slot) => THEME_SLOTS.has(slot))
    && !!manifest.componentVariants
    && !!manifest.tokens
    && typeof manifest.assets === "object";
}

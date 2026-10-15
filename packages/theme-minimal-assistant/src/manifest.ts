import type { ThemeManifest } from "../../theme-sdk/src/index";

export const minimalAssistantTheme: ThemeManifest = {
  schemaVersion: 1,
  id: "minimal-assistant",
  displayNameKey: "themeMinimalAssistant",
  version: "1.0.0",
  entitlement: "free",
  shell: "chat",
  colorSchemes: ["light", "dark"],
  supportedSlots: ["header", "sidebar", "message", "composer", "statusbar"],
  componentVariants: {
    header: "quiet",
    sidebar: "compact",
    message: "document",
    composer: "pill",
    statusbar: "minimal"
  },
  tokens: {
    light: {
      background: "#f7f7f8",
      surface: "#ffffff",
      sidebar: "#f1f1f3",
      text: "#242426",
      mutedText: "#73737a",
      border: "#dedee3",
      accent: "#386b5f",
      shadow: "0 12px 42px rgba(30, 30, 35, 0.10)"
    },
    dark: {
      background: "#202123",
      surface: "#2b2c2f",
      sidebar: "#18191b",
      text: "#ececf1",
      mutedText: "#a9a9b2",
      border: "#414247",
      accent: "#72a89a",
      shadow: "0 12px 42px rgba(0, 0, 0, 0.28)"
    }
  },
  assets: {}
};

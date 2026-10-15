/** Source-free contract: selectors identify generated local nodes, never websites. */
export type ThemeSlot = 'shell' | 'sidebar' | 'header' | 'scroller' | 'conversationList' | 'userMessage' | 'assistantMessage' | 'composer';
export type ThemeAction = 'toggleSidebar' | 'newConversation' | 'previous' | 'next' | 'privacy' | 'showControls' | 'returnSource';
export interface ThemeMeasurement {
  rect: Partial<Record<'x' | 'y' | 'width' | 'height', number>>;
  css: Record<string, string>;
}
export interface ThemeTemplate {
  html: string;
  css: string;
  slots: Partial<Record<ThemeSlot, { selector: string; cardinality: 1 }>>;
  icons: Record<string, string>;
  manifest: {
    schemaVersion: 1;
    id: string;
    status: 'candidate' | 'approved';
    runtimeReady: boolean;
    source: {
      origin: string;
      state: string;
      viewport: { width: number; height: number };
      environment: { devicePixelRatio: number | null; zoom: number | null; language: string; fontsReady: boolean };
      capturedAt: string | null;
    };
    evidence: { capture: 'rendered-dom' | 'synthetic' | 'unverified'; generated: boolean; realConversation: boolean; visualComparison: 'missing' | 'passed' | 'failed' };
    missing: string[];
    omissions: string[];
    contentHash: string;
    measurements: Partial<Record<ThemeSlot, ThemeMeasurement>>;
    assets: string[];
  };
}

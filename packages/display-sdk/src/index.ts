import type { ReaderView } from '../../reader-runtime/src/workspace';
import type { ControlsSurface } from '../../core-runtime/src/controls-controller';
import type { SettingsV2 } from '../../storage/src/index';
export interface DisplayCallbacks {
  onSettings(patch: Partial<SettingsV2>): void;
  onRestore(): void;
  onRetry?(): void;
  onPrivacyChange?(active: boolean): void;
  onNavigate?(direction: 'previous' | 'next'): void;
  onFetchMore?(): void;
  onReloadSource?(): void;
  onLocateSource?(): void;
  onChooseFile?(): void;
  onReDecode?(): void;
  onSelectUnit?(id: string): void;
}
export interface ReaderDisplay extends ReaderView, ControlsSurface {
  mount(): void;
  updateSettings(settings: SettingsV2): void;
  unmount(): void;
}
/** A different skin may implement its own DOM; the runtime only uses this interface. */
export interface DisplayAdapter {
  id: string;
  version: string;
  create(settings: SettingsV2, callbacks: DisplayCallbacks): ReaderDisplay;
}

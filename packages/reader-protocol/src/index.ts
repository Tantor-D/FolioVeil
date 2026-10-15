import type { ReaderDocument } from '../../content-model/src/index';
/** JSON-only boundary: no DOM nodes, source selectors or UI classes. */
export const PROTOCOL = 'folioveil/2' as const;
export const RUNTIME_VERSION = '1.0.0' as const;
/** Optional navigation metadata; it never enters the ordered body stream. */
export interface ReadingUnit { id: string; sequence: number; title: string; hasNext: boolean }
export interface UnitReadCursor { sessionId: string; batchSequence: number; itemSequence: number; current: number }
export interface UnitNavigationSource {
  readonly units: readonly ReadingUnit[];
  readonly currentIndex: number;
  checkpoint(): UnitReadCursor;
  restore(cursor: UnitReadCursor): void;
  read(unitId: string, requestId: string): import('../../content-model/src/stream').StreamBatch;
}
declare const __FOLIOVEIL_BUILD_ID__: string | undefined;
/** Public code fingerprint only. Never contains source/reader data. */
export const RUNTIME_BUILD = typeof __FOLIOVEIL_BUILD_ID__ === 'string' ? __FOLIOVEIL_BUILD_ID__ : 'development';
export type Navigation = 'previous-page' | 'next-page';
/** Content coordinates survive reflow. They are session-only, never telemetry. */
export interface ContentAnchor { documentId: string; blockId: string; offset: number }
export interface ViewAnchor extends ContentAnchor { viewportOffset: number }
/** Only publish a range established from the source's normal rendered DOM. */
export interface SourcePageRange { start: ContentAnchor; end: ContentAnchor; signature: string; evidence: 'dom-range' }
export interface ContentEvidence { chapterIdentity: string; signature: string; completeness: 'unknown' | 'confirmed' }
export interface ReadingPosition { documentId: string; chapter: string; page: string; key: string }
export interface SourceSnapshot {
  epoch: string; revision: number;
  status: 'loading' | 'ready' | 'unavailable';
  position: ReadingPosition;
  capabilities: Record<Navigation, boolean>;
  document?: ReaderDocument;
  pageRange?: SourcePageRange;
  contentEvidence?: ContentEvidence;
  operationState?: 'idle' | 'pending' | 'uncertain';
}
export type OperationFailure = 'busy' | 'unsupported' | 'not-confirmed' | 'input-unavailable' | 'source-unavailable' | 'stale-position' | 'reconciliation-required';
export interface OperationResult { requestId: string; ok: boolean; reason?: OperationFailure; snapshot: SourceSnapshot }
export interface SourceAdapter {
  readonly id: string;
  start(): void;
  read(): Promise<SourceSnapshot>;
  snapshot(): SourceSnapshot;
  perform(action: Navigation, requestId: string, expectedPosition: string, expectedEpoch?: string): Promise<OperationResult>;
  subscribe(listener: (snapshot: SourceSnapshot) => void): () => void;
  stop(): void;
}
export interface SessionBinding { id: string; sourceTabId: number; readerTabId?: number; state?: 'connected' | 'loading' | 'disconnected' }
export type ReaderRequest = { build?: string } & (
  | { protocol: typeof PROTOCOL; type: 'read-guidance'; sessionId: string }
  | { protocol: typeof PROTOCOL; type: 'fetch-batch'; sessionId: string; requestId: string; initial: boolean }
  | { protocol: typeof PROTOCOL; type: 'read-resource'; sessionId: string; resourceId: string }
  | { protocol: typeof PROTOCOL; type: 'open'; sourceTabId: number }
  | { protocol: typeof PROTOCOL; type: 'list-reconnectable'; sourceTabId: number }
  | { protocol: typeof PROTOCOL; type: 'reconnect'; sourceTabId: number; sessionId: string }
  | { protocol: typeof PROTOCOL; type: 'control-reader'; readerTabId: number; action: 'privacy' | 'controls' }
  | { protocol: typeof PROTOCOL; type: 'read' | 'return-source' | 'reload-source'; sessionId: string }
  | { protocol: typeof PROTOCOL; type: 'navigate'; sessionId: string; action: Navigation; requestId: string; expectedPosition: string; expectedEpoch?: string });
export type SourceRequest =
  | { protocol: typeof PROTOCOL; type: 'source-read-guidance'; expectedEpoch: string }
  | { protocol: typeof PROTOCOL; type: 'source-fetch-batch'; sessionId: string; requestId: string; initial: boolean; expectedEpoch: string }
  | { protocol: typeof PROTOCOL; type: 'source-resolve-resource'; sessionId: string; resourceId: string; expectedEpoch: string }
  | { protocol: typeof PROTOCOL; type: 'source-ping' }
  | { protocol: typeof PROTOCOL; type: 'source-read'; expectedEpoch?: string }
  | { protocol: typeof PROTOCOL; type: 'source-navigate'; action: Navigation; requestId: string; expectedPosition: string; expectedEpoch?: string };
/** Transient input request from the bound top-frame source. No DOM or body data. */
export interface SourceInputRequest {
  protocol: typeof PROTOCOL; type: 'source-input'; build: string;
  phase: 'catalog' | 'chapter' | 'batch-chapter'; requestId: string; expectedPosition: string; expectedEpoch: string; route: string;
  x: number; y: number; viewportWidth: number; viewportHeight: number;
}
export type ReaderEvent = { build: string } & (
  | { protocol: typeof PROTOCOL; type: 'snapshot'; sessionId: string; snapshot: SourceSnapshot }
  | { protocol: typeof PROTOCOL; type: 'disconnected'; sessionId: string; reason?: string }
  | { protocol: typeof PROTOCOL; type: 'source-loading' | 'reconnected'; sessionId: string }
  | { protocol: typeof PROTOCOL; type: 'control'; readerTabId: number; action: 'privacy' | 'controls' });
export function isNavigation(value: unknown): value is Navigation { return value === 'previous-page' || value === 'next-page'; }
export function isProtocolMessage(value: unknown): value is { protocol: typeof PROTOCOL; type: string } {
  return !!value && typeof value === 'object' && 'protocol' in value && value.protocol === PROTOCOL && 'type' in value && typeof value.type === 'string';
}

/** Bounded local scheduling; never carries reading content. */
export interface SourceWaitRequest {
  protocol: typeof PROTOCOL; type: 'source-wait'; build: string; milliseconds: number;
}

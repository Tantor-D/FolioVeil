import { extractArxivDocument } from '../../../packages/adapter-arxiv/src/index';
import { DEFAULT_SETTINGS, displaySessionName, migrateSettings } from '../../../packages/storage/src/index';
import { createCapturedChatGPTDisplayAdapter } from '../../../packages/theme-chatgpt/src/index';
import { loadCapturedFrame } from '../../../packages/theme-chatgpt/src/captured-frame';
import { ControlsController } from '../../../packages/core-runtime/src/controls-controller';
import { ReaderWorkspace } from '../../../packages/reader-runtime/src/workspace';
import type { SourceSnapshot } from '../../../packages/reader-protocol/src/index';
import type { ReaderDocument } from '../../../packages/content-model/src/index';
async function start(): Promise<void> {
  let settings = structuredClone(DEFAULT_SETTINGS);
  try { settings = migrateSettings(JSON.parse(localStorage.getItem('folioveil-preview-settings') ?? 'null')); } catch { /* preferences only */ }
  const params = new URLSearchParams(location.search);
  if (params.get('scheme') === 'dark') settings = migrateSettings({ ...settings, colorScheme: 'dark' });
  if (params.get('scheme') === 'light') settings = migrateSettings({ ...settings, colorScheme: 'light' });
  if (params.get('lang') === 'en' || params.get('lang') === 'zh') settings = migrateSettings({ ...settings, displayLanguage: params.get('lang') });
  if (params.get('sidebar') === 'collapsed') settings = migrateSettings({ ...settings, sidebarCollapsed: true });
  if (params.get('sidebar') === 'expanded') settings = migrateSettings({ ...settings, sidebarCollapsed: false });
  if (params.get('image') === 'full') settings = migrateSettings({ ...settings, imageMode: 'full' });
  const neutral = params.get('fixture') === 'chatgpt-neutral';
  const response = await fetch(neutral ? 'chatgpt-neutral-reader.json' : 'paper-sample.html');
  if (!response.ok) throw new Error('fixture-unavailable');
  const body = await response.text();
  const content: ReaderDocument = neutral ? JSON.parse(body) as ReaderDocument : extractArxivDocument(new DOMParser().parseFromString(body, 'text/html'), location.href);
  let page = 1;
  const snapshot = (): SourceSnapshot => ({ epoch: 'synthetic-preview', revision: page, status: 'ready', position: { documentId: content.id, chapter: content.title, page: String(page), key: String(page) }, capabilities: { 'previous-page': false, 'next-page': false }, document: content });
  let controls: ControlsController, workspace: ReaderWorkspace;
  const frame = await loadCapturedFrame();
  const shell = createCapturedChatGPTDisplayAdapter(frame).create(settings, {
    onSettings(patch) { settings = migrateSettings({ ...settings, ...patch }); localStorage.setItem('folioveil-preview-settings', JSON.stringify(settings)); controls.updateSettings(settings); },
    onRestore() { location.href = 'paper-sample.html'; },
    onRetry() { void workspace.connect(); },
    onNavigate(direction) { void workspace.navigate(direction === 'next' ? 'next-page' : 'previous-page'); },
    onLocateSource() { workspace.locateSource(); }
  });
  workspace = new ReaderWorkspace({ read: async () => snapshot(), navigate: async (action, requestId) => { page += action === 'next-page' ? 1 : -1; return { requestId, ok: true, snapshot: snapshot() }; } }, shell);
  shell.mount(); document.title = displaySessionName(settings);
  controls = new ControlsController(shell, settings); controls.mount(); await workspace.connect();
}
void start().catch(() => { document.body.textContent = '暂时无法加载样板，请刷新后重试。'; });

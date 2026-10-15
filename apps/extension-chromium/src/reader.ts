import { PROTOCOL, RUNTIME_BUILD, isProtocolMessage, type ReaderEvent, type ReaderRequest } from '../../../packages/reader-protocol/src/index';
import { BatchWorkspace } from '../../../packages/reader-runtime/src/batch-workspace';
import { createCapturedChatGPTDisplayAdapter } from '../../../packages/theme-chatgpt/src/index';
import { loadCapturedFrame } from '../../../packages/theme-chatgpt/src/captured-frame';
import { ControlsController } from '../../../packages/core-runtime/src/controls-controller';
import { displaySessionName, loadSettings, migrateSettings, saveSettings } from '../../../packages/storage/src/index';
import { loadTxtPosition, saveTxtPosition } from '../../../packages/storage/src/index';
import { decodeTxt, SECTION_LENGTH, TXT_RULE_VERSION, TxtSource, type TxtEncoding } from '../../../packages/adapter-txt/src/index';
import { UnitWorkspace } from '../../../packages/reader-runtime/src/unit-workspace';
import type { ChatReaderShell } from '../../../packages/reader-view/src/chat-shell';

type RequestInput<T = ReaderRequest> = T extends ReaderRequest ? Omit<T, 'protocol'> : never;
async function start(): Promise<void> {
  if (new URL(location.href).searchParams.get('mode') === 'txt') return startTxt();
  const sessionId = new URL(location.href).searchParams.get('session');
  if (!sessionId) throw new Error('missing-session');
  let settings = await loadSettings();
  const frame = await loadCapturedFrame(chrome.runtime.getURL('themes/chatgpt/'));
  const currentTab = await chrome.tabs.getCurrent();
  let incompatibleWorker = false;
  const send = async (request: RequestInput) => {
    if (incompatibleWorker) throw new Error('reader-build-mismatch');
    const result = await chrome.runtime.sendMessage({ protocol: PROTOCOL, ...request, build: RUNTIME_BUILD });
    if (incompatibleWorker) throw new Error('reader-build-mismatch');
    if (!result || result.error) throw new Error(result?.error ?? 'source-unavailable');
    return result;
  };
  let workspace: BatchWorkspace;
  let controls: ControlsController;
  const shell = createCapturedChatGPTDisplayAdapter(frame).create(settings, {
    onSettings(patch) { settings = migrateSettings({ ...settings, ...patch }); controls.updateSettings(settings); document.title = displaySessionName(settings); void saveSettings(settings); },
    onRestore() { shell.setPrivacy(true); void send({ type: 'return-source', sessionId }).catch(() => shell.setNotice('原页面不可用，请重新打开阅读网站。')); },
    onRetry() { void workspace.connect(); },
    onFetchMore() { void workspace.fetch(); },
    onReloadSource() { workspace.sourceLoading(); void send({ type: 'reload-source', sessionId }).catch(() => workspace.disconnect()); },
    // Chapter navigation replaces the displayed body directly; no source-page
    // location control is exposed in this release.
  }) as ChatReaderShell;
  shell.mount(); document.querySelector('#boot')?.remove(); document.title = displaySessionName(settings);
  workspace = new BatchWorkspace(sessionId, {
    guidance: () => send({ type: 'read-guidance', sessionId }),
    fetch: (requestId, initial) => send({ type: 'fetch-batch', sessionId, requestId, initial }),
    resource: resourceId => send({ type: 'read-resource', sessionId, resourceId })
  }, shell);
  // Privacy observes this workspace, never the intentionally-background source tab.
  controls = new ControlsController(shell, settings, { keyboardCommands: false }); controls.mount();
  chrome.runtime.onMessage.addListener((value, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url === chrome.runtime.getURL('popup.html') || !isProtocolMessage(value)) return;
    const event = value as ReaderEvent;
    const targetsSession = ['snapshot', 'disconnected', 'source-loading', 'reconnected'].includes(event.type) && 'sessionId' in event && event.sessionId === sessionId;
    const targetsControl = event.type === 'control' && event.readerTabId === currentTab?.id;
    if (!targetsSession && !targetsControl || incompatibleWorker) return;
    if (event.build !== RUNTIME_BUILD) {
      // Clear any displayed body and invalidate pending read/navigation work.
      // This page must be reopened before accepting another worker instance.
      incompatibleWorker = true; workspace.disconnect();
      shell.setStatus('error', '扩展与页面版本不一致。请重新加载扩展、刷新来源，并重新打开独立阅读页。');
      return;
    }
    // Source snapshots are observations, never unsolicited additions to the stream.
    if (event.type === 'disconnected' && event.sessionId === sessionId) workspace.disconnect();
    if (event.type === 'source-loading' && event.sessionId === sessionId) workspace.sourceLoading();
    if (event.type === 'reconnected' && event.sessionId === sessionId) void workspace.connect();
    if (event.type === 'control' && event.readerTabId === currentTab?.id) {
      if (event.action === 'privacy') shell.setPrivacy(!shell.getPrivacy()); else controls.togglePanel();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) { settings = migrateSettings(changes.settings.newValue); shell.updateSettings(settings); controls.updateSettings(settings); document.title = displaySessionName(settings); }
  });
  window.addEventListener('pagehide', event => {
    shell.setPrivacy(true);
    if (!event.persisted) { controls.unmount(); workspace.disconnect(); shell.unmount(); }
  });
  await workspace.connect();
}
async function startTxt(): Promise<void> {
  let settings = await loadSettings();
  const frame = await loadCapturedFrame(chrome.runtime.getURL('themes/chatgpt/'));
  const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.txt,text/plain'; picker.hidden = true; document.body.append(picker);
  let selectedFile: File | undefined, selectedBytes: ArrayBuffer | undefined;
  const fingerprints = new WeakMap<TxtSource, string>();
  let importGeneration = 0;
  const choose = () => { picker.value = ''; picker.click(); };
  let controls: ControlsController;
  const showEncodingOptions = () => {
    if (!selectedFile) return;
    shell.closePanel();
    shell.setLocalPrompt('选择文件编码并重新读取；当前正文会保留到目标成功显示。', (['utf-8', 'utf-16le', 'utf-16be', 'gb18030'] as const).map(encoding =>
      ({ label: encoding.toUpperCase(), run: () => { void importFile(selectedFile!, encoding); } })).concat([{ label: '取消', run: () => shell.clearLocalPrompt() }]));
  };
  const shell = createCapturedChatGPTDisplayAdapter(frame).create(settings, {
    onSettings(patch) { settings = migrateSettings({ ...settings, ...patch }); controls.updateSettings(settings); document.title = displaySessionName(settings); void saveSettings(settings); },
    onRestore: choose,
    onChooseFile: choose,
    onReDecode: showEncodingOptions,
    onRetry: choose,
    onFetchMore() { void workspace.next(); },
    onSelectUnit(id) { void workspace.read(id); }
  }) as ChatReaderShell;
  shell.mount(); document.querySelector('#boot')?.remove(); document.title = displaySessionName(settings);
  controls = new ControlsController(shell, settings, { keyboardCommands: false }); controls.mount();
  const workspace = new UnitWorkspace<TxtSource>(shell, async (source, index, valid) => {
    if (!valid()) return;
    const unit = source.units[index]!;
    const fingerprint = fingerprints.get(source)!;
    await saveTxtPosition({ fingerprint, encoding: source.encoding, rules: TXT_RULE_VERSION, sectionLength: SECTION_LENGTH,
      unitId: unit.id, sequence: index, start: unit.start });
  });
  const initial = () => shell.setLocalPrompt('选择本机 TXT 文件开始阅读。正文在左侧阅读入口（默认“项目方案讨论”），目录在“周报内容整理”。文件内容仅在当前阅读页内存中使用。', [{ label: '选择 TXT 文件', run: choose }]);
  initial();
  const importFile = async (file: File, forced?: TxtEncoding): Promise<void> => {
    const generation = ++importGeneration;
    try {
      const bytes = selectedFile === file && selectedBytes ? selectedBytes : await file.arrayBuffer();
      if (generation !== importGeneration) return;
      const decoded = decodeTxt(bytes, forced);
      const source = new TxtSource(decoded.text, decoded.encoding);
      if (!source.units.length) throw new Error('empty-file');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      if (generation !== importGeneration) return;
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const previous = await loadTxtPosition(hash).catch(() => undefined);
      if (generation !== importGeneration) return;
      selectedFile = file; selectedBytes = bytes; fingerprints.set(source, hash);
      workspace.replace(source, file.name);
      const saved = previous && previous.encoding === decoded.encoding && previous.rules === TXT_RULE_VERSION && previous.sectionLength === SECTION_LENGTH &&
        source.units[previous.sequence]?.id === previous.unitId && source.units[previous.sequence]?.start === previous.start ? previous : undefined;
      if (saved) shell.setLocalPrompt('找到这份文件的上次阅读位置。', [
        { label: '继续阅读', run: () => { shell.clearLocalPrompt(); void workspace.read(saved.unitId); } },
        { label: '从头开始', run: () => { shell.clearLocalPrompt(); void workspace.read(source.units[0]!.id); } }
      ]);
      else {
        shell.clearLocalPrompt();
        if (!await workspace.read(source.units[0]!.id)) shell.setNotice('文件已解析，但首个单元未能显示。可在目录中重试。');
      }
      if (decoded.uncertain) shell.setNotice('编码自动判断可能不准确；如有乱码，请重新选择文件并指定编码。');
    } catch (error) {
      if (generation !== importGeneration) return;
      const code = error instanceof Error ? error.message : '';
      shell.setNotice(code === 'empty-file' ? '文件没有可阅读文字，原正文已保留。' : '文件无法按所选编码读取，原正文已保留。');
      const retryBytes = await file.arrayBuffer();
      if (generation !== importGeneration) return;
      selectedFile = file; selectedBytes = retryBytes;
      shell.setLocalPrompt('可以为这个文件指定编码后重试。', (['utf-8', 'utf-16le', 'utf-16be', 'gb18030'] as const).map(encoding =>
        ({ label: encoding.toUpperCase(), run: () => { void importFile(file, encoding); } })).concat([{ label: '重新选择文件', run: choose }]));
    }
  };
  picker.addEventListener('change', () => { const file = picker.files?.[0]; if (file) void importFile(file); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) { settings = migrateSettings(changes.settings.newValue); shell.updateSettings(settings); controls.updateSettings(settings); document.title = displaySessionName(settings); }
  });
  chrome.runtime.onMessage.addListener((value, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !isProtocolMessage(value) || value.type !== 'control') return;
    const event = value as ReaderEvent;
    if (event.build !== RUNTIME_BUILD || event.type !== 'control') return;
    if (event.action === 'privacy') shell.setPrivacy(!shell.getPrivacy()); else controls.togglePanel();
  });
  window.addEventListener('pagehide', event => { shell.setPrivacy(true); ++importGeneration; workspace.invalidate(); if (!event.persisted) { controls.unmount(); shell.unmount(); } });
}
void start().catch(error => {
  const message = error instanceof Error && error.message.startsWith('captured-theme:')
    ? '本地展示资源不完整或版本不一致，请重新加载最新扩展后打开阅读页。'
    : '当前阅读会话不可用。请返回来源网站，从扩展按钮重新打开独立阅读页。';
  (document.querySelector('#boot') ?? document.body).textContent = message;
});

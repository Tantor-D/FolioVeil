import { isWeReadUrl } from '../../../packages/adapter-weread/src/structured';
import { isFanqieReaderUrl } from '../../../packages/adapter-fanqie/src/index';
import { PROTOCOL, RUNTIME_BUILD } from '../../../packages/reader-protocol/src/index';
const status = document.querySelector<HTMLElement>('#statusText')!;
const open = document.querySelector<HTMLButtonElement>('#toggleButton')!;
const privacy = document.querySelector<HTMLButtonElement>('#privacyButton')!;
const controls = document.querySelector<HTMLButtonElement>('#controlsButton')!;
const options = document.querySelector<HTMLButtonElement>('#optionsButton')!;
const reload = document.querySelector<HTMLButtonElement>('#reloadButton')!;
const helpButton = document.querySelector<HTMLButtonElement>('#helpButton')!;
const helpPanel = document.querySelector<HTMLElement>('#helpPanel')!;
helpButton.addEventListener('click', () => {
  helpPanel.hidden = !helpPanel.hidden;
  helpButton.setAttribute('aria-expanded', String(!helpPanel.hidden));
  helpButton.textContent = helpPanel.hidden ? '显示操作说明' : '收起操作说明';
});
document.querySelector<HTMLButtonElement>('#txtButton')!.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('reader.html?mode=txt') }).then(() => window.close());
});
const reconnectSection = document.querySelector<HTMLElement>('#reconnectSection')!;
const reconnectSession = document.querySelector<HTMLSelectElement>('#reconnectSession')!;
const reconnectButton = document.querySelector<HTMLButtonElement>('#reconnectButton')!;
document.documentElement.lang = 'zh-CN';
document.querySelector('[data-i18n="popupTagline"]')!.textContent = '独立阅读工作区';
document.querySelector('[data-i18n="popupPurposeTitle"]')!.textContent = '在新标签中阅读';
document.querySelector('[data-i18n="popupPurposeBody"]')!.textContent = '支持本地 TXT、微信读书和番茄小说。在本机独立阅读；原网站页面保持原样，不向 AI 发送正文。首次使用可展开下方操作说明。';
options.textContent = '设置'; privacy.textContent = '切换隐私界面'; controls.textContent = '显示操作面板'; reload.hidden = true;
let tab: chrome.tabs.Tab | undefined;
void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([active]) => {
  tab = active;
  const sourceName = isFanqieReaderUrl(active?.url ?? '') ? '番茄小说' : isWeReadUrl(active?.url ?? '') ? '微信读书' : undefined;
  const source = !!sourceName;
  const reader = active?.url?.startsWith(chrome.runtime.getURL('reader.html?session='));
  open.textContent = reader ? '当前已在独立阅读页' : '打开独立阅读页'; open.disabled = !source;
  privacy.disabled = controls.disabled = !reader;
  status.textContent = source ? `已识别${sourceName}，点击后显示当前内容` : reader ? '真实阅读内容在当前标签；隐私状态下用快捷键继续' : '可打开本地 TXT，或先在支持的网站打开正文页';
  if (source && active.id !== undefined) {
    const sessions = await chrome.runtime.sendMessage({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'list-reconnectable', sourceTabId: active.id });
    if (sessions?.error === 'reader-build-mismatch') status.textContent = '扩展页面版本不一致，请重新加载扩展后刷新阅读页。';
    if (Array.isArray(sessions) && sessions.length) {
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择阅读页'; reconnectSession.append(placeholder);
      for (const session of sessions) {
        if (typeof session.sessionId !== 'string' || !Number.isInteger(session.readerTabId)) continue;
        const option = document.createElement('option'); option.value = session.sessionId; option.textContent = typeof session.label === 'string' ? session.label : '已断开的阅读页'; reconnectSession.append(option);
      }
      reconnectSection.hidden = reconnectSession.options.length < 2;
    }
  }
}).catch(() => { status.textContent = '暂时无法读取标签状态，请关闭弹窗后重试。'; });
open.addEventListener('click', async () => {
  if (!tab?.id) return;
  open.disabled = true; status.textContent = '正在打开独立阅读页…';
  try {
    const result = await chrome.runtime.sendMessage({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'open', sourceTabId: tab.id });
    if (result?.error) throw new Error(result.error);
    window.close();
  } catch (error) { status.textContent = error instanceof Error && error.message === 'reader-build-mismatch' ? '扩展页面版本不一致，请重新加载扩展后刷新阅读页。' : '暂时无法打开，请刷新来源页面后重试。'; open.disabled = false; }
});
reconnectSession.addEventListener('change', () => { reconnectButton.disabled = !reconnectSession.value; });
reconnectButton.addEventListener('click', async () => {
  if (tab?.id === undefined || !reconnectSession.value) return;
  reconnectButton.disabled = open.disabled = true; status.textContent = '正在重新连接所选阅读页…';
  try {
    const result = await chrome.runtime.sendMessage({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'reconnect', sourceTabId: tab.id, sessionId: reconnectSession.value });
    if (result?.error) throw new Error(result.error);
    window.close();
  } catch (error) {
    status.textContent = error instanceof Error && error.message === 'source-already-bound' ? '当前来源已有阅读页，请点击“打开独立阅读页”继续。' : error instanceof Error && error.message === 'reader-build-mismatch' ? '扩展页面版本不一致，请重新加载扩展后刷新阅读页。' : '暂时无法连接该阅读页。请确认阅读页仍打开，然后重试。';
    reconnectButton.disabled = false; open.disabled = false;
  }
});
for (const [button, action] of [[privacy, 'privacy'], [controls, 'controls']] as const) button.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ protocol: PROTOCOL, build: RUNTIME_BUILD, type: 'control-reader', readerTabId: tab?.id, action }); window.close();
});
options.addEventListener('click', () => void chrome.runtime.openOptionsPage());

import { ChatReaderShell, type ChatShellCallbacks } from '../../reader-view/src/chat-shell';
import type { SettingsV2 } from '../../storage/src/index';
import type { DisplayAdapter } from '../../display-sdk/src/index';
import { capturedCSS, capturedIcons, captureInfo } from './captured';
import type { ThemeTemplate } from '../../display-sdk/src/template';
import type { LoadedCapturedFrame } from './captured-frame-contract';
import { mountCapturedFrame } from './captured-frame';

// Capture-dependent CSS is generated. This layer only adapts slots and responsive behavior.
const adaptationCSS = `
.app[data-scheme=dark]{--bg:#212121;--sidebar:#171717;--text:#ececec;--muted:#b4b4b4;--line:#424242;--hover:#2f2f2f;--card:#2f2f2f;--bubble:#303030}
.sidebar{width:var(--captured-sidebar-width);flex-basis:var(--captured-sidebar-width);padding:0 6px 12px;border-right:1px solid var(--line)}
.sidebar-top{padding:0 0 22px}.sidebar-brand{height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 8px}.brand-name{font-weight:600;font-size:16px}
.sidebar-toggle{width:44px;height:44px;border:0;background:transparent;color:var(--muted);display:grid;place-items:center}.sidebar-toggle:hover{background:var(--hover)}
.header{height:52px;flex-basis:52px;padding:0 24px;font-size:18px;font-weight:600;gap:6px}.header-sidebar-toggle{display:none}.app[data-sidebar=collapsed] .header-sidebar-toggle{display:grid}
.new-chat{display:flex;align-items:center;gap:8px;height:36px}.new-chat:before{display:none}.new-chat:hover{background:var(--hover)}.nav-icon{display:flex;align-items:center}
.sidebar-links{display:flex;flex-direction:column;gap:0;padding:0}.sidebar-links button{font-size:14px;color:var(--text);height:36px;text-align:left;padding:6px 12px;border-radius:10px}.sidebar-links button:hover{background:var(--hover)}
.section-label{font-size:12px;padding:0 12px 10px;letter-spacing:0}.session{height:36px;margin:0;padding:0 12px;border-radius:10px;font-size:14px;font-weight:400;letter-spacing:0}.session.active{font-weight:400}.session.active:after{display:none}
.sidebar-bottom{border-top:1px solid var(--line);padding:12px 10px 0;color:var(--text)}.avatar{background:#e8e8e8;color:#333}
.stream{max-width:calc(var(--content-width) + 48px);padding:32px 24px 160px}.title-bubble{background:#303030;color:#fff;border-radius:24px;padding:12px 20px;max-width:78%;font-size:16px;line-height:1.65;margin-bottom:32px}
.reply{line-height:var(--line-height)}.reply>p{margin-bottom:18px}.reply a{color:inherit;border-color:var(--muted)}
.composer-wrap{padding:24px 24px 32px}.composer{height:52px;max-width:calc(var(--content-width) + 8px);gap:8px;background:var(--bg)}.composer-placeholder{flex:1;color:var(--muted)}.composer-icon{width:28px;height:32px;display:grid;place-items:center;flex-shrink:0}.send{background:#b4b4b4;color:white;width:36px;height:36px;font-size:24px}.app[data-scheme=dark] .composer{border-color:var(--line);box-shadow:none}
.reading-status{font-size:13px;padding:18px 0}.end-note{font-size:12px;letter-spacing:0}.panel-actions .panel-primary{background:#303030;border-color:#303030}
@media(max-width:1000px){.sidebar{width:var(--captured-sidebar-width);flex-basis:var(--captured-sidebar-width)}.header{padding:0 20px}.stream{padding:28px 24px 150px}}
@media(max-width:760px){.header-sidebar-toggle{display:grid}.header{padding:0 12px}.stream{padding:24px 20px 145px}.composer-wrap{padding:20px 16px 28px}.title-bubble{max-width:90%}.app[data-mobile-sidebar=expanded] .sidebar{width:260px}.composer-placeholder{font-size:16px}.composer-mic{display:none}}
`;
export const chatGPTDisplayAdapter = {
  id: 'chatgpt', version: '0.4.0', captureInfo,
  create(settings: SettingsV2, callbacks: ChatShellCallbacks): ChatReaderShell {
    return new ChatReaderShell(settings, callbacks, { id: 'chatgpt', css: capturedCSS + adaptationCSS, headerLabel: 'ChatGPT', sidebarToggle: capturedIcons.sidebar, composerPlus: capturedIcons.plus });
  }
} satisfies DisplayAdapter & { captureInfo: typeof captureInfo };

/** Generated packages are bundled locally. Candidate use is restricted to an
 * explicit development preview; normal callers require an approved package. */
export function createChatGPTDisplayAdapter(template: ThemeTemplate, options: { previewCandidate?: boolean } = {}): DisplayAdapter {
  return {
    id: 'chatgpt', version: '0.4.0',
    create(settings, callbacks) {
      return new ChatReaderShell(settings, callbacks, { id: 'chatgpt', css: '', headerLabel: 'ChatGPT', template, allowCandidate: options.previewCandidate === true });
    }
  };
}

/** Production document adapter; the application awaits package validation first. */
export function createCapturedChatGPTDisplayAdapter(frame: LoadedCapturedFrame): DisplayAdapter {
  return {
    id: 'chatgpt', version: '0.5.0',
    create(settings, callbacks) {
      const documentFrame = mountCapturedFrame(frame, document);
      try { return new ChatReaderShell(settings, callbacks, { id: 'chatgpt', css: '', documentFrame }); }
      catch (error) { documentFrame.dispose(); throw error; }
    }
  };
}

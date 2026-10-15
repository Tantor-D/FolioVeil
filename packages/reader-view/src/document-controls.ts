/** Local reading controls only. The captured document owns its frame and typography. */
export const READER_CONTROLS_CSS = `
[data-fv-reader-ui] { --fv-surface:var(--main-surface-primary,#fff); --fv-text:var(--text-primary,#222); --fv-muted:var(--text-secondary,#666); --fv-border:var(--border-light,#ddd); color:var(--fv-text); font:13px/1.6 system-ui,sans-serif; box-sizing:border-box }
[data-fv-reader-ui][hidden],[data-fv-reader-ui] [hidden] { display:none!important }
[data-fv-reader-ui] *,[data-fv-reader-ui] *::before,[data-fv-reader-ui] *::after { box-sizing:border-box }
[data-fv-reader-ui] button,[data-fv-reader-ui] input,[data-fv-reader-ui] select { font:inherit; color:inherit }
[data-fv-reader-ui] button { cursor:pointer }
[data-fv-reader-ui] button:disabled { cursor:default; opacity:.5 }
[data-fv-reader-ui] :is(button,input,select,summary):focus-visible { outline:2px solid currentColor; outline-offset:3px }
[data-fv-reader-ui="controls"] { position:fixed; right:26px; top:18px; width:338px; max-width:calc(100vw - 28px); max-height:calc(100vh - 36px); overflow:auto; background:var(--fv-surface); border:1px solid var(--fv-border); border-radius:14px; padding:18px; box-shadow:0 14px 60px #0003; z-index:2147483646; scrollbar-width:thin }
[data-fv-reader-ui="controls"][data-corner="top-left"] { left:26px; right:auto }
[data-fv-reader-ui="controls"][data-corner="bottom-right"] { top:auto; bottom:18px }
[data-fv-reader-ui="controls"][data-corner="bottom-left"] { top:auto; bottom:18px; left:26px; right:auto }
[data-fv-reader-ui] .panel-header,[data-fv-reader-ui] .preview-head { display:flex; justify-content:space-between; align-items:center; gap:24px; font-size:14px; margin-bottom:16px }
[data-fv-reader-ui] .panel-close,[data-fv-reader-ui] .preview-head button { font-size:22px; border:0; background:transparent; width:28px; height:28px; line-height:1 }
[data-fv-reader-ui] .setting-group { border:0; padding:0; margin:0 0 15px }
[data-fv-reader-ui] .setting-group legend { padding:0; margin-bottom:10px; font-weight:500 }
[data-fv-reader-ui] .segments { display:grid; grid-template-columns:1.15fr 1fr .9fr; gap:4px; padding:4px; border:1px solid var(--fv-border); border-radius:8px }
[data-fv-reader-ui] .segments button { padding:9px 3px; background:transparent; border:0; border-radius:6px; font-size:11px; white-space:nowrap }
[data-fv-reader-ui] .segments button[aria-pressed=true] { background:var(--main-surface-secondary,#eee) }
[data-fv-reader-ui] .help { font-size:11px; line-height:1.7; color:var(--fv-muted); margin:9px 0 0; white-space:pre-line }
[data-fv-reader-ui] .panel-navigation,[data-fv-reader-ui] .panel-actions { display:flex; gap:8px; margin:14px 0 }
[data-fv-reader-ui] .panel-navigation button,[data-fv-reader-ui] .panel-actions button,[data-fv-reader-ui] .panel-action { flex:1; padding:8px; background:var(--main-surface-secondary,#eee); border:1px solid var(--fv-border); border-radius:7px }
[data-fv-reader-ui] .panel-action { margin-block:4px; width:100% }
[data-fv-reader-ui] .panel-details { border-top:1px solid var(--fv-border); padding:11px 0 }
[data-fv-reader-ui] .panel-details summary { cursor:pointer; display:flex; justify-content:space-between; list-style:none }
[data-fv-reader-ui] .panel-details summary::after { content:'+' }
[data-fv-reader-ui] .panel-details[open] summary::after { content:'−' }
[data-fv-reader-ui] .settings-form { display:flex; flex-direction:column; gap:15px; padding-top:17px }
[data-fv-reader-ui] .range-row { display:flex; flex-direction:column; gap:8px }
[data-fv-reader-ui] .range-label,[data-fv-reader-ui] .check-row,[data-fv-reader-ui] .setting-row { display:flex; justify-content:space-between; gap:12px; align-items:center }
[data-fv-reader-ui] .range-label output { color:var(--fv-muted); font-variant-numeric:tabular-nums }
[data-fv-reader-ui] .range-row input { width:100%; margin:0 }
[data-fv-reader-ui] .setting-row :is(input,select) { max-width:160px; min-width:0; border:1px solid var(--fv-border); background:var(--fv-surface); border-radius:5px; padding:6px }
[data-fv-reader-ui] .toc-list { max-height:210px; overflow:auto; margin-top:10px }
[data-fv-reader-ui] .toc-list button { display:block; width:100%; text-align:left; border:0; background:transparent; padding:7px 8px; border-radius:5px }
[data-fv-reader-ui] .source-info { overflow-wrap:anywhere; font-size:11px; color:var(--fv-muted) }
[data-fv-reader-ui="preview"] { position:fixed; inset:0; background:#1119; display:flex; align-items:center; justify-content:center; z-index:2147483647; padding:20px }
[data-fv-reader-ui] .preview-dialog { width:fit-content; max-width:90vw; max-height:80vh; background:var(--fv-surface); border-radius:14px; display:flex; flex-direction:column; padding:18px; overflow:hidden; box-shadow:0 25px 100px #0005 }
[data-fv-reader-ui] .preview-head { flex-shrink:0 }
[data-fv-reader-ui] .preview-body { min-height:0; overflow:auto; text-align:center }
[data-fv-reader-ui] .preview-body img { display:block; max-width:100%; max-height:56vh; width:auto; height:auto; object-fit:contain; margin:auto }
[data-fv-reader-ui] .preview-caption { max-width:800px; overflow-wrap:anywhere; font-size:12px; color:var(--fv-muted); margin:14px 0 0; max-height:13vh; overflow:auto }
[data-fv-reader-ui] .retry-image { padding:8px 14px; border:1px solid var(--fv-border); border-radius:6px }
[data-fv-reader-ui="status"],[data-fv-reader-ui="end"],[data-fv-reader-ui="recovery"] { margin:12px auto; max-width:48rem; padding:8px 16px; font-size:12px }
[data-fv-reader-ui="recovery"] button { margin-inline-end:8px; padding:8px; border:1px solid var(--fv-border); border-radius:6px }
[data-fv-reader-ui="contents-view"] .fv-contents,[data-fv-reader-ui="local-prompt"] { width:min(100%,48rem); margin:24px auto; padding:20px; border:1px solid var(--border-light,#ddd); border-radius:14px; background:var(--main-surface-primary,#fff); color:var(--text-primary,#222); font:14px/1.6 system-ui,sans-serif }
[data-fv-reader-ui="contents-view"] .fv-contents h2 { margin:0 0 12px; font-size:17px; overflow-wrap:anywhere }
[data-fv-reader-ui="contents-view"] .fv-contents-list { max-height:min(65vh,560px); overflow:auto; margin-top:14px }
[data-fv-reader-ui="contents-view"] .fv-contents-list button { display:block; width:100%; padding:9px 12px; border:0; border-radius:8px; background:transparent; text-align:left }
[data-fv-reader-ui="contents-view"] .fv-contents-list button:hover,[data-fv-reader-ui="contents-view"] .fv-contents-list button[aria-current=true] { background:var(--main-surface-secondary,#eee) }
[data-fv-reader-ui="contents-view"] .fv-contents>button,[data-fv-reader-ui="local-prompt"] button { margin:4px 8px 4px 0; padding:7px 12px; border:1px solid var(--border-light,#ddd); border-radius:7px; background:transparent }
[data-fv-image] { max-width:100% }
[data-fv-image] .image-trigger { display:block; max-width:100%; border:0; padding:0; background:transparent; color:inherit; text-align:start; cursor:pointer }
[data-fv-image] .image-trigger img { max-width:100%; height:auto; object-fit:contain }
[data-fv-image].mode-thumbnail img { max-width:160px; max-height:120px; width:auto; height:auto }
[data-fv-image] :is(.image-label,.image-failed) { display:block; font:12px/1.6 system-ui,sans-serif; margin:6px 0 }
`;

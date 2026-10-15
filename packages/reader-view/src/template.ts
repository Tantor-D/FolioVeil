import type { ThemeSlot, ThemeTemplate } from '../../display-sdk/src/template';

const SLOTS: ThemeSlot[] = ['shell','sidebar','header','scroller','conversationList','userMessage','assistantMessage','composer'];
const ACTIONS = new Set(['toggleSidebar','newConversation','previous','next','privacy','showControls','returnSource']);
const TAGS = new Set(['div','span','section','aside','nav','header','footer','main','article','p','h1','h2','h3','h4','h5','h6','ul','ol','li','button','label','strong','em','small','br','hr','pre','code','table','thead','tbody','tr','th','td','svg','g','path','rect','circle','line','polyline','polygon','ellipse']);
const SVG_ATTRS = new Set(['viewBox','width','height','d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule','transform','cx','cy','r','rx','ry','x','y','x1','x2','y1','y2','points']);
const CSS_PROPS = new Set(['font-family','font-size','font-weight','font-style','line-height','letter-spacing','color','background-color','border','border-radius','box-shadow','display','position','top','right','bottom','left','padding','margin','gap','row-gap','column-gap','align-items','align-self','justify-content','flex-direction','flex-wrap','flex-grow','flex-shrink','flex-basis','grid-template-columns','grid-template-rows','width','height','max-width','min-width','max-height','min-height','overflow-x','overflow-y','white-space','text-align','text-overflow','overflow-wrap','word-break','box-sizing','opacity','transform','vertical-align','content']);
const unsafeValue = /[\\<>\u0000-\u001f]|@|\/\*|url\s*\(|expression\s*\(|(?:https?|data|javascript):/i;
const invalid = (code: string): never => { throw new Error(`theme-template:${code}`); };

export interface MaterializedTheme {
  fragment: DocumentFragment;
  root: HTMLElement;
  slots: Record<ThemeSlot, HTMLElement>;
  style: HTMLStyleElement;
  messageFlow: HTMLElement;
  messageBranches: { user: HTMLElement; assistant: HTMLElement };
}

/** Accept bundled local compiler output only. This function never fetches templates.
 * Production callers cannot accidentally promote an unreviewed generated candidate. */
export function materializeThemeTemplate(template: ThemeTemplate, ownerDocument: Document = document, options: { allowCandidate?: boolean } = {}): MaterializedTheme {
  if(template.manifest?.schemaVersion!==1||!template.manifest.runtimeReady||template.manifest.missing.length)invalid('incomplete');
  if(template.manifest.status!=='approved'&&!(options.allowCandidate&&template.manifest.status==='candidate'))invalid('unapproved');
  if(typeof template.html!=='string'||template.html.length>2_000_000||typeof template.css!=='string'||template.css.length>2_000_000)invalid('invalid-size');
  const css=template.css;
  if(unsafeValue.test(css.replace(/[\r\n\t]/g,'')))invalid('unsafe-css');
  let consumed='';
  const rules=/\.(fv-n\d+)(::before|::after)?\{([^{}]*)\}/g;
  for(const match of css.matchAll(rules)) {
    consumed+=match[0];
    for(const declaration of match[3]!.split(';').filter(Boolean)) {
      const colon=declaration.indexOf(':'),property=declaration.slice(0,colon),value=declaration.slice(colon+1);
      if(colon<1||!CSS_PROPS.has(property)||!value||unsafeValue.test(value)||(property==='content'&&value!=='""'))invalid('unsafe-css-declaration');
    }
  }
  if(consumed.replace(/\s/g,'')!==css.replace(/\s/g,''))invalid('unsafe-css-selector');
  const holder=ownerDocument.createElement('template');holder.innerHTML=template.html;
  if(holder.content.children.length!==1)invalid('invalid-root');
  const root=holder.content.firstElementChild as HTMLElement;
  for(const node of holder.content.querySelectorAll('*')) {
    if(!TAGS.has(node.localName))invalid('unsafe-tag');
    for(const {name,value} of [...node.attributes]) {
      const isSvg=node.namespaceURI==='http://www.w3.org/2000/svg';
      const allowed=name==='class'&&/^fv-n\d+$/.test(value)
        ||name==='data-fv-slot'&&SLOTS.includes(value as ThemeSlot)
        ||name==='data-fv-action'&&ACTIONS.has(value)
        ||name==='type'&&node.localName==='button'&&value==='button'
        ||isSvg&&SVG_ATTRS.has(name)&&!unsafeValue.test(value)&&!/[{};]/.test(value);
      if(!allowed)invalid('unsafe-attribute');
    }
  }
  const textWalker=ownerDocument.createTreeWalker(holder.content,4|128);
  while(textWalker.nextNode())if(textWalker.currentNode.textContent?.trim())invalid('source-text');
  const slots={} as Record<ThemeSlot,HTMLElement>;
  for(const slot of SLOTS) {
    const selector=`[data-fv-slot="${slot}"]`,matches=holder.content.querySelectorAll<HTMLElement>(selector);
    if(template.slots[slot]?.selector!==selector||template.slots[slot]?.cardinality!==1||matches.length!==1)invalid(`invalid-slot:${slot}`);
    slots[slot]=matches[0]!;
    if(slots[slot].namespaceURI!=='http://www.w3.org/1999/xhtml')invalid(`non-html-slot:${slot}`);
  }
  if(slots.shell!==root||!slots.sidebar.contains(slots.conversationList)||!slots.scroller.contains(slots.userMessage)||!slots.scroller.contains(slots.assistantMessage))invalid('invalid-slot-tree');
  if(slots.userMessage.contains(slots.assistantMessage)||slots.assistantMessage.contains(slots.userMessage))invalid('overlapping-message-slots');
  let messageFlow=slots.userMessage.parentElement;
  while(messageFlow&&!messageFlow.contains(slots.assistantMessage))messageFlow=messageFlow.parentElement;
  if(!messageFlow||!slots.scroller.contains(messageFlow)||[slots.sidebar,slots.header,slots.conversationList,slots.composer].some(slot=>messageFlow!.contains(slot)))invalid('unsafe-message-flow');
  const flow=messageFlow!;
  const branch=(slot:HTMLElement):HTMLElement=>{let node=slot;while(node.parentElement!==flow){if(!node.parentElement)invalid('unsafe-message-flow');node=node.parentElement!;}return node;};
  const messageBranches={user:branch(slots.userMessage),assistant:branch(slots.assistantMessage)};
  for(const action of root.querySelectorAll('[data-fv-action]'))if([slots.userMessage,slots.assistantMessage,slots.conversationList,slots.composer].some(slot=>slot.contains(action)))invalid('action-in-replaced-slot');
  if(flow.querySelector('[data-fv-action]'))invalid('action-in-replaced-flow');
  const style=ownerDocument.createElement('style');style.textContent=css;
  const fragment=ownerDocument.createDocumentFragment();fragment.append(style,root);
  return {fragment,root,slots,style,messageFlow:flow,messageBranches};
}

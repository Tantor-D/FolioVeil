import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

export const REQUIRED_SLOTS = ['shell','sidebar','header','scroller','conversationList','userMessage','assistantMessage','composer'];
const ACTIONS = new Set(['toggleSidebar','newConversation','previous','next','privacy','showControls','returnSource']);
const HTML_TAGS = new Set(['div','span','section','aside','nav','header','footer','main','article','p','h1','h2','h3','h4','h5','h6','ul','ol','li','button','label','strong','em','small','br','hr','pre','code','table','thead','tbody','tr','th','td']);
const SVG_TAGS = new Set(['svg','g','path','rect','circle','line','polyline','polygon','ellipse']);
const SVG_ATTRS = new Set(['viewBox','width','height','d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule','transform','cx','cy','r','rx','ry','x','y','x1','x2','y1','y2','points']);
const CSS_PROPS = new Set(['font-family','font-size','font-weight','font-style','line-height','letter-spacing','color','background-color','border','border-radius','box-shadow','display','position','top','right','bottom','left','padding','margin','gap','row-gap','column-gap','align-items','align-self','justify-content','flex-direction','flex-wrap','flex-grow','flex-shrink','flex-basis','grid-template-columns','grid-template-rows','width','height','max-width','min-width','max-height','min-height','overflow-x','overflow-y','white-space','text-align','text-overflow','overflow-wrap','word-break','box-sizing','opacity','transform','vertical-align']);
const doc = new JSDOM('').window.document;
const fail = code => { throw new Error(`theme-compile:${code}`); };
const obj = value => value!==null&&typeof value==='object'&&!Array.isArray(value);
const stable = value => Array.isArray(value)?value.map(stable):obj(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const stableJSON = value => JSON.stringify(stable(value),null,2)+'\n';
const digest = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

export function sanitizeCSS(input) {
  if(!obj(input))return {};
  const clean={};
  for(const name of Object.keys(input).sort()) {
    const value=input[name];
    if(!CSS_PROPS.has(name)||typeof value!=='string'||value.length>1000||/[\\;{}<>\u0000-\u001f]|@|\/\*|url\s*\(|expression\s*\(|(?:https?|data|javascript):/i.test(value))continue;
    const style=doc.createElement('div').style;style.setProperty(name,value);
    const parsed=style.getPropertyValue(name);
    if(parsed)clean[name]=parsed;
  }
  return clean;
}
const declarations = css => Object.entries(sanitizeCSS(css)).map(([key,value])=>`${key}:${value}`).join(';');
function svgAttrs(input) {
  const clean={};
  if(!obj(input))return clean;
  for(const name of Object.keys(input).sort()) {
    const value=input[name];
    if(!SVG_ATTRS.has(name)||typeof value!=='string'||value.length>50000||/[\\<>\u0000-\u001f]|url\s*\(|(?:https?|javascript|data):/i.test(value))continue;
    if(name==='fill'||name==='stroke') {
      const color=doc.createElement('div').style;color.color=value;
      if(!['none','currentColor'].includes(value)&&!color.color)continue;
    } else if(name==='d') { if(!/^[MmZzLlHhVvCcSsQqTtAaEe\d\s.,+-]*$/.test(value))continue; }
    else if(name==='transform') { if(!/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([\d\s.,eE+-]+\)\s*)+$/.test(value))continue; }
    else if(name==='stroke-linecap') { if(!['butt','round','square'].includes(value))continue; }
    else if(name==='stroke-linejoin') { if(!['miter','round','bevel'].includes(value))continue; }
    else if(name==='fill-rule'||name==='clip-rule') { if(!['nonzero','evenodd'].includes(value))continue; }
    else if(!/^[\d\s.,eE%+-]+(?:px)?$/.test(value))continue;
    clean[name]=value;
  }
  return clean;
}
export function sanitizeSVG(raw) {
  if(typeof raw!=='string'||raw.length>200000)return '';
  const template=doc.createElement('template');template.innerHTML=raw;
  const render=node=>{
    if(!SVG_TAGS.has(node.localName))return '';
    const attrs=svgAttrs(Object.fromEntries([...node.attributes].map(({name,value})=>[name,value])));
    return `<${node.localName}${Object.entries(attrs).map(([key,value])=>` ${key}="${escape(value)}"`).join('')}>${[...node.children].map(render).join('')}</${node.localName}>`;
  };
  return [...template.content.children].filter(node=>node.localName==='svg').map(render).join('');
}
function metadata(capture) {
  let origin;try{const url=new URL(capture.origin);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)fail('invalid-origin');origin=url.origin;}catch{fail('invalid-origin');}
  if(!/^(?:public-home-light|(?:conversation|public-home)-(?:light|dark)-(?:expanded|collapsed|narrow-expanded|narrow-collapsed))$/.test(capture.state))fail('invalid-state');
  const viewport={};for(const key of ['width','height']) {const value=capture.viewport?.[key];if(!Number.isFinite(value)||value<1||value>20000)fail('invalid-viewport');viewport[key]=value;}
  const env=capture.environment??{};
  const environment={devicePixelRatio:Number.isFinite(env.devicePixelRatio)&&env.devicePixelRatio>0&&env.devicePixelRatio<=10?env.devicePixelRatio:null,zoom:Number.isFinite(env.zoom)&&env.zoom>0&&env.zoom<=10?env.zoom:null,language:typeof env.language==='string'&&/^[a-z]{2,3}(?:-[a-zA-Z]{2,8})*$/.test(env.language)?env.language:'und',fontsReady:env.fontsReady===true};
  const capturedAt=typeof capture.capturedAt==='string'&&/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(capture.capturedAt)?capture.capturedAt:null;
  return {origin,state:capture.state,viewport,environment,capturedAt};
}
const DIAGNOSTIC_CODES = new Set(['authenticated-conversation','message-bubbles','dark','narrow','excluded-regions','unsupported-elements','unresolved-svg-use','pseudo-content-excluded','shadow-tree-not-captured','computed-layout-needs-responsive-review','resolved-layout-fallback','font-assets-not-captured','closed-shadow-status-unknown']);
const safeCodes = values => Array.isArray(values)?values.filter(value=>DIAGNOSTIC_CODES.has(value)).sort():[];
function measurements(capture) {
  return Object.fromEntries(REQUIRED_SLOTS.filter(name=>obj(capture.slots?.[name])).map(name=>{
    const slot=capture.slots[name],rect={};
    for(const key of ['x','y','width','height'])if(Number.isFinite(slot.rect?.[key]))rect[key]=slot.rect[key];
    return [name,{rect,css:sanitizeCSS(slot.css)}];
  }));
}

/** Accept untrusted captures without exporting source text, selectors or links.
 * A generated candidate is never automatically promoted to the runtime theme. */
export function compileCapture(capture) {
  if(!obj(capture)||![1,2].includes(capture.schemaVersion)||!obj(capture.slots))fail('invalid-schema');
  const source=metadata(capture),slots={},assets={},rules=[],counts=new Map();let count=0;
  const complete=capture.schemaVersion===2;
  if(complete&&(capture.missing?.length||capture.truncated===true))fail('incomplete-capture');
  if(complete)for(const name of REQUIRED_SLOTS){
    const slot=capture.slots[name];if(!obj(slot))fail(`missing-slot:${name}`);
    if(!obj(slot.css)||!['x','y','width','height'].every(key=>Number.isFinite(slot.rect?.[key])))fail(`invalid-measurement:${name}`);
  }
  const render=(node,depth=0,inSVG=false)=>{
    if(!obj(node)||depth>100||++count>20000)fail('invalid-or-truncated-tree');
    const sourceTag=node.tag;
    const tag=({body:'div',a:'span',form:'div',textarea:'div',input:'span'})[sourceTag]??sourceTag;
    const svg=inSVG||tag==='svg';
    if(typeof tag!=='string'||!(svg?SVG_TAGS:HTML_TAGS).has(tag))return '';
    const cls=`fv-n${count}`;const attrs={class:cls};
    if(svg)Object.assign(attrs,svgAttrs(node.attrs));
    if(tag==='button')attrs.type='button';
    if(node.slot!==undefined){if(!REQUIRED_SLOTS.includes(node.slot))fail('unknown-slot');counts.set(node.slot,(counts.get(node.slot)??0)+1);attrs['data-fv-slot']=node.slot;slots[node.slot]={selector:`[data-fv-slot="${node.slot}"]`,cardinality:1};}
    if(node.action!==undefined){if(!ACTIONS.has(node.action))fail('unknown-action');attrs['data-fv-action']=node.action;}
    const css=declarations(node.css);if(css)rules.push(`.${cls}{${css}}`);
    for(const pseudo of ['::before','::after'])if(obj(node.pseudo?.[pseudo])){const css=declarations(node.pseudo[pseudo]);if(css)rules.push(`.${cls}${pseudo}{content:"";${css}}`);}
    // Discard text again, even if the input was not correctly sanitized.
    if(node.children!==undefined&&!Array.isArray(node.children))fail('invalid-children');
    const children=(node.children??[]).filter(child=>!(obj(child)&&Object.hasOwn(child,'text'))).map(child=>render(child,depth+1,svg)).join('');
    const html=`<${tag}${Object.entries(attrs).map(([key,value])=>` ${key}="${escape(value)}"`).join('')}>${children}${['br','hr'].includes(tag)?'':`</${tag}>`}`;
    if(tag==='svg'){const cleaned=sanitizeSVG(html);assets[`icon-${digest(cleaned).slice(0,16)}.svg`]=cleaned;}
    return html;
  };
  let html='';
  if(complete){
    if(!obj(capture.tree)||capture.tree.slot!=='shell')fail('missing-shell-tree');
    html=render(capture.tree);for(const name of REQUIRED_SLOTS)if(counts.get(name)!==1)fail(`${counts.get(name)?'ambiguous':'missing'}-slot:${name}`);
    const holder=doc.createElement('template');holder.innerHTML=html;
    const find=name=>holder.content.querySelector(`[data-fv-slot="${name}"]`);
    if(!find('sidebar').contains(find('conversationList'))||!find('scroller').contains(find('userMessage'))||!find('scroller').contains(find('assistantMessage'))||find('userMessage').contains(find('assistantMessage'))||find('assistantMessage').contains(find('userMessage')))fail('invalid-slot-tree');
    let flow=find('userMessage').parentElement;while(flow&&!flow.contains(find('assistantMessage')))flow=flow.parentElement;
    if(!flow||!find('scroller').contains(flow)||['sidebar','header','conversationList','composer'].some(name=>flow.contains(find(name))))fail('unsafe-message-flow');
    for(const action of holder.content.querySelectorAll('[data-fv-action]'))if(['userMessage','assistantMessage','conversationList','composer'].some(name=>find(name).contains(action)))fail('action-in-replaced-slot');
    if(flow.querySelector('[data-fv-action]'))fail('action-in-replaced-flow');
  }
  // Legacy measurements remain an explicitly incomplete candidate.
  if(!complete)for(const name of ['body','sidebar','sidebarToggle','newChat','composer','composerText']) {const css=declarations(capture.slots[name]?.css);if(css)rules.push(`[data-fv-legacy="${name}"]{${css}}`);}
  const iconNames=new Set(['sidebar','plus','microphone','send','newChat','search','chevron','close']);
  const icons={};for(const [key,value]of Object.entries(capture.icons??{}).sort(([a],[b])=>a.localeCompare(b)))if(iconNames.has(key)){const svg=sanitizeSVG(value);if(svg){icons[key]=svg;assets[`icon-${digest(svg).slice(0,16)}.svg`]=svg;}}
  const css=rules.join('\n')+'\n';
  const manifest={schemaVersion:1,id:'chatgpt',status:'candidate',runtimeReady:complete,source,evidence:{capture:capture.evidence==='rendered-dom'?'rendered-dom':capture.evidence==='synthetic'?'synthetic':'unverified',generated:true,realConversation:complete&&capture.evidence==='rendered-dom'&&source.origin==='https://chatgpt.com'&&source.state.startsWith('conversation-'),visualComparison:'missing'},missing:complete?[]:['conversation-template',...safeCodes(capture.missing)],omissions:safeCodes(capture.omissions),measurements:measurements(capture),assets:Object.keys(assets).sort()};
  manifest.contentHash=digest(html+'\n'+css+stableJSON(assets)+stableJSON(manifest));
  return {html,css,slots,icons,assets,manifest};
}

export function packageFiles(template) {
  const exported={html:template.html,css:template.css,slots:template.slots,icons:template.icons,manifest:template.manifest};
  const literal=stableJSON(exported).trim();
  return {'shell.html':template.html+'\n','theme.css':template.css,'slots.json':stableJSON(template.slots),'theme.json':stableJSON(template.manifest),'theme-template.mjs':`// Generated candidate. Promotion requires separate review.\nexport const themeTemplate = ${literal};\n`,'theme-template.ts':`// Generated candidate; copy with its contract only after review.\nimport type { ThemeTemplate } from './template-contract';\nexport const themeTemplate = ${literal} satisfies ThemeTemplate;\n`,...Object.fromEntries(Object.entries(template.assets).map(([name,svg])=>[`assets/${name}`,svg+'\n']))};
}

/** Read-only sampler for an explicitly authorized, already rendered conversation.
 * Execute captureDisplayTheme(config) in the page. No requests, clicks, storage,
 * real text, navigation URLs, account attributes, or application scripts are exported.
 * Selectors stay in the operator's config and never enter the returned artifact. */
function captureDisplayTheme(config) {
  const required = ['shell', 'sidebar', 'header', 'scroller', 'conversationList', 'userMessage', 'assistantMessage', 'composer'];
  const actions = new Set(['toggleSidebar', 'newConversation', 'previous', 'next', 'privacy', 'showControls', 'returnSource']);
  const states = /^(conversation|public-home)-(light|dark)-(expanded|collapsed|narrow-expanded|narrow-collapsed)$/;
  if (!config || !states.test(config.state)) throw new Error('theme-capture:invalid-state');
  const props = ['font-family','font-size','font-weight','font-style','line-height','letter-spacing','color','background-color','border','border-radius','box-shadow','display','position','top','right','bottom','left','padding','margin','gap','row-gap','column-gap','align-items','align-self','justify-content','flex-direction','flex-wrap','flex-grow','flex-shrink','flex-basis','grid-template-columns','grid-template-rows','width','height','max-width','min-width','max-height','min-height','overflow-x','overflow-y','white-space','text-align','text-overflow','overflow-wrap','word-break','box-sizing','opacity','transform','vertical-align'];
  const allowedTags = new Set(['body','div','span','section','aside','nav','header','footer','main','article','p','h1','h2','h3','h4','h5','h6','ul','ol','li','button','a','form','label','textarea','input','strong','em','small','br','hr','pre','code','table','thead','tbody','tr','th','td','svg','g','path','rect','circle','line','polyline','polygon','ellipse']);
  const svgAttributes = new Set(['viewBox','width','height','d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule','transform','cx','cy','r','rx','ry','x','y','x1','x2','y1','y2','points']);
  const slotElements = new Map(), actionElements = new Map(), slots = {}, omissions = new Set();
  const visible = element => { const r=element.getBoundingClientRect(); const s=getComputedStyle(element); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
  const locate = (selector, label) => {
    if (typeof selector !== 'string') throw new Error(`theme-capture:missing:${label}`);
    const allowHidden=config.state.endsWith('collapsed')&&['sidebar','conversationList'].includes(label);
    let matches; try { matches=[...document.querySelectorAll(selector)].filter(element=>allowHidden||visible(element)); } catch { throw new Error(`theme-capture:invalid-selector:${label}`); }
    if (matches.length!==1) throw new Error(`theme-capture:${matches.length?'ambiguous':'missing'}:${label}`);
    return matches[0];
  };
  const layoutProps=new Set(['width','height','min-width','max-width','min-height','max-height','top','right','bottom','left','padding','margin','gap','row-gap','column-gap','flex-basis','grid-template-columns','grid-template-rows']);
  const styles = (element,pseudo) => {
    const computed=getComputedStyle(element,pseudo);
    let typed;try{if(!pseudo&&typeof element.computedStyleMap==='function')typed=element.computedStyleMap();}catch{ /* record resolved fallback below */ }
    if(!typed&&!pseudo)omissions.add('resolved-layout-fallback');
    return Object.fromEntries(props.map(name=>{
      let value=computed.getPropertyValue(name);
      // Typed OM preserves auto/percentage constraints that resolved pixel values lose.
      if(typed&&layoutProps.has(name)){try{const original=typed.get(name);if(original)value=original.toString();}catch{/* unsupported property retains measured fallback */}}
      return [name,value];
    }).filter(([,value])=>value && !/[\\;{}<>\u0000-\u001f]|url\s*\(|@|\/\*/i.test(value)));
  };
  for (const name of required) {
    const element=locate(config.slots?.[name],name);
    if (slotElements.has(element)) throw new Error(`theme-capture:overlapping-slots:${name}`);
    slotElements.set(element,name);
    const r=element.getBoundingClientRect();
    slots[name]={css:styles(element),rect:{x:r.x,y:r.y,width:r.width,height:r.height},visible:visible(element)};
  }
  const root=[...slotElements].find(([,name])=>name==='shell')[0];
  omissions.add('computed-layout-needs-responsive-review');
  omissions.add('font-assets-not-captured');
  omissions.add('closed-shadow-status-unknown');
  for (const [element,name] of slotElements) if (!root.contains(element)) throw new Error(`theme-capture:outside-shell:${name}`);
  for (const [name,selector] of Object.entries(config.actions??{})) {
    if (!actions.has(name)) throw new Error('theme-capture:unknown-action');
    const element=locate(selector,name);
    if (!root.contains(element)||actionElements.has(element)) throw new Error(`theme-capture:invalid-action:${name}`);
    actionElements.set(element,name);
  }
  const excluded=new Set();
  for (const selector of config.excludeSelectors??[]) for (const element of document.querySelectorAll(selector)) excluded.add(element);
  let count=0;
  const limit=Math.min(20000,Math.max(1,Number(config.maxNodes)||6000));
  const tree=(element,depth=0,expanding=new Set())=>{
    if (excluded.has(element)) { omissions.add('excluded-regions'); return null; }
    if (++count>limit||depth>100) throw new Error('theme-capture:truncated');
    if (!allowedTags.has(element.localName)) { omissions.add('unsupported-elements'); return null; }
    const attrs={};
    if(element.namespaceURI==='http://www.w3.org/2000/svg') for(const {name,value} of element.attributes) if(svgAttributes.has(name)&&!/[\\<>\u0000-\u001f]|url\s*\(|https?:|javascript:|data:/i.test(value)) attrs[name]=value;
    const children=[];
    for(const child of element.children) {
      if(child.localName==='use') {
        const ref=child.getAttribute('href')??child.getAttribute('xlink:href');
        const symbol=ref?.startsWith('#')?document.getElementById(ref.slice(1)):null;
        if(symbol&&!expanding.has(symbol)) { const visited=new Set(expanding);visited.add(symbol); for(const part of symbol.children){const item=tree(part,depth+1,visited);if(item)children.push(item);} }
        else omissions.add('unresolved-svg-use');
      } else {const item=tree(child,depth+1,expanding);if(item)children.push(item);}
    }
    const pseudo={};
    for(const name of ['::before','::after']) {
      const s=getComputedStyle(element,name);
      if(s.content&&s.content!=='none'&&s.content!=='normal'){pseudo[name]=styles(element,name);omissions.add('pseudo-content-excluded');}
    }
    if(element.shadowRoot) omissions.add('shadow-tree-not-captured');
    return {tag:element.localName==='body'?'div':element.localName,slot:slotElements.get(element),action:actionElements.get(element),attrs,css:styles(element),pseudo,children};
  };
  const capturedTree=tree(root);
  const found=new Set();const inspect=node=>{if(node?.slot)found.add(node.slot);for(const child of node?.children??[])inspect(child);};inspect(capturedTree);
  for(const name of required)if(!found.has(name))throw new Error(`theme-capture:uncaptured-slot:${name}`);
  return {schemaVersion:2,origin:location.origin,capturedAt:new Date().toISOString(),state:config.state,evidence:'rendered-dom',viewport:{width:innerWidth,height:innerHeight},environment:{devicePixelRatio,zoom:typeof config.zoom==='number'?config.zoom:null,language:/^[a-z]{2,3}(-[a-zA-Z]{2,8})*$/.test(document.documentElement.lang)?document.documentElement.lang:'und',fontsReady:document.fonts?.status==='loaded'},slots,tree:capturedTree,missing:[],omissions:[...omissions].sort()};
}

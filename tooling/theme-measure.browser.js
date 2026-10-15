/** Measure a local generated template after content binding; no text is exported.
 * Call with the rendered root (including a ShadowRoot) and explicit state/zoom. */
function measureDisplayTheme(root, config) {
  const names=['shell','sidebar','header','scroller','conversationList','userMessage','assistantMessage','composer'];
  if(!/^(conversation|public-home)-(light|dark)-(expanded|collapsed|narrow-expanded|narrow-collapsed)$/.test(config.state))throw new Error('theme-measure:invalid-state');
  const slots={};
  for(const name of names) {
    const matches=[...root.querySelectorAll(`[data-fv-slot="${name}"]`)];
    if(root instanceof Element&&root.getAttribute('data-fv-slot')===name)matches.unshift(root);
    if(matches.length!==1)throw new Error(`theme-measure:${matches.length?'ambiguous':'missing'}:${name}`);
    const element=matches[0],r=element.getBoundingClientRect(),style=getComputedStyle(element);
    slots[name]={rect:{x:r.x,y:r.y,width:r.width,height:r.height},css:Object.fromEntries(['font-size','line-height','font-family'].map(name=>[name,style.getPropertyValue(name)]))};
  }
  return {schemaVersion:2,evidence:'local-replay',state:config.state,viewport:{width:innerWidth,height:innerHeight},environment:{devicePixelRatio,zoom:config.zoom??null,language:document.documentElement.lang||'und',fontsReady:document.fonts?.status==='loaded'},slots};
}

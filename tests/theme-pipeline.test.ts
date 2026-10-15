import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
// @ts-expect-error jsdom is already the project's runtime DOM dependency.
import { JSDOM } from 'jsdom';
import { compileCapture, packageFiles, REQUIRED_SLOTS, sanitizeCSS, sanitizeSVG } from '../tooling/theme-pipeline.mjs';
import { compareThemeMeasurements } from '../tooling/theme-visual-report.mjs';
import { materializeThemeTemplate } from '../packages/reader-view/src/template';

interface Tree { tag: string; slot?: string; action?: string; attrs?: Record<string,string>; css?: Record<string,string>; pseudo?: Record<string,Record<string,string>>; children?: Array<Tree|{text:string}> }
const typography={'font-size':'16px','line-height':'24px','font-family':'Arial'};
function fixture() {
  const tree:Tree={tag:'div',slot:'shell',css:{display:'flex','max-width':'100%'},children:[
    {tag:'aside',slot:'sidebar',children:[{tag:'nav',slot:'conversationList'}]},
    {tag:'header',slot:'header'},
    {tag:'main',slot:'scroller',children:[{tag:'div',slot:'userMessage'},{tag:'article',slot:'assistantMessage'}]},
    {tag:'form',slot:'composer'}
  ]};
  return {schemaVersion:2,origin:'https://chatgpt.com/private-history',state:'conversation-light-expanded',evidence:'synthetic',capturedAt:'2026-09-21',viewport:{width:1280,height:720},environment:{devicePixelRatio:2,zoom:1,language:'zh-CN',fontsReady:true},slots:Object.fromEntries(REQUIRED_SLOTS.map(name=>[name,{rect:{x:0,y:0,width:100,height:100},css:{...typography}}])),tree,missing:[] as string[],omissions:[] as string[],truncated:false,icons:{} as Record<string,string>};
}
function samplePage(options:{hiddenSidebar?:boolean}={}) {
  const dom=new JSDOM('<html lang="zh-CN"><body><div id="shell"><aside id="sidebar"><nav id="conversationList"><a href="/c/private-history" title="private account">private history</a></nav></aside><header id="header">private name</header><main id="scroller"><div id="userMessage">private prompt</div><article id="assistantMessage">private answer<img src="https://private.invalid/profile.png"></article></main><form id="composer" action="https://private.invalid/submit"><textarea>private draft</textarea></form></div></body></html>',{url:'https://chatgpt.com/c/private-history'});
  const document=dom.window.document as Document;
  const config={state:'conversation-light-expanded',zoom:1,slots:Object.fromEntries(REQUIRED_SLOTS.map(name=>[name,`#${name}`])),maxNodes:6000};
  for(const element of document.querySelectorAll('*')) Object.defineProperty(element,'getBoundingClientRect',{value:()=>({x:0,y:0,width:options.hiddenSidebar&&['sidebar','conversationList'].includes(element.id)?0:100,height:100})});
  const getStyle=(element:Element,pseudo?:string)=>pseudo?{content:'none'}:dom.window.getComputedStyle(element);
  const context={document,location:dom.window.location,getComputedStyle:getStyle,innerWidth:1280,innerHeight:720,devicePixelRatio:2,Element:dom.window.Element};
  const sampler=runInNewContext(readFileSync('tooling/capture-theme.browser.js','utf8')+'\ncaptureDisplayTheme;',context);
  return {document,config,sampler,context};
}

describe('theme capture and candidate boundary',()=>{
  it('consumes the tree, keeps flex constraints and emits every local slot once',()=>{
    const result=compileCapture(fixture());
    expect(result.manifest.runtimeReady).toBe(true);
    expect(result.manifest.evidence).toMatchObject({capture:'synthetic',realConversation:false,visualComparison:'missing'});
    expect(result.css).toContain('display:flex');
    expect(result.css).toContain('max-width:100%');
    for(const slot of REQUIRED_SLOTS)expect(result.html.match(new RegExp(`data-fv-slot="${slot}"`,'g'))).toHaveLength(1);
    expect(packageFiles(result)).toHaveProperty('theme-template.ts');
  });
  it('discards private text, source links/attributes, scripts, forms and arbitrary diagnostics at compile time',()=>{
    const input=fixture();
    input.tree.attrs={onclick:'private script',title:'private account',id:'private-id'};
    input.tree.children!.push({text:'private message'},{tag:'script',children:[{text:'private script'}]},{tag:'a',attrs:{href:'https://private.invalid'},children:[{text:'private link'}]});
    input.omissions=['private-user-name'];
    input.tree.pseudo={'::before':{content:'"private label"',color:'red'}};
    const output=JSON.stringify(packageFiles(compileCapture(input)));
    expect(output).not.toMatch(/private|onclick|https:\/\/private|<script|<form|href=/);
    expect(output).toContain('https://chatgpt.com');
    expect(output).not.toContain('/private-history');
  });
  it('rejects incomplete, duplicate and silently truncated templates',()=>{
    const input=fixture();input.missing=['assistantMessage'];expect(()=>compileCapture(input)).toThrow('incomplete-capture');
    input.missing=[];input.truncated=true;expect(()=>compileCapture(input)).toThrow('incomplete-capture');
    input.truncated=false;input.tree.children!.push({tag:'div',slot:'header'});expect(()=>compileCapture(input)).toThrow('ambiguous-slot:header');
    input.tree.children=input.tree.children!.filter(node=>!('slot'in node&&node.slot==='header'));expect(()=>compileCapture(input)).toThrow('missing-slot:header');
  });
  it('drops CSS executable/URL escapes and sanitizes SVG attributes and foreign content',()=>{
    expect(sanitizeCSS({color:'red','font-family':'Arial','background-color':'url(https://private.invalid)','border':'1px solid red; background: url(x)','--custom':'secret',width:'u\\72l(private)',content:'private'})).toEqual({color:'red','font-family':'Arial'});
    const svg=sanitizeSVG('<svg viewBox="0 0 20 20" onload="private"><script>private</script><foreignObject>private</foreignObject><text>private</text><use href="https://private.invalid"/><path d="M1 1 L2 2" stroke="currentColor" fill="url(#private)"/></svg>');
    expect(svg).toContain('viewBox="0 0 20 20"');expect(svg).toContain('d="M1 1 L2 2"');expect(svg).not.toMatch(/private|onload|<script|<use|foreignObject|<text/);
  });
  it('is deterministic even when CSS input keys are reordered',()=>{
    const a=fixture(),b=fixture();b.tree.css={'max-width':'100%',display:'flex'};
    expect(packageFiles(compileCapture(a))).toEqual(packageFiles(compileCapture(b)));
  });
  it('separates identical rendered shapes with different provenance into distinct candidates',()=>{
    const a=fixture(),b=fixture();b.evidence='rendered-dom';
    expect(compileCapture(a).manifest.contentHash).not.toBe(compileCapture(b).manifest.contentHash);
  });
  it('does not label another website as a real ChatGPT conversation or infer visual approval',()=>{
    const input=fixture();input.evidence='rendered-dom';input.origin='https://example.com';
    const other=compileCapture(input);expect(other.manifest.evidence.realConversation).toBe(false);
    input.origin='https://chatgpt.com';const target=compileCapture(input);expect(target.manifest.evidence.realConversation).toBe(true);
    target.manifest.status='approved';expect(target.manifest.evidence.visualComparison).toBe('missing');
  });
  it('rejects mapped actions that would be removed or made inert during content binding',()=>{
    const input=fixture();const sidebar=input.tree.children![0] as Tree;const list=sidebar.children![0] as Tree;
    list.children=[{tag:'button',action:'newConversation'}];expect(()=>compileCapture(input)).toThrow('action-in-replaced-slot');
  });
  it('rejects message flows that swallow persistent slots or clone unbound actions',()=>{
    const badHeader=fixture();const header=badHeader.tree.children!.splice(1,1)[0]!;const flow=badHeader.tree.children![1] as Tree;flow.children!.push(header);
    expect(()=>compileCapture(badHeader)).toThrow('unsafe-message-flow');
    const badAction=fixture();(badAction.tree.children![2] as Tree).children!.push({tag:'button',action:'privacy'});
    expect(()=>compileCapture(badAction)).toThrow('action-in-replaced-flow');
  });
  it('rejects missing geometry and drops invalid SVG data instead of persisting arbitrary strings',()=>{
    const input=fixture();input.slots.header!.rect.width=Number.NaN;
    expect(()=>compileCapture(input)).toThrow('invalid-measurement:header');
    const svg=sanitizeSVG('<svg viewBox="private"><path d="private" transform="private" fill="private" stroke-linecap="private"/><circle cx="private"/></svg>');
    expect(svg).not.toContain('private');
  });
  it('keeps schema 1 homepage measurements explicitly incomplete',()=>{
    const capture=JSON.parse(readFileSync('packages/theme-chatgpt/capture/public-home-light.json','utf8'));
    const result=compileCapture(capture);
    expect(result.html).toBe('');expect(result.manifest.runtimeReady).toBe(false);expect(result.manifest.missing).toContain('conversation-template');expect(result.manifest.evidence.realConversation).toBe(false);
  });
  it('sampler exports no source text/URLs and does not mutate the rendered page',()=>{
    const {sampler,document,config}=samplePage(),before=document.documentElement.outerHTML;
    const captured=sampler(config),output=JSON.stringify(captured);
    expect(output).not.toMatch(/private|#shell|\/c\//);expect(document.documentElement.outerHTML).toBe(before);
    expect(compileCapture(captured).manifest.runtimeReady).toBe(true);
  });
  it('preserves typed auto/percentage constraints instead of freezing layout to pixel geometry',()=>{
    const {sampler,document,config}=samplePage();
    for(const element of document.querySelectorAll('*'))Object.defineProperty(element,'computedStyleMap',{value:()=>new Map([['width',{toString:()=> '75%'}],['height',{toString:()=> 'auto'}]])});
    const result=sampler(config);expect(result.tree.css.width).toBe('75%');expect(result.tree.css.height).toBe('auto');
    expect(compileCapture(result).css).toContain('height:auto');expect(result.omissions).not.toContain('resolved-layout-fallback');
  });
  it('sampler fails for ambiguous/missing selectors and truncation without leaking selectors',()=>{
    const {sampler,config}=samplePage();
    expect(()=>sampler({...config,slots:{...config.slots,header:'[id]'}})).toThrow('ambiguous:header');
    expect(()=>sampler({...config,slots:{...config.slots,header:'#private-absent'}})).toThrow('missing:header');
    expect(()=>sampler({...config,maxNodes:2})).toThrow('truncated');
  });
  it('accepts present hidden sidebar structure only in a collapsed state',()=>{
    const {sampler,config}=samplePage({hiddenSidebar:true});
    expect(()=>sampler(config)).toThrow('missing:sidebar');
    expect(sampler({...config,state:'conversation-light-collapsed'}).slots.sidebar.visible).toBe(false);
  });
  it('writes immutable candidate files without touching active runtime output',()=>{
    const temp=mkdtempSync(path.join(tmpdir(),'folioveil-theme-test-'));
    const active=readFileSync('packages/theme-chatgpt/src/captured.ts','utf8');
    try {
      const args=['tooling/compile-theme.mjs','packages/theme-chatgpt/capture/public-home-light.json',`--out=${path.join(temp,'candidate')}`];
      const first=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));
      const second=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));
      expect(second.candidate).toBe(first.candidate);expect(first.activeThemeChanged).toBe(false);
      expect(readdirSync(first.candidate)).toEqual(expect.arrayContaining(['shell.html','theme.css','theme-template.ts','template-contract.ts','theme.json']));
      expect(readFileSync('packages/theme-chatgpt/src/captured.ts','utf8')).toBe(active);
    }finally{rmSync(temp,{recursive:true,force:true});}
  });
});

describe('local template materialization',()=>{
  it('requires approval and returns detached local nodes with shared slots',()=>{
    const doc=new JSDOM('').window.document as Document,template=compileCapture(fixture());
    expect(()=>materializeThemeTemplate(template,doc)).toThrow('unapproved');
    const replay=materializeThemeTemplate(template,doc,{allowCandidate:true});
    expect(replay.slots.scroller.contains(replay.slots.assistantMessage)).toBe(true);expect(replay.root.isConnected).toBe(false);
    template.manifest.status='approved';expect(materializeThemeTemplate(template,doc).fragment.children).toHaveLength(2);
  });
  it('rejects malicious HTML, URL CSS and text even when a manifest claims approval',()=>{
    const doc=new JSDOM('').window.document as Document;
    for(const html of ['<script>alert(1)</script>','<iframe src="https://example.com"></iframe>','<a href="https://example.com">x</a>','<form></form>','<img src=x>']){
      const template=compileCapture(fixture());template.manifest.status='approved';template.html=template.html.replace('</header>',html+'</header>');
      expect(()=>materializeThemeTemplate(template,doc)).toThrow();
    }
    const template=compileCapture(fixture());template.manifest.status='approved';template.css='.fv-n1{background-color:url(https://example.com)}';expect(()=>materializeThemeTemplate(template,doc)).toThrow('unsafe-css');
    template.css='';template.html=template.html.replace('</header>','private message</header>');expect(()=>materializeThemeTemplate(template,doc)).toThrow('source-text');
  });
  it('rejects invalid slot relationships independently of manifest slot claims',()=>{
    const doc=new JSDOM('').window.document as Document,template=compileCapture(fixture());template.manifest.status='approved';
    const html=doc.createElement('template');html.innerHTML=template.html;
    html.content.firstElementChild!.append(html.content.querySelector('[data-fv-slot="assistantMessage"]')!);template.html=html.innerHTML;
    expect(()=>materializeThemeTemplate(template,doc)).toThrow('invalid-slot-tree');
  });
});

describe('theme measurement evidence',()=>{
  it('never passes without an actual conversation reference',()=>{
    expect(compareThemeMeasurements(null,null).status).toBe('missing-reference');
    expect(compareThemeMeasurements(fixture(),fixture()).status).toBe('missing-reference');
    const wrongOrigin=fixture();wrongOrigin.evidence='rendered-dom';wrongOrigin.origin='https://example.com';expect(compareThemeMeasurements(wrongOrigin,fixture()).status).toBe('missing-reference');
  });
  it('reports measured deltas but leaves visual review explicitly unestablished',()=>{
    const reference=fixture();reference.evidence='rendered-dom';const replay=fixture();
    const report=compareThemeMeasurements(reference,replay);
    expect(report.status).toBe('measurements-passed');expect(report.visualComparison).toBe('not-established');expect(report.manualReviewRequired).toBe(true);
    replay.slots.header!.rect.x=5;const failed=compareThemeMeasurements(reference,replay);expect(failed.status).toBe('failed');expect(failed.checks).toContainEqual(expect.objectContaining({slot:'header',property:'x',difference:5,pass:false}));
  });
  it('refuses mismatched viewport or incomplete capture conditions',()=>{
    const reference=fixture();reference.evidence='rendered-dom';const replay=fixture();replay.viewport.width=390;
    expect(compareThemeMeasurements(reference,replay).status).toBe('failed');
    replay.viewport.width=1280;replay.environment.fontsReady=false;expect(compareThemeMeasurements(reference,replay).status).toBe('incomplete');
  });
  it('measures local generated slots without serializing reading content',()=>{
    const {document,context}=samplePage();for(const slot of REQUIRED_SLOTS)document.getElementById(slot)!.setAttribute('data-fv-slot',slot);
    const measure=runInNewContext(readFileSync('tooling/theme-measure.browser.js','utf8')+'\nmeasureDisplayTheme;',context);
    const result=measure(document,{state:'conversation-light-expanded',zoom:1});expect(JSON.stringify(result)).not.toMatch(/private/);expect(result.slots.header.rect.width).toBe(100);
  });
});

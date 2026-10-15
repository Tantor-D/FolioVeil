// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { compileCapture, REQUIRED_SLOTS } from '../tooling/theme-pipeline.mjs';
import { createChatGPTDisplayAdapter } from '../packages/theme-chatgpt/src/index';
import { ChatReaderShell } from '../packages/reader-view/src/chat-shell';
import { materializeThemeTemplate } from '../packages/reader-view/src/template';
import { DEFAULT_SETTINGS } from '../packages/storage/src/index';
import type { ReaderDocument } from '../packages/content-model/src/index';
import type { ThemeAction, ThemeSlot, ThemeTemplate } from '../packages/display-sdk/src/template';

interface Tree { tag: string; slot?: ThemeSlot; action?: ThemeAction; css?: Record<string,string>; children?: Array<Tree|{text:string}> }
const actions:ThemeAction[]=['toggleSidebar','newConversation','previous','next','privacy','showControls','returnSource'];
const TITLE='仅属于当前阅读的合成标题';
const TEXT='这是保持可选择复制的合成正文，不属于主题模板。';
const IMAGE='https://fixture.invalid/reading-image.png';
function generatedTemplate(wrapped=false):ThemeTemplate {
  const user:Tree={tag:'section',slot:'userMessage',css:{'border-radius':'23px',height:'auto'},children:[{text:'source user message must not survive'}]};
  const assistant:Tree={tag:'article',slot:'assistantMessage',css:{'line-height':'28px',height:'auto'},children:[{text:'source assistant history must not survive'}]};
  const tree:Tree={tag:'div',slot:'shell',css:{display:'flex'},children:[
    {tag:'aside',slot:'sidebar',children:[{tag:'nav',slot:'conversationList'}]},
    {tag:'section',css:{display:'flex','flex-direction':'column','flex-grow':'1'},children:[
      {tag:'header',slot:'header',children:actions.map(action=>({tag:'button',action}))},
      {tag:'main',slot:'scroller',children:[{tag:'div',children:wrapped?[
        {tag:'section',css:{display:'flex','justify-content':'flex-end'},children:[{tag:'div',css:{'max-width':'75%'},children:[user]}]},
        {tag:'section',css:{display:'flex','justify-content':'flex-start'},children:[{tag:'div',css:{'max-width':'760px'},children:[assistant]}]}
      ]:[user,assistant]}]},
      {tag:'form',slot:'composer',children:[{tag:'button'}]}
    ]}
  ]};
  return compileCapture({schemaVersion:2,origin:'https://chatgpt.com',state:'conversation-light-expanded',evidence:'synthetic',capturedAt:'2026-09-21',viewport:{width:1280,height:720},environment:{devicePixelRatio:2,zoom:1,language:'zh-CN',fontsReady:true},slots:Object.fromEntries(REQUIRED_SLOTS.map(slot=>[slot,{rect:{x:0,y:0,width:100,height:100},css:{'font-size':'16px','line-height':'24px','font-family':'Arial'}}])),tree,missing:[],omissions:[]});
}
function content():ReaderDocument {
  return {id:'synthetic-reading-document',title:TITLE,source:{kind:'fixture',url:'https://fixture.invalid/source',label:'合成来源'},blocks:[
    {id:'paragraph',type:'paragraph',html:`<strong>${TEXT}</strong>`},
    {id:'figure',type:'image',src:IMAGE,label:'图片 1',caption:'只在全图或临时看图显示的合成图注',resourceKind:'image'},
    {id:'last',type:'paragraph',html:'当前章节末尾合成段落。'}
  ],toc:[],warnings:[]};
}
const mounted:ChatReaderShell[]=[];
afterEach(()=>{for(const shell of mounted.splice(0))shell.unmount();vi.restoreAllMocks();vi.unstubAllGlobals();});
function mount(template=generatedTemplate()){
  vi.spyOn(document,'hasFocus').mockReturnValue(true);
  const callbacks={onSettings:vi.fn(),onRestore:vi.fn(),onPrivacyChange:vi.fn(),onNavigate:vi.fn()};
  const shell=createChatGPTDisplayAdapter(template,{previewCandidate:true}).create({...DEFAULT_SETTINGS},callbacks) as ChatReaderShell;
  mounted.push(shell);shell.mount();shell.setDocument(content());
  const action=(name:ThemeAction)=>shell.shadow.querySelector<HTMLButtonElement>(`[data-fv-action="${name}"]`)!;
  return {shell,template,callbacks,action,shadow:shell.shadow as ShadowRoot};
}

describe('generated ChatGPT template integration (synthetic evidence only)',()=>{
  it('requires explicit candidate preview and keeps evidence independent of manual approval',()=>{
    const template=generatedTemplate();
    expect(()=>createChatGPTDisplayAdapter(template).create({...DEFAULT_SETTINGS},{onSettings:vi.fn(),onRestore:vi.fn()})).toThrow('unapproved');
    const materialized=materializeThemeTemplate(template,document,{allowCandidate:true});
    expect(materialized.slots.userMessage.textContent).toBe('');expect(materialized.slots.assistantMessage.textContent).toBe('');
    template.manifest.status='approved';
    const shell=createChatGPTDisplayAdapter(template).create({...DEFAULT_SETTINGS},{onSettings:vi.fn(),onRestore:vi.fn()}) as ChatReaderShell;mounted.push(shell);
    expect(template.manifest.evidence).toMatchObject({capture:'synthetic',realConversation:false,visualComparison:'missing'});
  });
  it('binds actual content only to generated message slots and renders exactly twelve neutral sessions',()=>{
    const {shell,shadow,template}=mount();
    const user=shadow.querySelector('[data-fv-slot="userMessage"]')!,assistant=shadow.querySelector('[data-fv-slot="assistantMessage"]')!;
    expect(user.tagName).toBe('SECTION');expect(user.textContent).toBe(TITLE);expect(assistant.querySelector('strong')?.textContent).toBe(TEXT);
    expect(shadow.querySelectorAll('[data-fv-slot="userMessage"]')).toHaveLength(1);expect(shadow.querySelectorAll('[data-fv-slot="assistantMessage"]')).toHaveLength(1);
    for(const slot of ['header','sidebar','composer'])expect(shadow.querySelector(`[data-fv-slot="${slot}"]`)?.textContent).not.toMatch(new RegExp(`${TITLE}|${TEXT}`));
    expect(shadow.querySelectorAll('[data-fv-slot="conversationList"] .session')).toHaveLength(12);
    expect(shadow.textContent).not.toContain('source assistant history');expect(JSON.stringify(template)).not.toContain(TITLE);
    expect(assistant.querySelector('strong')!.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(shell.panel.hidden).toBe(true);expect(shell.panel.children).toHaveLength(0);
  });
  it('retains image modes and closes temporary preview without exposing the decorative composer',()=>{
    const {shell,shadow}=mount();
    const composer=shadow.querySelector('[data-fv-slot="composer"]')!;
    expect(shadow.querySelector('.image-block img')).toBeNull();expect(composer.hasAttribute('inert')).toBe(true);
    shadow.querySelector<HTMLButtonElement>('.image-trigger')!.click();
    expect(shell.isPreviewOpen()).toBe(true);expect(shadow.querySelector<HTMLImageElement>('.preview-body img')?.src).toBe(IMAGE);
    expect(shell.scroller.closest('[inert]')).not.toBeNull();shell.closePreview();
    expect(shell.scroller.closest('[inert]')).toBeNull();expect(composer.hasAttribute('inert')).toBe(true);expect(composer.getAttribute('aria-hidden')).toBe('true');
    shell.updateSettings({...DEFAULT_SETTINGS,imageMode:'thumbnail'});expect(shadow.querySelector('.mode-thumbnail img')).not.toBeNull();
    shell.updateSettings({...DEFAULT_SETTINGS,imageMode:'full'});expect(shadow.querySelector('.mode-full figcaption')?.textContent).toContain('合成图注');
    shell.updateSettings({...DEFAULT_SETTINGS,imageMode:'hidden'});expect(shadow.querySelector('.image-block img')).toBeNull();
  });
  it('preserves generated message shapes for neutral conversations and independent privacy',()=>{
    const {shell,shadow,action}=mount();
    const originalUserClass=shadow.querySelector('[data-fv-slot="userMessage"]')!.className;
    const originalAssistantClass=shadow.querySelector('[data-fv-slot="assistantMessage"]')!.className;
    action('newConversation').click();
    expect(shell.isReading()).toBe(false);expect(shadow.textContent).not.toContain(TEXT);
    expect(shadow.querySelector('[data-fv-slot="userMessage"]')?.className).toBe(originalUserClass);
    expect(shadow.querySelector('[data-fv-slot="assistantMessage"]')?.className).toBe(originalAssistantClass);
    shadow.querySelectorAll<HTMLButtonElement>('.session')[1]!.click();expect(shadow.textContent).toContain(TEXT);
    shell.togglePanel();shadow.querySelector<HTMLButtonElement>('.image-trigger')!.click();shell.setPrivacy(true);
    expect(shell.isPreviewOpen()).toBe(false);expect(shell.isPanelOpen()).toBe(false);expect(shadow.innerHTML).not.toContain(TEXT);expect(shadow.innerHTML).not.toContain(TITLE);expect(shadow.innerHTML).not.toContain(IMAGE);
    expect(shadow.querySelector('[data-fv-slot="userMessage"]')).not.toBeNull();expect(shadow.querySelector('[data-fv-slot="assistantMessage"]')).not.toBeNull();
    shell.togglePanel();expect(shell.getPrivacy()).toBe(true);expect(shadow.innerHTML).not.toContain(TEXT);
    shell.setPrivacy(false);expect(shadow.querySelector('[data-fv-slot="assistantMessage"]')?.textContent).toContain(TEXT);
  });
  it('binds persistent template actions once and keeps local viewport movement separate from source operations',()=>{
    const {shell,callbacks,action,shadow}=mount();
    action('toggleSidebar').click();expect(callbacks.onSettings).toHaveBeenLastCalledWith({sidebarCollapsed:true});
    expect(shadow.querySelector('.app')?.getAttribute('data-sidebar')).toBe('collapsed');
    action('showControls').click();expect(shell.isPanelOpen()).toBe(true);action('showControls').click();expect(shell.isPanelOpen()).toBe(false);
    Object.defineProperty(shell.scroller,'clientHeight',{value:500});Object.defineProperty(shell.scroller,'scrollHeight',{value:2000});
    action('next').click();expect(shell.scroller.scrollTop).toBe(420);action('previous').click();expect(shell.scroller.scrollTop).toBe(0);expect(callbacks.onNavigate).not.toHaveBeenCalled();
    action('privacy').click();expect(shell.getPrivacy()).toBe(true);action('privacy').click();expect(shell.getPrivacy()).toBe(false);
    action('returnSource').click();expect(callbacks.onRestore).toHaveBeenCalledTimes(1);
  });
  it('keeps complete sampled message branches while binding only their nested content slots',()=>{
    const template=generatedTemplate(true),sample=materializeThemeTemplate(template,document,{allowCandidate:true});
    const classes={userRoot:sample.messageBranches.user.className,userInner:sample.slots.userMessage.parentElement!.className,assistantRoot:sample.messageBranches.assistant.className,assistantInner:sample.slots.assistantMessage.parentElement!.className};
    const {shell,shadow,action}=mount(template);
    const assertBranches=()=>{
      const user=shadow.querySelector<HTMLElement>('[data-fv-slot="userMessage"]')!,assistant=shadow.querySelector<HTMLElement>('[data-fv-slot="assistantMessage"]')!;
      expect(user.parentElement?.className).toBe(classes.userInner);expect(user.parentElement?.parentElement?.className).toBe(classes.userRoot);
      expect(assistant.parentElement?.className).toBe(classes.assistantInner);expect(assistant.parentElement?.parentElement?.className).toBe(classes.assistantRoot);
      expect(user.classList.contains('title-bubble')).toBe(true);expect(assistant.classList.contains('reply')).toBe(true);
      expect(user.parentElement?.classList.contains('title-bubble')).toBe(false);expect(assistant.parentElement?.classList.contains('reply')).toBe(false);
    };
    assertBranches();expect(shadow.querySelector('[data-fv-slot="assistantMessage"] strong')?.textContent).toBe(TEXT);
    action('newConversation').click();assertBranches();expect(shadow.textContent).not.toContain(TEXT);
    shadow.querySelectorAll<HTMLButtonElement>('.session')[1]!.click();shell.setPrivacy(true);assertBranches();expect(shadow.textContent).not.toContain(TEXT);
    shell.setPrivacy(false);assertBranches();expect(shadow.querySelector('[data-fv-slot="userMessage"]')?.textContent).toBe(TITLE);
  });
  it('rejects a common message flow that would delete persistent header or sidebar structure',()=>{
    const template=generatedTemplate(true),holder=document.createElement('template');holder.innerHTML=template.html;
    const user=holder.content.querySelector('[data-fv-slot="userMessage"]')!,assistant=holder.content.querySelector('[data-fv-slot="assistantMessage"]')!;
    let flow=user.parentElement!;while(!flow.contains(assistant))flow=flow.parentElement!;
    flow.append(holder.content.querySelector('[data-fv-slot="header"]')!);template.html=holder.innerHTML;
    expect(()=>materializeThemeTemplate(template,document,{allowCandidate:true})).toThrow('unsafe-message-flow');
    expect(()=>createChatGPTDisplayAdapter(template,{previewCandidate:true}).create({...DEFAULT_SETTINGS},{onSettings:vi.fn(),onRestore:vi.fn()})).toThrow('unsafe-message-flow');
  });
  it('does not bind source adapters or browser source selectors into the display dependency graph',()=>{
    const inputs:string[]=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',"import {build} from 'esbuild';const result=await build({entryPoints:['packages/theme-chatgpt/src/index.ts'],bundle:true,write:false,metafile:true,platform:'browser',format:'esm',logLevel:'silent'});process.stdout.write(JSON.stringify(Object.keys(result.metafile.inputs)));"],{encoding:'utf8'}));
    expect(inputs.some(input=>/adapter-weread|adapter-arxiv|source-session|source-broker/.test(input))).toBe(false);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatReaderShell } from '../packages/reader-view/src/chat-shell';
import { DEFAULT_SETTINGS } from '../packages/storage/src/index';
import type { ReaderDocument } from '../packages/content-model/src/index';
import { captureReadingAnchor } from '../packages/reader-view/src/anchor';

// jsdom has no browser layout. These tests supply changing text/image geometry
// and exercise actual shell events; live resize/font rendering needs browser QA.
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const box=(top:number,height:number,width=500):DOMRect=>({x:0,y:top,top,bottom:top+height,left:0,right:width,width,height,toJSON:()=>({})}) as DOMRect;
function fixture(withImage=false, startAtTop=false) {
  let nextFrame=1;const frames=new Map<number,FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{const id=nextFrame++;frames.set(id,callback);return id;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  const flush=()=>{const queued=[...frames.values()];frames.clear();for(const callback of queued)callback(1);};
  const fonts=new EventTarget();const fontDescriptor=Object.getOwnPropertyDescriptor(document,'fonts');
  Object.defineProperty(document,'fonts',{configurable:true,value:fonts});
  cleanups.push(()=>{if(fontDescriptor)Object.defineProperty(document,'fonts',fontDescriptor);else Reflect.deleteProperty(document,'fonts');});
  const doc:ReaderDocument={id:'layout-document',title:'合成布局标题',source:{kind:'fixture'},blocks:[
    ...(withImage?[{id:'image',type:'image' as const,src:'https://fixture.invalid/image.png',label:'图片 1',caption:'合成图注',resourceKind:'image' as const}]:[]),
    {id:'paragraph',type:'paragraph',html:'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'}
  ],toc:[],warnings:[]};
  const shell=new ChatReaderShell({...DEFAULT_SETTINGS,imageMode:withImage?'full':'hidden'},{onSettings:vi.fn(),onRestore:vi.fn(),onNavigate:vi.fn()});
  shell.setDocument(doc);cleanups.push(()=>shell.unmount());
  const paragraph=shell.shadow.getElementById('paragraph')!;
  const layout={charsPerLine:5,lineHeight:10,precedingHeight:startAtTop?80:withImage?20:0,width:600,height:100};
  Object.defineProperties(shell.scroller,{clientWidth:{get:()=>layout.width},clientHeight:{get:()=>layout.height},scrollHeight:{get:()=>1000}});
  shell.scroller.getBoundingClientRect=()=>box(20,layout.height,layout.width);
  paragraph.getBoundingClientRect=()=>box(20+layout.precedingHeight-shell.scroller.scrollTop,Math.ceil(paragraph.textContent!.length/layout.charsPerLine)*layout.lineHeight);
  const view=shell.shadow.querySelector<HTMLElement>('.reading-view')!;
  view.getBoundingClientRect=()=>box(20-shell.scroller.scrollTop,layout.precedingHeight+Math.ceil(paragraph.textContent!.length/layout.charsPerLine)*layout.lineHeight);
  const imageBlock=shell.shadow.getElementById('image');if(imageBlock)imageBlock.getBoundingClientRect=()=>box(20-shell.scroller.scrollTop,layout.precedingHeight);
  const rangeDescriptor=Object.getOwnPropertyDescriptor(Range.prototype,'getBoundingClientRect');
  Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:function(this:Range){return box(20+layout.precedingHeight+Math.floor(this.startOffset/layout.charsPerLine)*layout.lineHeight-shell.scroller.scrollTop,layout.lineHeight);}});
  cleanups.push(()=>{if(rangeDescriptor)Object.defineProperty(Range.prototype,'getBoundingClientRect',rangeDescriptor);else delete (Range.prototype as Partial<Range>).getBoundingClientRect;});
  const userScroll=(top:number)=>{shell.scroller.dispatchEvent(new WheelEvent('wheel'));shell.scroller.scrollTop=top;shell.scroller.dispatchEvent(new Event('scroll'));};
  shell.mount();
  if (!startAtTop) userScroll(layout.precedingHeight+20);
  return {shell,layout,frames,flush,fonts,userScroll,doc};
}

describe('reading layout event anchoring',()=>{
  it.each(['loadingdone','loadingerror','resize'])('keeps the initial viewport at the top when %s changes layout above the first body block',event=>{
    const {shell,layout,flush,fonts}=fixture(false,true);
    expect(shell.scroller.scrollTop).toBe(0);
    expect(shell.getReadingAnchor()?.viewportOffset).toBe(80);
    layout.precedingHeight=137;layout.lineHeight=19;
    (event==='resize'?window:fonts).dispatchEvent(new Event(event));flush();
    expect(shell.scroller.scrollTop).toBe(0);
    layout.precedingHeight=65;layout.lineHeight=12;
    (event==='resize'?window:fonts).dispatchEvent(new Event(event));flush();
    expect(shell.scroller.scrollTop).toBe(0);
  });
  it('restores the top boundary if browser layout scroll is delivered before font completion',()=>{
    const {shell,layout,flush,fonts}=fixture(false,true);
    layout.precedingHeight=137;shell.scroller.scrollTop=23;
    shell.scroller.dispatchEvent(new Event('scroll'));fonts.dispatchEvent(new Event('loadingdone'));flush();
    expect(shell.scroller.scrollTop).toBe(0);
  });
  it('lets real user scroll cancel a queued top-boundary restore and then anchors that prose normally',()=>{
    const {shell,layout,frames,flush,fonts,userScroll}=fixture(false,true);
    layout.precedingHeight=137;fonts.dispatchEvent(new Event('loadingdone'));expect(frames.size).toBe(1);
    userScroll(157);expect(frames.size).toBe(0);flush();expect(shell.scroller.scrollTop).toBe(157);
    expect(shell.getReadingAnchor()?.offset).toBe(10);
    layout.lineHeight=20;fonts.dispatchEvent(new Event('loadingdone'));flush();
    expect(shell.scroller.scrollTop).toBe(177);expect(shell.getReadingAnchor()?.offset).toBe(10);
  });
  it('keeps the top after returning there manually or restoring reading after hidden layout changes',()=>{
    const {shell,layout,flush,fonts,userScroll}=fixture();
    userScroll(0);layout.precedingHeight=59;fonts.dispatchEvent(new Event('loadingdone'));flush();
    expect(shell.scroller.scrollTop).toBe(0);
    shell.setPrivacy(true);layout.precedingHeight=107;fonts.dispatchEvent(new Event('loadingdone'));flush();
    shell.setPrivacy(false);expect(shell.scroller.scrollTop).toBe(0);
  });
  it('keeps the last manually read character through resize and coalesces resize events',()=>{
    const {shell,layout,frames,flush}=fixture();expect(shell.getReadingAnchor()?.offset).toBe(10);
    layout.charsPerLine=2;layout.width=390;
    window.dispatchEvent(new Event('resize'));window.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(1);flush();expect(shell.scroller.scrollTop).toBe(50);expect(shell.getReadingAnchor()?.offset).toBe(10);
  });
  it('does not overwrite the pre-resize anchor when browser scroll is delivered first',()=>{
    const {shell,layout,flush}=fixture();layout.charsPerLine=2;layout.width=390;
    shell.scroller.dispatchEvent(new Event('scroll'));window.dispatchEvent(new Event('resize'));flush();
    expect(shell.scroller.scrollTop).toBe(50);expect(shell.getReadingAnchor()?.offset).toBe(10);
  });
  it('keeps the original character across resize roundtrips even when a new line starts earlier',()=>{
    const {shell,layout,flush}=fixture();
    const original=shell.getReadingAnchor()!,originalScroll=shell.scroller.scrollTop;
    expect(original.offset).toBe(10);
    const view=shell.shadow.querySelector<HTMLElement>('.reading-view')!;
    for(const charsPerLine of [3,4,7]) {
      layout.charsPerLine=charsPerLine;layout.width=390;
      window.dispatchEvent(new Event('resize'));flush();
      // Actual Range geometry now exposes an earlier character on the same line.
      expect(captureReadingAnchor(view,shell.scroller,'layout-document')!.offset).toBe(Math.floor(10/charsPerLine)*charsPerLine);
      expect(shell.getReadingAnchor()).toEqual(original);
      shell.scroller.dispatchEvent(new Event('scroll'));shell.scroller.dispatchEvent(new Event('scroll'));
      expect(shell.getReadingAnchor()).toEqual(original);
      layout.charsPerLine=5;layout.width=600;
      window.dispatchEvent(new Event('resize'));flush();shell.scroller.dispatchEvent(new Event('scroll'));
      expect(shell.scroller.scrollTop).toBe(originalScroll);expect(shell.getReadingAnchor()).toEqual(original);
    }
  });
  it('preserves prose when an earlier image loads or fails and changes its height',()=>{
    const {shell,layout,flush}=fixture(true);const image=shell.shadow.querySelector<HTMLImageElement>('.image-block img')!;
    layout.precedingHeight=120;image.dispatchEvent(new Event('load'));flush();expect(shell.scroller.scrollTop).toBe(140);expect(shell.getReadingAnchor()?.offset).toBe(10);
    layout.precedingHeight=20;image.dispatchEvent(new Event('error'));flush();expect(shell.scroller.scrollTop).toBe(40);expect(shell.getReadingAnchor()?.offset).toBe(10);
  });
  it('uses the saved semantic position after font completion changes line height',()=>{
    const {shell,layout,flush,fonts}=fixture();layout.lineHeight=20;fonts.dispatchEvent(new Event('loadingdone'));flush();
    expect(shell.scroller.scrollTop).toBe(40);expect(shell.getReadingAnchor()?.offset).toBe(10);
  });
  it('gives newer user scroll intent priority over a queued restore',()=>{
    const {shell,layout,frames,flush,userScroll}=fixture();layout.charsPerLine=2;layout.width=390;window.dispatchEvent(new Event('resize'));expect(frames.size).toBe(1);
    userScroll(80);expect(frames.size).toBe(0);flush();expect(shell.scroller.scrollTop).toBe(80);expect(shell.getReadingAnchor()?.offset).toBe(16);
  });
  it('records normal scrolling without forcing any restoration',()=>{
    const {shell,frames,userScroll}=fixture();userScroll(30);expect(shell.scroller.scrollTop).toBe(30);expect(shell.getReadingAnchor()?.offset).toBe(15);expect(frames.size).toBe(0);
  });
  it('never restores hidden reading DOM during privacy or a neutral conversation',()=>{
    const {shell,layout,frames,flush,fonts}=fixture();shell.setPrivacy(true);layout.charsPerLine=2;layout.width=390;
    window.dispatchEvent(new Event('resize'));fonts.dispatchEvent(new Event('loadingdone'));flush();expect(frames.size).toBe(0);expect(shell.shadow.querySelector('.reading-view')).toBeNull();expect(shell.getPrivacy()).toBe(true);
    shell.setPrivacy(false);expect(shell.scroller.scrollTop).toBe(50);
    shell.shadow.querySelectorAll<HTMLButtonElement>('.session')[0]!.click();layout.width=600;window.dispatchEvent(new Event('resize'));flush();expect(shell.isReading()).toBe(false);expect(shell.shadow.querySelector('.reading-view')).toBeNull();
  });
  it('invalidates pending layout work on document replacement and unmount',()=>{
    const {shell,layout,frames,flush,fonts,doc}=fixture();layout.width=390;window.dispatchEvent(new Event('resize'));expect(frames.size).toBe(1);
    shell.setDocument({...doc,id:'new-document'});expect(frames.size).toBe(0);flush();expect(shell.scroller.scrollTop).toBe(0);
    window.dispatchEvent(new Event('resize'));shell.unmount();expect(frames.size).toBe(0);fonts.dispatchEvent(new Event('loadingdone'));window.dispatchEvent(new Event('resize'));flush();expect(frames.size).toBe(0);expect(shell.host.isConnected).toBe(false);
  });
});

/* Authorized neutral ChatGPT sample only. Reads rendered DOM/CSSOM and downloads a sanitized clone. No original scripts or conversation identifiers are exported. */
(function(expectedPrompt, stateName){
 if(location.origin!=='https://chatgpt.com')throw Error('authorized origin required');
 const main=document.querySelector('main');
 const users=[...main?.querySelectorAll('.whitespace-pre-wrap')??[]].filter(node=>node.textContent===expectedPrompt);
 const assistants=[...main?.querySelectorAll('[class*="MarkdownRoot"]')??[]];
 const user=users[0],assistant=assistants[0];
 if(users.length!==1||assistants.length!==1||!user||!assistant)throw Error('exact neutral exchange required');
 if(!assistant.querySelector('h1')||!assistant.querySelector('blockquote')||!assistant.querySelector('table')||!assistant.querySelector('code,[class*="CodeBlock"]')||!assistant.querySelector('img')||!assistant.querySelector('[data-math-display]'))throw Error('required real templates missing');
 const styles=[...document.styleSheets].map((s,index)=>({index,href:s.href,media:s.media.mediaText,disabled:s.disabled,cssText:[...s.cssRules].map(r=>r.cssText).join('\n')}));
 const root=document.documentElement.cloneNode(true),body=root.querySelector('body'),cm=root.querySelector('main');
 const rail=root.querySelector('[data-app-navigation-rail]'),layers=rail?.parentElement?.parentElement;
 const stateNodes={layout:root.querySelector('.Layout-SYw9n4'),rail,railLayer:rail?.parentElement,sidebarLayer:layers?.children[1],sidebarContent:layers?.children[1]?.firstElementChild};
 if(!Object.values(stateNodes).every(Boolean)||layers?.children.length!==2)throw Error('current shell state nodes missing');
 for(const [name,node] of Object.entries(stateNodes))node.setAttribute('data-local-state-node',name);
 const redactions={historyRows:0,outsideText:0,attributes:0,profileImages:0,scripts:root.querySelectorAll('script').length,ids:0,draftTextNodes:0};
 root.querySelectorAll('script,noscript,iframe,object,embed,base,meta,dialog').forEach(n=>n.remove());
 root.querySelectorAll('link').forEach(n=>{if(!n.relList.contains('stylesheet'))n.remove()});
 root.querySelectorAll('style').forEach(n=>n.textContent='');
 const safe=new Set(['跳至内容','历史聊天记录','ChatGPT','新聊天','资料库','项目','定时任务','插件','站点','新','更多','置顶','最近','打开侧边栏','关闭侧边栏','搜索','个性化','保存聊天','临时聊天','关闭临时聊天','打开“个人资料”菜单','个人资料图片','分享','添加人员']);
 for(const link of body.querySelectorAll('a[href]'))if(/\/c\//.test(link.getAttribute('href')??'')){let first=true;const w=document.createTreeWalker(link,4);while(w.nextNode())if(w.currentNode.textContent.trim()){w.currentNode.textContent=first?`示例会话 ${++redactions.historyRows}`:'';first=false}}
 const w=document.createTreeWalker(body,132),comments=[];
 while(w.nextNode()){const n=w.currentNode;if(n.nodeType===8){comments.push(n);continue}const t=n.textContent.trim();if(!root.querySelector('[class*="MarkdownRoot"]')?.contains(n)&&!root.querySelector('main .whitespace-pre-wrap')?.contains(n)&&t&&!safe.has(t)&&!/^示例会话 \d+$/.test(t)){n.textContent='';redactions.outsideText++}}
 comments.forEach(n=>n.remove());
 const uuid=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
 const idMap=new Map(),reservedIds=new Set([...root.querySelectorAll('[id]')].map(n=>n.id));let idSequence=0;
 for(const n of root.querySelectorAll('[id]'))if(uuid.test(n.id)){const old=n.id;let replacement=idMap.get(old);if(!replacement){do{replacement=`local-neutral-id-${++idSequence}`}while(reservedIds.has(replacement));reservedIds.add(replacement);idMap.set(old,replacement)}n.id=replacement;redactions.ids++}
 const idRefAttributes=new Set(['aria-controls','aria-labelledby','aria-describedby','aria-owns','aria-activedescendant','aria-details','aria-errormessage','for','headers','list','form','popovertarget','commandfor','interestfor']);
 const localId=value=>{try{return idMap.get(decodeURIComponent(value))??idMap.get(value)}catch{return idMap.get(value)}};
 const localURLs=value=>value.replace(/url\(\s*(["']?)#([^"'()\s]+)\1\s*\)/gi,(original,quote,fragment)=>{const replacement=localId(fragment);return replacement?`url(${quote}#${replacement}${quote})`:original});
 // Rewrite only references to known IDs in this clone. External sprite/resource
 // URLs and unknown identifiers never acquire a new permission from this pass.
 for(const n of root.querySelectorAll('*'))for(const {name,value} of [...n.attributes]){
   let next=value;
   if(idRefAttributes.has(name))next=value.split(/\s+/).map(v=>localId(v)??v).join(' ');
   else if((name==='href'||name==='xlink:href')&&/^#[^\s"'<>]+$/.test(value)){const replacement=localId(value.slice(1));if(replacement)next=`#${replacement}`}
   next=localURLs(next);if(next!==value)n.setAttribute(name,next);
 }
 for(const style of styles)style.cssText=localURLs(style.cssText);
 for(const n of [root,...root.querySelectorAll('*')]){
   if(n.closest('[contenteditable]')||['input','textarea'].includes(n.localName))for(const name of ['aria-valuetext','value'])if(n.hasAttribute(name)){n.removeAttribute(name);redactions.attributes++}
   for(const {name,value} of [...n.attributes]){
     if(/^on/i.test(name)||['nonce','integrity','crossorigin','action','formaction','srcdoc','ping','autofocus','data-conversation-options-trigger','data-turn-id-container','data-turn-id'].includes(name)||/^data-.*(?:account|user-id|project-(?:id|label)|project-container-id|message-id|conversation-id|turn-(?:id|key)|search-unit-key|page-load-id|drop-key|sidebar-destination)/.test(name)||(name.startsWith('data-')&&/(?:\/c\/|@|https?:)/.test(value))||(uuid.test(value)&&name!=='id')){n.removeAttribute(name);redactions.attributes++}
     else if((name==='title'||name.startsWith('aria-')&&!idRefAttributes.has(name)&&!['aria-hidden','aria-expanded','aria-disabled','aria-pressed','aria-live','aria-atomic','aria-haspopup','aria-current','aria-orientation','aria-modal','aria-level','aria-valuenow','aria-valuemin','aria-valuemax'].includes(name))&&!cm.contains(n)&&!safe.has(value)){n.removeAttribute(name);redactions.attributes++}
   }
   if(n.localName==='a'){n.removeAttribute('href');n.removeAttribute('target')}
   if(n.localName==='img'&&!cm.contains(n)){n.removeAttribute('srcset');n.setAttribute('src','data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32"%3E%3Crect width="32" height="32" rx="16" fill="%23ddd"/%3E%3C/svg%3E');n.setAttribute('alt','本地头像');redactions.profileImages++}
   if(n.hasAttribute('contenteditable')){const draft=document.createTreeWalker(n,4);while(draft.nextNode()){if(draft.currentNode.textContent)redactions.draftTextNodes++;draft.currentNode.textContent=''}}
   if(['input','textarea'].includes(n.localName)){n.removeAttribute('value');if(n.localName==='textarea')n.textContent=''}
 }
 for(const img of cm.querySelectorAll('img')){const u=new URL(img.getAttribute('src')??'',location.origin);if(u.origin!=='https://www.w3.org'||u.pathname!=='/Icons/w3c_home.png'||u.search)throw Error('unexpected neutral image resource');img.removeAttribute('srcset')}
 const clonedUser=[...root.querySelectorAll('main .whitespace-pre-wrap')].find(node=>node.textContent===expectedPrompt);
 if(!clonedUser)throw Error('neutral user slot lost');
 clonedUser.setAttribute('data-local-slot','user');
 const ca=root.querySelector('main [class*="MarkdownRoot"]');ca.setAttribute('data-local-slot','assistant');
 const templates={};let templateIndex=0;for(const child of ca.children){const key=`block-${++templateIndex}`;child.setAttribute('data-local-template',key);templates[key]={selector:`[data-local-template="${key}"]`,tag:child.tagName,descendants:[...child.querySelectorAll('*')].map(n=>n.tagName).filter((v,i,a)=>a.indexOf(v)===i)}}
 const head=root.querySelector('head');[...head.children].forEach(n=>{if(n.localName!=='style'&&!(n.localName==='link'&&n.relList.contains('stylesheet')))n.remove()});
 const charset=document.createElement('meta');charset.setAttribute('charset','utf-8');head.append(charset);const vp=document.createElement('meta');vp.name='viewport';vp.content='width=device-width, initial-scale=1';head.append(vp);const title=document.createElement('title');title.textContent='FolioVeil 中性框架参考';head.append(title);
 function measure(n){const r=n.getBoundingClientRect(),c=getComputedStyle(n);return {x:r.x,y:r.y,width:r.width,height:r.height,fontFamily:c.fontFamily,fontSize:c.fontSize,lineHeight:c.lineHeight,color:c.color}}
 function rectangle(n){const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}
 // Evidence contains only numeric layout observations and reviewed public state
 // values. Do not copy selectors, URLs, text, arbitrary data attributes or drafts
 // from discovered nodes into these records. Browser zoom is not inferred from DPR.
 const publicValue=(value,allowed)=>value===null||value===''?null:allowed.includes(value)?value:'unknown';
 const scheme=value=>value===null||value===''?null:/^(?:normal|light|dark|only)(?:\s+(?:light|dark|only))*$/.test(value)?value:'unknown';
 const liveRoot=document.documentElement;
 const rootTheme={themeClasses:['light','dark'].filter(value=>liveRoot.classList.contains(value)),inlineColorScheme:scheme(liveRoot.style.colorScheme),computedColorScheme:scheme(getComputedStyle(liveRoot).colorScheme),chatTheme:publicValue(liveRoot.getAttribute('data-chat-theme'),['default','black','blue','green','yellow','pink','orange','purple','red']),contrast:publicValue(liveRoot.getAttribute('data-contrast'),['default','more','less','high','low']),coloredUserMessageBubbles:publicValue(liveRoot.getAttribute('data-ds-colored-user-message-bubbles'),['true','false'])};
 const sidebar=document.querySelector('#stage-slideover-sidebar');
 const scrollNodes=[...new Set([document.scrollingElement??liveRoot,...document.querySelectorAll('[data-scroll-root]'),...[...document.querySelectorAll('body *')].filter(n=>{const c=getComputedStyle(n);return (n.scrollHeight>n.clientHeight&&/^(auto|scroll|overlay)$/.test(c.overflowY))||(n.scrollWidth>n.clientWidth&&/^(auto|scroll|overlay)$/.test(c.overflowX))||n.scrollTop!==0||n.scrollLeft!==0})])];
 const scrollContainers=scrollNodes.map((n,index)=>({index,scope:n===(document.scrollingElement??liveRoot)?'document':n.matches('[data-scroll-root]')?'message-scroll-root':sidebar?.contains(n)?'sidebar':assistant.contains(n)?'assistant':main.contains(n)?'main':'other',scrollTop:n.scrollTop,scrollLeft:n.scrollLeft,scrollHeight:n.scrollHeight,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,clientWidth:n.clientWidth,rectangle:rectangle(n)}));
 function sidebarEvidence(n){const r=rectangle(n),c=getComputedStyle(n);let visibleByLayout=r.width>0&&r.height>0&&r.x+r.width>0&&r.y+r.height>0&&r.x<innerWidth&&r.y<innerHeight;
   for(let p=n;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number.parseFloat(s.opacity)===0)visibleByLayout=false}
   return {rectangle:r,visibleByLayout,display:c.display,visibility:c.visibility,opacity:c.opacity,inert:n.hasAttribute('inert'),inertByAncestor:!!n.parentElement?.closest('[inert]'),state:publicValue(n.getAttribute('data-state'),['open','closed'])};
 }
 const sidebars=['#stage-slideover-sidebar','#stage-sidebar-tiny-bar','#stage-slideover-sidebar > div > div'].map(selector=>({selector,nodes:[...document.querySelectorAll(selector)].map(sidebarEvidence)}));
 const images=[...main.querySelectorAll('img')].map((n,index)=>({index,complete:n.complete,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight,rectangle:rectangle(n)}));
 const fontStatus=publicValue(document.fonts?.status??'unknown',['loading','loaded']);
 const artifact={schemaVersion:1,source:{url:'https://chatgpt.com/',capturedAt:new Date().toISOString(),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},browserZoom:'unknown',fontStatus,state:stateName,note:'Ordinary authorized Edge profile and neutral single exchange; normal rendered DOM/CSSOM only; account/history/identifiers sanitized before export.'},html:'<!doctype html>'+root.outerHTML,styles,slots:{user:'[data-local-slot="user"]',assistant:'[data-local-slot="assistant"]'},templates,measurements:{user:measure(user),assistant:measure(assistant),main:measure(main),rootTheme,scrollContainers,sidebars,images},redactions};
 const blob=new Blob([JSON.stringify(artifact)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`folioveil-neutral-${stateName}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);console.log('FV_CAPTURE',JSON.stringify({filename:link.download,bytes:blob.size,styles:styles.length,templates,redactions}));
})("FolioVeil 中性排版样本 050。请只输出中文排版示例，不使用任何个人资料，不做网页搜索。主题是整理书桌。请依次包含：一级到六级标题各一个；一个约300字的普通长段落（含加粗、斜体与行内代码）；一个短段落；一段引用；三项有序列表；三项无序列表；两列三行的简单表格；一个含3行的 Python 代码块；一段含真正排版的行内数学公式 \\(a^2+b^2=c^2\\) 的文字，以及真正排版的独立数学公式 \\[E=mc^2\\]（请用反斜杠加括号/方括号的数学分隔符，不要用美元符号或代码块展示公式源码）。最后请用普通 Markdown 图片语法展示这张公开中性图片，地址为 https://www.w3.org/Icons/w3c_home.png ，替代文字为“中性标志”。不要新增其他内容。", window.__fvCaptureState ?? "desktop-light-expanded-complete");

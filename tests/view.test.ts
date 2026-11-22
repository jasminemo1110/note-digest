import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {readingSnapshot,snapshot,translationInsertion,type DigestResult} from '../src/core';
import {proseText} from '../src/markdown-source';
import {planArticleSummary,sectionAt,selectDigestBatch} from '../src/article-summary';
import {changeSectionTranslation} from '../src/section-translation';
const bundled=await build({entryPoints:['src/view.ts'],bundle:true,write:false,format:'cjs',external:['obsidian'],platform:'node'});
function setup() {
  const dom=new JSDOM('<body></body>');const document=dom.window.document;
  const prototype=dom.window.HTMLElement.prototype as any;
  prototype.empty=function(){this.replaceChildren();};
  prototype.addClass=function(cls:string){this.classList.add(cls);};
  prototype.createEl=function(tag:string,options:any={}){
    const el=document.createElement(tag);if(options.text!==undefined)el.textContent=options.text;
    if(options.cls)el.className=options.cls;if(options.value!==undefined)(el as any).value=options.value;
    for(const [key,value] of Object.entries(options.attr??{}))el.setAttribute(key,String(value));
    this.append(el);return el;
  };
  prototype.createDiv=function(options:any){return this.createEl('div',options);};
  const calls:any[]=[];
  const app={workspace:{getActiveFile:()=>null,openLinkText:async()=>{}},vault:{getAbstractFileByPath:()=>null}};
  class ItemView {contentEl=document.createElement('div');app=app;constructor(){document.body.append(this.contentEl);}}
  const module={exports:{} as any};
  new Function('require','module','exports',bundled.outputFiles[0].text)(()=>({ItemView}),module,module.exports);
  const plugin={collection:{recordsFor:()=>[],notePathFor:()=>undefined,matchingWords:async():Promise<any[]>=>[],updateExplanation:async(...args:any[])=>{calls.push(["update",...args]);return "已更新单词卡";}},run:async(...args:any[])=>calls.push(['run',...args]),collect:async(...args:any[])=>{calls.push(['collect',...args]);return {text:'已保存',duplicate:false};},removeNotes:async(...args:any[])=>{calls.push(['removeNotes',...args]);return '已删除';},insert:async(...args:any[])=>calls.push(['insert',...args]),
    summarizeCurrentArticle:(...args:any[])=>calls.push(['summarize',...args]),
    summarizeSelection:(...args:any[])=>calls.push(['summarizeSelection',...args]),
    retryDigest:(...args:any[])=>calls.push(['retry',...args]),
    openDigestBatch:(...args:any[])=>calls.push(['openBatch',...args]),
    translateSection:(...args:any[])=>calls.push(['translateSection',...args]),
    returnToDigest:(...args:any[])=>calls.push(['return',...args]),
    saveOverview:async (article:any)=>{calls.push(['saveOverview',article]);return {article};},
    writeSectionTranslation:async (article:any,index:number,paragraphs:any,undo:boolean)=>{
      calls.push(['writeSectionTranslation',index,undo]);
      return changeSectionTranslation(article,sectionAt(article,index),paragraphs,undo);
    },
    runSelectionAction:(action:any,selection:any)=>calls.push(['run',selection,action]),stopArticleSummary:()=>calls.push(['stop']),revealArticlePart:(...args:any[])=>calls.push(['locate',...args])};
  return {view:new module.exports.DigestView({},plugin),document,calls,plugin};
}
const selected=snapshot('a.md','A compelling argument.','compelling');
const explained:DigestResult={translation:'有说服力的',pronunciation:'/kəmˈpelɪŋ/',meaning:'含义',usage:'用法',example:'例句',assessment:{status:'natural',explanation:'不应显示这句话',correction:null}};
test('base headword leads explanation and collection while saving keeps the original selection', async () => {
  const {view,document,calls,plugin}=setup();
  const selection=snapshot('a.md','Interpreting Research Findings','Interpreting');
  const result={...explained,headword:'interpret',translation:'解读',pronunciation:'/ɪnˈtɜːprɪt/'};
  plugin.collection.recordsFor=(()=>[{id:'saved',kind:'word',anchor:{text:'Interpreting'},result,active:true,savedTo:['a.md']}]) as any;
  view.render(selection,result);
  assert.equal(document.querySelector('h3.note-digest-original')?.textContent,'interpret');
  assert.match(document.body.textContent!,/原文词形：Interpreting/);
  assert.equal(document.querySelector('blockquote')?.textContent,selection.context);
  assert.equal(document.querySelector('.note-digest-saved-row p')?.textContent,'interpret');
  const save=document.querySelector('.note-digest-save button') as HTMLButtonElement;
  await save.onclick!(new (domEvent(document))('click') as any);
  assert.deepEqual(calls[0],['collect',selection,result,'word','both']);
  view.render(selection,{...result,headword:null});
  assert.equal(document.querySelector('h3.note-digest-original')?.textContent,'Interpreting');
  assert.ok(!document.body.textContent!.includes('原文词形：'));
});
test('toolbar precedes original; insert buttons directly follow translation; save defaults to both',async()=>{
  const {view,document,calls}=setup();view.render(selected,{translation:'有说服力的'});
  const toolbar=document.querySelector('.note-digest-toolbar')!;const original=document.querySelector('.note-digest-original')!;
  assert.ok(toolbar.compareDocumentPosition(original)&4);
  assert.equal(document.querySelector('.note-digest-word-row')?.textContent,'有说服力的在选区后加括号');
  assert.match(document.body.textContent!,/音标暂不可用/);
  assert.doesNotMatch(document.body.textContent!,/添加到原文下方/);
  assert.equal(document.querySelector('.note-digest-save .note-digest-insert'),null);
  assert.equal((document.querySelector('[aria-label="收藏保存位置"]') as HTMLSelectElement).value,'both');
  const save=document.querySelector('.note-digest-save button') as HTMLButtonElement;assert.equal(save.textContent,'保存');
  await save.onclick!(new (domEvent(document))('click') as any);
  assert.equal(calls[0][3],'quote');assert.equal(calls[0][4],'both');
});
test('word translation inserts either IPA or meaning independently at the word boundary and prevents duplicates', async () => {
  const source = '**今日主题：生态演替与自然恢复（Ecological Succession & Natural Recovery）**\n';
  const selection = snapshot('a.md', source, 'Natural ');
  const translation = {translation:'自然的（自然形成） [形容词] | 天生的', wordPronunciation:{uk:'/ˈnætʃ.ər.əl/', us:'/ˈnætʃ.ɚ.əl/'}};
  const annotations = {
    音标:String.raw`（英 /ˈnætʃ\.ər\.əl/ · 美 /ˈnætʃ\.ɚ\.əl/）`,
    含义:String.raw`（自然的（自然形成） \[形容词\] &#124; 天生的）`,
  };

  for (const [first, second] of [['音标','含义'], ['含义','音标']] as const) {
    const {view,document,calls,plugin} = setup();
    let written = source;
    Object.assign(plugin, {insert: async (selection: Parameters<typeof translationInsertion>[1], text: string) => {
      const receipt = translationInsertion(written, selection, text, 'inline');
      written = receipt.after;
      return receipt;
    }});
    const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="在选区后加括号（${label}）"]`)!;
    const insert = async (label: string) => {
      const control = button(label);
      assert.equal(control.disabled, false);
      await control.onclick!(new (domEvent(document))('click') as any);
    };

    view.render(selection, translation);
    assert.equal(document.querySelector('.note-digest-word-translation h3')?.textContent, 'Natural');
    assert.deepEqual([...document.querySelectorAll('.note-digest-word-row p')].map(node=>node.textContent),
      ['英 /ˈnætʃ.ər.əl/ · 美 /ˈnætʃ.ɚ.əl/', translation.translation]);
    assert.equal(written, source);
    await insert(first);
    assert.equal(written, source.replace('Natural ', 'Natural'+annotations[first]+' '));
    assert.equal(button(first).disabled, true);
    await insert(second);
    assert.equal(written, source.replace('Natural ', 'Natural'+annotations[second]+annotations[first]+' '));
    assert.equal(button(first).disabled, true);
    assert.equal(button(second).disabled, true);

    [...document.querySelectorAll('button')].find(button=>button.textContent==='重新生成')!.click();
    const [, regenerated, mode, force] = calls.at(-1);
    assert.equal(regenerated.source, written);
    assert.equal(regenerated.text, 'Natural');
    assert.equal(regenerated.context, selection.context);
    assert.equal(mode, 'translate');
    assert.equal(force, true);

    const paragraph = proseText(written);
    const reopened = readingSnapshot('a.md', written, 'Natural', {
      section:{lineStart:0,lineEnd:0,text:written},
      paragraph, offset:paragraph.indexOf('Natural'), tag:'p',
    });
    assert.equal(reopened.start, written.indexOf('Natural'));
    view.render(reopened, translation);
    assert.match(button(first).title, /已包含/);
    assert.match(button(second).title, /已包含/);
  }
});

test('shared UK and US IPA is shown once, and phrase translation keeps the existing controls', () => {
  const {view,document} = setup();
  view.render(selected, {translation:'有说服力的', wordPronunciation:{uk:'/kəmˈpelɪŋ/', us:'/kəmˈpelɪŋ/'}});
  assert.equal(document.querySelector('.note-digest-word-row p')?.textContent, '/kəmˈpelɪŋ/');
  assert.equal(document.querySelectorAll('.note-digest-word-row button').length, 2);

  const phrase = snapshot('a.md', 'A compelling argument.', 'compelling argument');
  view.render(phrase, {translation:'有说服力的论点'});
  assert.equal(document.querySelector('.note-digest-word-row'), null);
  assert.deepEqual([...document.querySelectorAll('.note-digest-insert button')].map(button=>button.textContent),
    ['添加到原文下方', '在选区后加括号']);
});
function domEvent(document:Document):typeof Event{return document.defaultView!.Event;}
test('explanation hides insertion and natural assessment but still saves a full word card',()=>{
  const {view,document}=setup();view.render(selected,explained);
  assert.equal(document.querySelector('.note-digest-insert'),null);assert.ok(!document.body.textContent!.includes('不应显示这句话'));
  assert.equal((document.querySelector('[aria-label="收藏分类"]') as HTMLSelectElement).value,'word');
  view.render(selected,{...explained,assessment:{status:'incorrect',explanation:'有语法问题',correction:'corrected expression'}});
  assert.ok(document.body.textContent!.includes('有语法问题'));assert.ok(document.body.textContent!.includes('corrected expression'));
});
test('other common usages appear after contextual explanation and are hidden for an empty list', () => {
  const {view,document} = setup();
  const selection = snapshot('a.md','They issued a statement.','issued');
  const explanation = {...explained,headword:'issue',translation:'发布',example:'issue a statement（发表声明）'};
  view.render(selection,{...explanation,commonUsages:[{partOfSpeech:'名词',meaning:'问题',example:'a serious issue（一个严重的问题）'}],
    wordFamily:[{word:'issuance',partOfSpeech:'名词',meaning:'发行；发布'}]});
  const headings = Array.from(document.querySelectorAll('h3'), heading => heading.textContent);
  assert.ok(headings.indexOf('例句') < headings.indexOf('其他常见用法'));
  assert.equal(document.querySelector('ul li strong')?.textContent,'名词 · 问题');
  assert.match(document.querySelector('ul li')!.textContent!,/a serious issue/);
  assert.ok(headings.indexOf('其他常见用法') < headings.indexOf('同族词'));
  assert.match(document.body.textContent!,/issuance · 名词 · 发行/);
  view.render(selection,{...explanation,commonUsages:[]});
  assert.doesNotMatch(document.body.textContent!,/其他常见用法/);
  assert.doesNotMatch(document.body.textContent!,/同族词/);
});

test('a Claudian excerpt keeps the selected part of an explanation with its original sentence', () => {
  const {view, document} = setup();
  view.render(selected, {...explained, meaning:'强调论据确实有说服力。'});
  const paragraph = Array.from(document.querySelectorAll('p')).find(el => el.textContent?.startsWith('强调'))!;
  const range = document.createRange();
  range.setStart(paragraph.firstChild!, 2);
  range.setEnd(paragraph.firstChild!, 6);
  const selection = document.getSelection()!;
  selection.addRange(range);
  const {region, excerpt} = view.claudianExcerpt(selection);
  assert.deepEqual(excerpt, {source:'A compelling argument.', text:'论据确实'});

  const save = document.querySelector('.note-digest-save button')!;
  range.setEnd(save.firstChild!, 1);
  assert.equal(view.claudianExcerpt(selection), undefined);
  view.render();
  assert.equal(region.isConnected, false);
});

test('Claudian excerpts pair a translation or section summary with its own source', () => {
  const {view, document} = setup();
  const excerptFrom = (node: Element) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return view.claudianExcerpt(selection)?.excerpt;
  };
  const source = 'First.\n\nSecond.';
  view.render(snapshot('a.md', source, source), {translation:'第一。\n\n第二。', paragraphs:[
    {source:'First.', start:0, end:6, translation:'第一。'},
    {source:'Second.', start:8, end:15, translation:'第二。'},
  ]});
  assert.deepEqual(excerptFrom(document.querySelectorAll('.note-digest-paragraph .note-digest-result')[1]),
    {source:'Second.', text:'第二。'});

  const article = {
    ...planArticleSummary('Clippings/Essay.md', '# First\nOne.\n# Second\nTwo.'),
    overview:'全文概览正文',
    sections:[{title:'第一节', summary:'第一节摘要'}, {title:'第二节', summary:'第二节摘要'}],
  };
  view.renderArticleSummary(article.path, article);
  const results = document.querySelectorAll('.note-digest-result');
  assert.deepEqual(excerptFrom(results[0]), {title:'Essay', text:'全文概览正文'});
  assert.deepEqual(excerptFrom(results[2]), {title:'Essay · 第二节', source:'# Second\nTwo.', text:'第二节摘要'});
});

test('long selection stays blank until chosen action, then displays aligned bilingual paragraphs',()=>{
  const {view,document}=setup();const long=snapshot('a.md','First.\n\nSecond.','First.\n\nSecond.');
  view.render(long,undefined,'','idle');assert.ok(!document.body.textContent!.includes('First.'));assert.ok(document.body.textContent!.includes('Digest 选中段落'));assert.equal(document.querySelector('.note-digest-save'),null);
  view.render(long,{translation:'第一。\n\n第二。',paragraphs:[{source:'First.',start:0,end:6,translation:'第一。'},{source:'Second.',start:8,end:15,translation:'第二。'}]});
  const pairs=document.querySelectorAll('.note-digest-paragraph');assert.equal(pairs.length,2);assert.ok(pairs[0].textContent!.startsWith('First.第一。'));assert.ok(pairs[1].textContent!.startsWith('Second.第二。'));
  view.render(long,{translation:'',summary:'摘要内容'},'','summarize');assert.ok(document.body.textContent!.includes('摘要内容'));assert.equal(document.querySelector('.note-digest-save'),null);
});

test('full summary is reachable without selecting text and partial results offer stop, locate and resume', () => {
  const {view, document, calls} = setup();
  const button = (text: string) => [...document.querySelectorAll('button')].find(button => button.textContent === text)!;
  view.render();
  assert.equal(calls.length, 0);
  button('Digest 全文').click();
  const article = {...planArticleSummary('Clippings/Long Essay.md', '# First\nOne.\n# Second\nTwo.'), sections: [{title: '<img src=x>', summary: '第一节内容'}]};
  view.renderArticleSummary(article.path, article, '正在总结第 2/2 节…', true);
  assert.match(document.body.textContent!, /部分摘要 · 已完成 1\/2 节/);
  assert.ok(!document.querySelector('img, .note-digest-save'));
  assert.ok(!document.body.textContent!.includes('全文概览'));
  button('定位原文').click();
  button('停止摘要').click();
  button('继续摘要').click();
  assert.deepEqual(calls, [['summarize'], ['locate', article, article.parts[0]], ['stop'], ['retry', article]]);
});

test('short actions come first in both selection and Digest views and use the remembered selection as fallback', () => {
  const {view, document, calls} = setup();
  const toolbarButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.note-digest-toolbar button'));
  const order = ['翻译', '语境解释', 'Digest 全文', 'Digest 选中段落'];
  view.render(selected, explained);
  assert.deepEqual(toolbarButtons().map(button => button.textContent), order);
  assert.equal(toolbarButtons()[1].getAttribute('aria-pressed'), 'true');
  toolbarButtons()[2].click();
  assert.deepEqual(calls.at(-1), ['summarize']);
  view.renderArticleSummary(selected.path, undefined, '正在读取正文…', true);
  assert.deepEqual(toolbarButtons().map(button => button.textContent), order);
  assert.equal(toolbarButtons()[2].getAttribute('aria-pressed'), 'true');
  const down = new document.defaultView!.MouseEvent('mousedown', {bubbles:true, cancelable:true});
  toolbarButtons()[1].dispatchEvent(down);
  assert.ok(down.defaultPrevented);
  toolbarButtons()[1].click();
  assert.deepEqual(calls.at(-1), ['run', selected, 'explain']);
  toolbarButtons()[3].click();
  assert.deepEqual(calls.at(-1), ['summarizeSelection', selected]);

  view.renderArticleSummary('other.md', undefined, '正在读取正文…', true);
  toolbarButtons()[0].click();
  assert.deepEqual(calls.at(-1), ['run', undefined, 'translate']);
});

test('section actions open a separate bilingual page and return to the original summary position', async () => {
  const {view, document, calls} = setup();
  const source = '# First\nOne.\n# Second\nTwo.';
  const article = {...planArticleSummary('a.md', source), overview:'全文',
    sections:[{title:'第一节',summary:'一'}, {title:'第二节',summary:'二'}]};
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;
  view.renderArticleSummary(article.path, article);
  view.contentEl.scrollTop = 142;
  button('翻译本节').click();
  assert.deepEqual(calls.at(-1), ['translateSection', article, 0, 142]);
  await button('添加到文首').onclick!(new (domEvent(document))('click') as any);
  assert.deepEqual(calls.at(-1), ['saveOverview', article]);
  view.renderSectionTranslation(article, 0, 142, [{source:'One.',translation:'一。',start:8,end:12}]);
  assert.equal(document.querySelector('.note-digest-paragraph')?.textContent, 'One.一。');
  button('重新生成').click();
  assert.deepEqual(calls.at(-1), ['translateSection', article, 0, 142, true]);
  button('返回摘要').click();
  assert.deepEqual(calls.at(-1), ['return', view, article, 142]);
});

test('bilingual page locates the section and switches between writing and one-click undo', async () => {
  const {view, document, calls} = setup();
  const article = planArticleSummary('a.md', '# Body\n\nFirst.\n\n**Notes**\n\nEndnote.');
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(control => control.textContent === text)!;
  view.renderArticleSummary(article.path, {...article, sections:[{title:'正文',summary:'正文摘要'}], overview:'全文概览'});
  const notes = document.querySelector('.note-digest-supplement')!;
  assert.match(notes.textContent!, /Notes定位原文翻译本节/);
  const index = article.parts.length;
  const paragraphs = [{source:'Notes',translation:'注释',start:15,end:24}, {source:'Endnote.',translation:'注释。',start:27,end:35}];
  view.renderSectionTranslation(article, index, 42, paragraphs);
  button('定位原文').click();
  assert.deepEqual(calls.at(-1), ['locate', article, article.supplements![0]]);
  assert.equal(document.querySelector('h3')?.textContent, 'Notes');
  const event = new (domEvent(document))('click') as any;
  await button('将本节译文加入原文').onclick!(event);
  assert.deepEqual(calls.at(-1), ['writeSectionTranslation', index, false]);
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /已逐段加入本节译文/);
  await button('撤销加入译文').onclick!(event);
  assert.deepEqual(calls.at(-1), ['writeSectionTranslation', index, true]);
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /已撤销本节译文/);
  assert.ok(button('将本节译文加入原文'));
});

test('oversized articles show a local plan and let the reader start and continue by batch', () => {
  const {view, document, calls} = setup();
  const source = Array.from({length:42}, (_, i) => `## Chapter ${i + 1}\n\nText.`).join('\n\n');
  const article = planArticleSummary('Book.md', source);
  const button = (label: string) => [...document.querySelectorAll('button')].find(el => el.textContent === label);
  view.renderArticleBatchPlan(article);
  assert.equal(calls.length, 0);
  assert.match(document.body.textContent!, /正文共 42 节，已按原文顺序分为 2 篇/);
  assert.match(document.querySelector('details')?.textContent ?? '', /Chapter 41 — Chapter 42/);
  button('从第 1 篇开始')!.click();
  assert.deepEqual(calls.at(-1), ['openBatch', article, 0]);
  const first = {...selectDigestBatch(article, 0), overview:'本篇摘要'};
  view.renderArticleSummary(article.path, first);
  assert.match(document.body.textContent!, /第 1 \/ 2 篇/);
  assert.equal(document.querySelector('h4')?.textContent, '本篇概览');
  button('下一篇')!.click();
  assert.deepEqual(calls.at(-1), ['openBatch', first, 1]);
  const next = selectDigestBatch(article, 1);
  view.renderArticleSummary(article.path, next, '已停止');
  button('重试摘要')!.click();
  assert.deepEqual(calls.at(-1), ['retry', next]);
  button('上一篇')!.click();
  assert.deepEqual(calls.at(-1), ['openBatch', next, 0]);
  assert.equal(button('下一篇'), undefined);
});


test('inactive retained card exposes independent delete button and invokes only explicit deletion',async()=>{
  const {view,document,calls,plugin}=setup();
  (plugin.collection as any).recordsFor=()=>[{id:'saved-word',kind:'word',anchor:{text:'compelling'},result:{translation:'有说服力的'},active:false,savedTo:['a.md']}];
  view.render(selected,{translation:'有说服力的'});
  const buttons=[...document.querySelectorAll('button')];
  const cancel=buttons.find(button=>button.textContent==='取消收藏高亮')!;
  const erase=buttons.find(button=>button.textContent==='取消高亮并删除笔记')!;
  assert.equal(cancel.disabled,true);assert.equal(erase.disabled,false);assert.equal(calls.length,0);
  await erase.onclick!(new (domEvent(document))('click') as any);
  assert.deepEqual(calls[0],['removeNotes','saved-word']);assert.ok(document.body.textContent!.includes('已删除'));
});

test('insert then explain uses updated source and original English context without another Digest',async()=>{
  const {view,document,calls,plugin}=setup();
  (plugin as any).insert=async(selection:any,translation:string,mode:any)=>translationInsertion(selection.source,selection,translation,mode);
  view.render(selected,{translation:'有说服力的'});
  const insert=[...document.querySelectorAll('button')].find(button=>button.textContent==='在选区后加括号')!;
  await insert.onclick!(new (domEvent(document))('click') as any);
  const explain=[...document.querySelectorAll('button')].find(button=>button.textContent==='语境解释')!;
  explain.click();
  assert.equal(calls[0][0],'run');assert.equal(calls[0][2],'explain');
  assert.equal(calls[0][1].source,'A compelling（有说服力的） argument.');
  assert.equal(calls[0][1].text,'compelling');assert.equal(calls[0][1].context,selected.context);
});
test('failed insertion leaves original selection usable and restores controls',async()=>{
  const {view,document,calls,plugin}=setup();(plugin as any).insert=async()=>undefined;
  view.render(selected,{translation:'有说服力的'});
  const insert=[...document.querySelectorAll('button')].find(button=>button.textContent==='在选区后加括号')!;
  await insert.onclick!(new (domEvent(document))('click') as any);
  const explain=[...document.querySelectorAll('button')].find(button=>button.textContent==='语境解释')!;
  assert.equal(explain.disabled,false);explain.click();assert.equal(calls[0][1].source,selected.source);
});
test('late insertion response cannot replace a newer selected word in the sidebar',async()=>{
  const {view,document,calls,plugin}=setup();let finish:(value:any)=>void=()=>{};
  (plugin as any).insert=()=>new Promise(resolve=>{finish=resolve;});
  view.render(selected,{translation:'有说服力的'});
  const insert=[...document.querySelectorAll('button')].find(button=>button.textContent==='在选区后加括号')!;
  const pending=insert.onclick!(new (domEvent(document))('click') as any);
  assert.equal([...document.querySelectorAll('button')].find(button=>button.textContent==='语境解释')!.disabled,true);
  const next=snapshot('b.md','A different idea.','idea');view.render(next,{translation:'想法'});
  finish(translationInsertion(selected.source,selected,'有说服力的','inline'));await pending;
  [...document.querySelectorAll('button')].find(button=>button.textContent==='语境解释')!.click();
  assert.equal(calls[0][1].path,'b.md');assert.equal(calls[0][1].text,'idea');
});


test('an unresolved reading selection retains contextual explanation and can save only to its learning note', async () => {
  const {view,document,calls} = setup();
  const selection = readingSnapshot('a.md', 'An unrelated example.', 'example', undefined, {text:'A visible example.',offset:10});
  view.render(selection, explained, '', 'explain');
  assert.equal(document.querySelector('blockquote')?.textContent, 'A visible example.');
  assert.equal(document.querySelector('.note-digest-insert'), null);
  const destinations = document.querySelector<HTMLSelectElement>('[aria-label="收藏保存位置"]')!;
  assert.deepEqual(Array.from(destinations.options, option => option.value), ['note']);
  const save = document.querySelector<HTMLButtonElement>('.note-digest-save button')!;
  assert.equal(calls.length, 0);
  await save.onclick!(new (domEvent(document))('click') as any);
  assert.deepEqual(calls[0], ['collect',selection,explained,'word','note']);
});

test('sidebar explanation reuses the captured context and saves only after clicking its notebook action', async () => {
  const {view, document, calls, plugin} = setup();
  plugin.collection.recordsFor = () => assert.fail('Sidebar selections have no article collection');
  Object.assign(plugin.collection, {
    saveSidebarWord: async (...args: any[]) => {
      calls.push(['saveSidebarWord', ...args]);
      return {text:'已收藏到单词笔记', duplicate:false, path:'Digest/单词学习/compelling.md'};
    },
  });
  const selection = {sidebar:true, text:'compelling', context:'A compelling argument.', contextOffset:2};
  view.render(selection, {translation:'有说服力的'});
  assert.match(document.body.textContent!, /侧栏 · 临时选区/);
  assert.equal(document.querySelector('.note-digest-insert, .note-digest-save'), null);
  const buttons = [...document.querySelectorAll('button')];
  assert.ok(buttons.every(button => button.textContent !== '总结全文'));
  buttons.find(button => button.textContent === '语境解释')!.click();
  assert.deepEqual(calls, [['run', selection, 'explain']]);
  view.render(selection, explained);
  assert.equal(document.querySelector('blockquote')?.textContent, selection.context);
  assert.equal(document.querySelector('.note-digest-insert, select'), null);
  assert.equal(calls.length, 1);
  const save = Array.from(document.querySelectorAll('.note-digest-save button')).find(button => button.textContent === '收藏到单词笔记') as HTMLButtonElement;
  await save.onclick!(new (domEvent(document))('click') as any);
  assert.deepEqual(calls[1], ['saveSidebarWord', selection, explained]);
  assert.match(document.querySelector('.note-digest-save [role="status"]')!.textContent!, /已收藏到单词笔记/);
  view.app.workspace.openLinkText = (path: string) => { calls.push(['open',path]); };
  [...document.querySelectorAll('button')].find(button => button.textContent === '打开单词笔记')!.click();
  assert.deepEqual(calls.at(-1), ['open','Digest/单词学习/compelling.md']);
});

test('duplicate saving shows one prominent message without paths', async () => {
  const {view,document,plugin}=setup();
  plugin.collect=async()=>({text:'本词已收藏',duplicate:true});
  view.render(selected,explained);
  const section=document.querySelector('.note-digest-save')!;
  const save=section.querySelector('button')!;
  await save.onclick!(new (domEvent(document))('click') as any);
  const message=section.querySelector('[role="status"]')!;
  assert.equal(message.textContent,'本词已收藏');
  assert.ok(message.classList.contains('note-digest-save-duplicate'));
  assert.equal(section.querySelector<HTMLButtonElement>('[aria-label="撤销本次保存"]')?.hidden, true);
});

test('translation and explanation show Undo next to the save status and retry the same save', async () => {
  for (const mode of ['translate', 'explain'] as const) {
    const {view,document,plugin,calls} = setup();
    const receipt = {recordId:'saved', id:'this-save'};
    plugin.collect = async (...args) => {
      calls.push(['collect', ...args]);
      return {text:'已保存', duplicate:false, undo:receipt};
    };
    let attempts = 0;
    Object.assign(plugin, {undoCollectionSave: async (undo: unknown) => {
      calls.push(['undo', undo]);
      return ++attempts === 1 ? {text:'撤销尚未完成，可重试。', complete:false} : {text:'已撤销本次保存。', complete:true};
    }});
    view.render(selected, explained, '', mode);
    const section = document.querySelector('.note-digest-save')!;
    const save = section.querySelector<HTMLButtonElement>('button')!;
    const undo = section.querySelector<HTMLButtonElement>('[aria-label="撤销本次保存"]')!;
    const destination = section.querySelector<HTMLSelectElement>('[aria-label="收藏保存位置"]')!;
    const message = section.querySelector('[role="status"]')!;
    assert.equal(undo.hidden, true);
    const event = new (domEvent(document))('click') as any;
    await save.onclick!(event);
    assert.equal(message.textContent, '已保存');
    assert.equal(undo.hidden, false);
    assert.equal(message.parentElement, undo.parentElement);
    destination.value = 'note';
    await undo.onclick!(event);
    assert.equal(undo.hidden, false);
    await undo.onclick!(event);
    assert.deepEqual(calls.slice(1), [['undo', receipt], ['undo', receipt]]);
    assert.equal(undo.hidden, true);
    assert.equal(message.textContent, '已撤销本次保存。');
  }
});


test('an explanation updates a matched card only when the update control is clicked', async () => {
  const {view,document,plugin,calls}=setup();
  plugin.collection.matchingWords=async()=>[{id:'old-card',anchor:{text:'compelling'},result:{translation:'旧译文'}}];
  view.render(selected,explained);
  await Promise.resolve();
  const buttons=[...document.querySelectorAll('button')];
  const save=buttons.find(button=>button.textContent==='保存')!;
  const update=buttons.find(button=>button.textContent==='用本次解释更新')!;
  const event=new (domEvent(document))('click') as any;
  await save.onclick!(event);
  assert.deepEqual(calls.map(call=>call[0]),['collect']);
  await update.onclick!(event);
  assert.deepEqual(calls.at(-1),['update',selected,'old-card',explained]);
  assert.equal(document.querySelector('.note-digest-save [role="status"]')?.textContent,'已更新单词卡');
});

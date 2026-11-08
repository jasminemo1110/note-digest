import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {snapshot,type DigestResult} from '../src/core';
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
  const plugin={collection:{recordsFor:()=>[],notePathFor:()=>undefined},run:async(...args:any[])=>calls.push(['run',...args]),collect:async(...args:any[])=>{calls.push(['collect',...args]);return '已保存';},insert:async(...args:any[])=>calls.push(['insert',...args])};
  return {view:new module.exports.DigestView({},plugin),document,calls};
}
const selected=snapshot('a.md','A compelling argument.','compelling');
const explained:DigestResult={translation:'有说服力的',pronunciation:'/kəmˈpelɪŋ/',meaning:'含义',usage:'用法',example:'例句',assessment:{status:'natural',explanation:'不应显示这句话',correction:null}};
test('toolbar precedes original; insert buttons directly follow translation; save defaults to both',async()=>{
  const {view,document,calls}=setup();view.render(selected,{translation:'有说服力的'});
  const toolbar=document.querySelector('.note-digest-toolbar')!;const original=document.querySelector('.note-digest-original')!;
  assert.ok(toolbar.compareDocumentPosition(original)&4);
  assert.equal(document.querySelector('.note-digest-paragraph')?.textContent,'compelling有说服力的添加到原文下方添加到句后括号');
  assert.equal(document.querySelector('.note-digest-save .note-digest-insert'),null);
  assert.equal((document.querySelector('[aria-label="收藏保存位置"]') as HTMLSelectElement).value,'both');
  const save=document.querySelector('.note-digest-save button') as HTMLButtonElement;assert.equal(save.textContent,'保存');
  await save.onclick!(new (domEvent(document))('click') as any);
  assert.equal(calls[0][3],'quote');assert.equal(calls[0][4],'both');
});
function domEvent(document:Document):typeof Event{return document.defaultView!.Event;}
test('explanation hides insertion and natural assessment but still saves a full word card',()=>{
  const {view,document}=setup();view.render(selected,explained);
  assert.equal(document.querySelector('.note-digest-insert'),null);assert.ok(!document.body.textContent!.includes('不应显示这句话'));
  assert.equal((document.querySelector('[aria-label="收藏分类"]') as HTMLSelectElement).value,'word');
  view.render(selected,{...explained,assessment:{status:'incorrect',explanation:'有语法问题',correction:'corrected expression'}});
  assert.ok(document.body.textContent!.includes('有语法问题'));assert.ok(document.body.textContent!.includes('corrected expression'));
});
test('long selection stays blank until chosen action, then displays aligned bilingual paragraphs',()=>{
  const {view,document}=setup();const long=snapshot('a.md','First.\n\nSecond.','First.\n\nSecond.');
  view.render(long,undefined,'','idle');assert.ok(!document.body.textContent!.includes('First.'));assert.ok(document.body.textContent!.includes('Summarize'));assert.equal(document.querySelector('.note-digest-save'),null);
  view.render(long,{translation:'第一。\n\n第二。',paragraphs:[{source:'First.',start:0,end:6,translation:'第一。'},{source:'Second.',start:8,end:15,translation:'第二。'}]});
  const pairs=document.querySelectorAll('.note-digest-paragraph');assert.equal(pairs.length,2);assert.ok(pairs[0].textContent!.startsWith('First.第一。'));assert.ok(pairs[1].textContent!.startsWith('Second.第二。'));
  view.render(long,{translation:'',summary:'摘要内容'},'','summarize');assert.ok(document.body.textContent!.includes('摘要内容'));assert.equal(document.querySelector('.note-digest-save'),null);
});

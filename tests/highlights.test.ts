import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {makeAnchor, locateAnchor, LEARNING_BOUNDARY} from '../src/anchors';
import {applyHighlights, clearHighlights, highlightRanges} from '../src/highlights';
import type {LearningRecord} from '../src/collection';
function record(source: string, text: string): LearningRecord {
  return {id:'one',documentId:'doc',kind:'word',anchor:makeAnchor(source,source.indexOf(text),text),context:source,result:{translation:'译文'},createdAt:'2026-11-08T00:00:00.000Z',active:true,savedTo:['a.md']};
}
test('highlight matches the selected context, never same word in another paragraph or generated tail',()=>{
  const source='A compelling argument.\n\nA compelling story.';
  const saved=record(source,'compelling');
  assert.deepEqual(highlightRanges(source,0,0,'A compelling argument.',[saved]),[{start:2,end:12,kind:'word'}]);
  assert.deepEqual(highlightRanges(source,2,2,'A compelling story.',[saved]),[]);
  const exported=source+LEARNING_BOUNDARY+'A compelling argument.';
  assert.deepEqual(highlightRanges(exported,6,6,'A compelling argument.',[saved]),[]);
});
test('changed/ambiguous paragraph refuses highlight and later unrelated insertion preserves anchor',()=>{
  const original='A compelling argument.';const saved=record(original,'compelling');
  assert.equal(locateAnchor(original+'\n\n'+original,saved.anchor),null);
  assert.equal(locateAnchor('A compelling new argument.',saved.anchor),null);
  assert.equal(locateAnchor('Introduction.\n\n'+original,saved.anchor),17);
});
test('DOM highlights preserve text, links, listeners and overlapping ranges; cleanup restores DOM',()=>{
  const dom=new JSDOM('<p>A <a href="/test">compelling</a> argument.</p>');
  const p=dom.window.document.querySelector('p')!;const link=p.querySelector('a')!;
  let clicks=0;link.addEventListener('click',e=>{e.preventDefault();clicks++;});
  const before=p.innerHTML;
  applyHighlights(p,[{start:2,end:12,kind:'word'},{start:0,end:22,kind:'quote'}]);
  assert.equal(p.textContent,'A compelling argument.');
  assert.ok(p.querySelector('a mark'));link.click();assert.equal(clicks,1);
  assert.equal(p.querySelectorAll('mark mark').length,0);
  clearHighlights(p);assert.equal(p.innerHTML,before);assert.equal(p.querySelector('a'),link);
});
test('DOM renders selected text literally, without interpreting markup',()=>{
  const dom=new JSDOM('<p></p>');const p=dom.window.document.querySelector('p')!;p.textContent='<img src=x onerror=alert(1)>';
  applyHighlights(p,[{start:0,end:p.textContent.length,kind:'quote'}]);
  assert.equal(p.querySelector('img'),null);assert.equal(p.textContent,'<img src=x onerror=alert(1)>');
});
test('unsupported formatted paragraphs skip highlight rather than guessing offsets',()=>{
  const source='A **compelling** argument.';const saved=record(source,'compelling');
  assert.deepEqual(highlightRanges(source,0,0,'A compelling argument.',[saved]),[]);
});

test('reading selection resolves repeated words within the actual paragraph', async()=>{
  const {renderedSelectionOffset}=await import('../src/anchors');
  const source='A compelling argument.\n\nA compelling story.';
  assert.equal(renderedSelectionOffset(source,2,2,'A compelling story.',2,'compelling'),source.lastIndexOf('compelling'));
  assert.equal(renderedSelectionOffset(source,0,2,'A compelling story.',2,'compelling'),source.lastIndexOf('compelling'));
  assert.equal(renderedSelectionOffset(source,0,0,'A compelling new argument.',2,'compelling'),undefined);
  assert.equal(renderedSelectionOffset('Same.\n\nSame.',0,2,'Same.',0,'Same'),undefined);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {makeAnchor, locateAnchor, digestText, LEARNING_BOUNDARY} from '../src/anchors';
import {applyHighlights, clearHighlights, highlightRanges, tableHighlightRanges} from '../src/highlights';
import type {LearningRecord} from '../src/collection';
function record(source: string, text: string, start = source.indexOf(text)): LearningRecord {
  return {id:'one',documentId:'doc',kind:'word',anchor:makeAnchor(source,start,text),context:source,result:{translation:'译文'},createdAt:'2026-11-08T00:00:00.000Z',active:true,savedTo:['a.md']};
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

test('table highlights distinguish the selected occurrence within the same cell and identical adjacent cells', async () => {
  const source = '| Original | Revised |\n| --- | --- |\n| **Hotel:** confirmation and confirmation | **Hotel:** confirmation and confirmation |';
  const dom = new JSDOM('<table><tr><th>Original</th><th>Revised</th></tr><tr><td><strong>Hotel:</strong> confirmation and confirmation</td><td><strong>Hotel:</strong> confirmation and confirmation</td></tr></table>');
  const table = dom.window.document.querySelector('table')!;
  const saved = record(source, 'confirmation', source.indexOf('and confirmation') + 'and '.length);
  const section = {lineStart:0,lineEnd:2,text:source};
  const ranges = await tableHighlightRanges(source, section, table, [saved]);
  for (const [cell, matches] of ranges) applyHighlights(cell, matches);
  assert.equal(table.querySelectorAll('mark').length, 1);
  assert.equal(table.rows[1].cells[0].innerHTML, '<strong>Hotel:</strong> confirmation and <mark class="note-digest-highlight" data-kind="word" title="已收藏词语">confirmation</mark>');
  clearHighlights(table);
  assert.equal(table.querySelectorAll('mark').length, 0);
  assert.equal((await tableHighlightRanges(source, section, table, [{...saved,active:false}])).size, 0);
  assert.equal((await tableHighlightRanges(source, {...section,text:'stale render'}, table, [saved])).size, 0);
});

test('identical tables need an unchanged source snapshot to highlight the stored occurrence', async () => {
  const markdown = '| Word |\n| --- |\n| confirmation |';
  const source = `${markdown}\n\n${markdown}`;
  const table = new JSDOM('<table><tr><th>Word</th></tr><tr><td>confirmation</td></tr></table>').window.document.querySelector('table')!;
  const start = source.lastIndexOf('confirmation');
  const saved = record(source,'confirmation',start);
  saved.anchor.location = {start, digest:await digestText(source)};
  assert.equal((await tableHighlightRanges(source, {lineStart:0,lineEnd:2,text:source}, table, [saved])).size, 0);
  assert.equal((await tableHighlightRanges(source, {lineStart:4,lineEnd:6,text:source}, table, [saved])).size, 1);
  assert.equal((await tableHighlightRanges(markdown, {lineStart:0,lineEnd:2,text:markdown}, table, [saved])).size, 0);
});

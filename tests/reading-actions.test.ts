import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {articleRange, sidebarSelection, readingShortcut, shortContext} from '../src/reading-actions';
import {makeAnchor} from '../src/anchors';

test('article context uses the actual occurrence in its cell and excludes adjacent cells', () => {
  const {document} = new JSDOM('<main><table><tr><td>Other confirmation</td><td><strong>Hotel:</strong> Received the confirmation email.</td></tr></table></main>').window;
  const cell = document.querySelector('td + td')!;
  const target = cell.lastChild!;
  const offset = target.textContent!.indexOf('confirmation');
  const range = document.createRange();
  range.setStart(target, offset);
  range.setEnd(target, offset + 'confirmation'.length);
  const captured = articleRange(range, document.querySelector('main')!, 'confirmation');
  assert.equal(captured.block, cell);
  assert.equal(captured.context.text, 'Hotel: Received the confirmation email.');
  assert.equal(captured.context.offset, captured.context.text.indexOf('confirmation'));
});

test('display context stays in selected paragraph and includes at most two nearby sentences',()=>{
  const source='Unrelated earlier paragraph.\n\nFirst sentence. New ideas emerge slowly. Another sentence. Final sentence.\n\nUnrelated later paragraph.';
  const context=shortContext(makeAnchor(source,source.indexOf('emerge'),'emerge'));
  assert.equal(context,'First sentence. New ideas emerge slowly.');
  assert.ok(!context.includes('Unrelated'));assert.ok(!context.includes('Final'));
});
test('context handles abbreviations, first sentence and very long sentences',()=>{
  const block='Dr. Smith saw ideas emerge. They mattered. Last sentence.';
  const context=shortContext(makeAnchor(block,block.indexOf('emerge'),'emerge'));
  assert.ok(context.includes('emerge'));assert.ok(!context.includes('Last'));
  const long='a '.repeat(700)+'emerge '+'b '.repeat(700);
  const clipped=shortContext(makeAnchor(long,long.indexOf('emerge'),'emerge'));
  assert.ok(clipped.length<=502);assert.ok(clipped.includes('emerge'));assert.ok(clipped.startsWith('…'));assert.ok(clipped.endsWith('…'));
});
const event={key:'d',altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,repeat:false,isComposing:false,defaultPrevented:false};
const state={reading:true,selectionInside:true,editable:false};
test('D and N act only on selected reading-view text',()=>{
  assert.equal(readingShortcut(event,state),'digest');
  assert.equal(readingShortcut({...event,key:'n'},state),'quote');
  for(const next of [{...state,reading:false},{...state,selectionInside:false},{...state,editable:true}]) assert.equal(readingShortcut(event,next),null);
});
test('shortcuts do not intercept typing, modified hotkeys, held keys, IME or consumed events',()=>{
  for(const key of ['altKey','ctrlKey','metaKey','shiftKey','repeat','isComposing','defaultPrevented']) assert.equal(readingShortcut({...event,[key]:true},state),null);
  assert.equal(readingShortcut({...event,key:'a'},state),null);
});

test('sidebar capture uses generic view markup and keeps the exact selection separate from context', () => {
  const {window} = new JSDOM(`
    <article><p>Context: <em>gloss over</em> fits here.</p></article>
    <section><div class="widget-output">widget report</div></section>`);
  const contents = window.document.querySelectorAll<HTMLElement>('article, section');
  const selection = window.getSelection()!;
  const values = ['gloss over', 'widget report'];
  const contexts = ['Context: gloss over fits here.', ''];
  for (const [index, content] of Array.from(contents).entries()) {
    const node = content.querySelector('em, .widget-output')!.firstChild!;
    selection.setBaseAndExtent(node, values[index].length, node, 0);
    assert.deepEqual(sidebarSelection(selection, content), {
      sidebar:true, text:values[index], context:contexts[index], contextOffset:index === 0 ? 9 : 0,
    });
    assert.equal(sidebarSelection(selection, content, false)?.context, '');
    assert.equal(sidebarSelection(selection, contents[1 - index]), undefined);
  }
});

test('sidebar context is bounded around the actual occurrence and does not use neighboring blocks', () => {
  const {window} = new JSDOM(`
    <section>
      <p>First occurrence: gloss over. Other paragraph.</p>
      <p>${'s'.repeat(1300)} The report <em>glosses over</em> the problem. ${'t'.repeat(1300)}</p>
      <p>Next paragraph.</p>
    </section>`);
  const content = window.document.querySelector('section')!;
  const selection = window.getSelection()!;
  selection.selectAllChildren(content.querySelector('em')!);
  const snapshot = sidebarSelection(selection, content)!;
  assert.equal(snapshot.text, 'glosses over');
  assert.equal(snapshot.contextOffset, 1200);
  assert.equal(snapshot.context.length, snapshot.text.length + 2400);
  assert.match(snapshot.context, /The report glosses over the problem\./);
  assert.doesNotMatch(snapshot.context, /First occurrence|Next paragraph/);
});

test('sidebar context does not include hidden content or controls', () => {
  const {window} = new JSDOM(`
    <section><div><span hidden>Hidden value</span><em>A compelling argument.</em><button>Copy</button></div></section>`);
  const content = window.document.querySelector('section')!;
  const node = content.querySelector('em')!.firstChild!;
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(node, 2, node, 12);
  const snapshot = sidebarSelection(selection, content)!;
  assert.equal(snapshot.text, 'compelling');
  assert.equal(snapshot.context, 'A compelling argument.');
});

test('sidebar capture rejects input, editable text, ranges across views and ranges enclosing an editor', () => {
  const {window} = new JSDOM(`
    <section id="view">
      <p id="first">First view</p>
      <textarea id="input">Private</textarea>
      <div contenteditable="true" id="editor">Editable</div>
      <p id="last">Last paragraph</p>
    </section>
    <section id="other">Second view</section>`);
  const content = window.document.getElementById('view')!;
  const text = (id: string) => window.document.getElementById(id)!.firstChild!;
  const selection = window.getSelection()!;
  for (const [start, end] of [['input', 'input'], ['editor', 'editor'], ['first', 'last'], ['first', 'other']]) {
    selection.setBaseAndExtent(text(start), 0, text(end), 6);
    assert.equal(sidebarSelection(selection, content), undefined);
  }
});

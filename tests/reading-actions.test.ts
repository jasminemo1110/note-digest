import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readingShortcut, shortContext} from '../src/reading-actions';
import {makeAnchor} from '../src/anchors';

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

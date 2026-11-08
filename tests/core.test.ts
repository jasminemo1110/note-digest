import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, insertTranslation, validateResult } from '../src/core';

test('reading mode refuses ambiguous source; editor offset resolves it', () => {
  const source = 'A word.\n\nA word.';
  assert.throws(() => snapshot('a.md', source, 'word'), /多处/);
  assert.equal(snapshot('a.md', source, 'word', 11).start, 11);
});
test('context is bounded and snapshot does not change input', () => {
  const source = 'a'.repeat(2000) + 'unique' + 'b'.repeat(2000);
  const s = snapshot('a.md', source, 'unique');
  assert.equal(s.context.length, 2406); assert.equal(s.source, source);
});
test('inline insertion escapes AI markup and repeat insertion refuses changed source', () => {
  const source = 'A compelling argument.'; const s = snapshot('a.md', source, 'compelling');
  const output = insertTranslation(source, s, '有说服力的 <script> [[target]]', 'inline');
  assert.ok(output.includes('&lt;script&gt;')); assert.ok(!output.includes('[[target]]'));
  assert.throws(() => insertTranslation(output, s, '译文', 'inline'), /原文已修改/);
});
test('below insertion retains rest of line and following paragraph', () => {
  const source = 'A compelling argument.\n\nNext paragraph.';
  assert.equal(insertTranslation(source, snapshot('a.md', source, 'compelling'), '有说服力', 'below'), 'A compelling argument.\n\n有说服力\n\nNext paragraph.');
});
test('complex Markdown remains read-only in the first increment', () => {
  for (const source of ['- A word.', '**A word.**', '```\nA word.\n```', '> A word.', '---\ntitle: A word.\n---']) {
    assert.throws(() => insertTranslation(source, snapshot('a.md', source, 'word'), '词', 'inline'), /复杂/);
  }
});
test('invalid, missing and excessive model fields are rejected', () => {
  for (const value of [null, [], {}, {translation: ''}, {translation: 'a'.repeat(24001)}]) assert.throws(() => validateResult(value, 'translate'));
  assert.throws(() => validateResult({ translation: '词' }, 'explain'));
  assert.deepEqual(validateResult({translation: '词', unwanted: '<script>'}, 'translate'), {translation: '词'});
});
test('edited source refuses write even if selected word still exists', () => {
  const s = snapshot('a.md', 'A word.', 'word');
  assert.throws(() => insertTranslation('A word. Changed.', s, '词', 'below'), /原文已修改/);
});

test('explanation preserves pronunciation, contextual usage and a minimal correction', () => {
  const input = {translation: '他每天去学校', meaning: '描述日常习惯', usage: '第三人称单数用 goes。', example: 'He goes to work. 他去上班。',
    pronunciation: null, assessment: {status: 'incorrect', explanation: 'He go 中的 go 缺少第三人称单数形式。', correction: 'He goes to school every day.'}};
  assert.deepEqual(validateResult(input, 'explain'), input);
});
test('valid colloquial usage is distinguished from an error; IPA is retained', () => {
  const input = {translation:'有说服力的',meaning:'这里修饰论点',usage:'a compelling argument',example:'A compelling story. 引人入胜的故事。',
    pronunciation:'/kəmˈpelɪŋ/',assessment:{status:'natural',explanation:'此处搭配自然。',correction:null}};
  assert.deepEqual(validateResult(input, 'explain'), input);
  assert.equal(validateResult({...input, assessment:{status:'informal',explanation:'口语中成立，不是语法错误。',correction:null}}, 'explain').assessment?.status, 'informal');
  assert.equal(validateResult({...input, pronunciation:null, assessment:{status:'uncertain',explanation:'缺少必要上下文。',correction:null}}, 'explain').assessment?.status, 'uncertain');
});
test('malformed or contradictory language assessments are rejected', () => {
  const base = {translation:'译文',meaning:'含义',usage:'用法',example:'例句',pronunciation:null};
  for (const assessment of [null, [], {status:'toString',explanation:'x',correction:null},
    {status:'incorrect',explanation:'有错',correction:null}, {status:'unnatural',explanation:'生硬',correction:null},
    {status:'natural',explanation:'正确',correction:'change it'}, {status:'uncertain',explanation:'不确定',correction:'change it'},
    {status:'natural',explanation:'',correction:null}, {status:'incorrect',explanation:'有错',correction:'x'.repeat(6001)}]) {
    assert.throws(() => validateResult({...base, assessment}, 'explain'));
  }
  for (const pronunciation of [undefined, {}, '', 'x'.repeat(501)]) assert.throws(() => validateResult({...base, pronunciation, assessment:{status:'natural',explanation:'自然',correction:null}}, 'explain'));
});

test('confirmed inline insertion refreshes source without changing selected English or AI context',async()=>{
  const {translationInsertion,rebaseSelectionAfterInsertion}=await import('../src/core');
  const selected=snapshot('a.md','New ideas emerge slowly.','emerge');
  const receipt=translationInsertion(selected.source,selected,'浮现','inline');
  const updated=rebaseSelectionAfterInsertion(selected,receipt)!;
  assert.equal(updated.source,'New ideas emerge（浮现） slowly.');
  assert.equal(updated.text,selected.text);assert.equal(updated.context,selected.context);
  assert.equal(updated.source.slice(updated.start,updated.end),'emerge');
  assert.throws(()=>insertTranslation(updated.source,updated,'浮现','inline'),/已包含/);
});
test('confirmed below insertion preserves selection; manual or unrelated changes cannot rebase it',async()=>{
  const {translationInsertion,rebaseSelectionAfterInsertion}=await import('../src/core');
  const selected=snapshot('a.md','New ideas emerge slowly.','emerge');
  const receipt=translationInsertion(selected.source,selected,'浮现','below');
  const updated=rebaseSelectionAfterInsertion(selected,receipt)!;
  assert.equal(updated.context,selected.context);assert.equal(updated.start,selected.start);
  assert.throws(()=>insertTranslation(updated.source,updated,'浮现','below'),/已包含/);
  assert.equal(rebaseSelectionAfterInsertion(selected,{...receipt,after:receipt.after+'manual edit'}),null);
  assert.equal(rebaseSelectionAfterInsertion(selected,{...receipt,path:'other.md'}),null);
  assert.throws(()=>insertTranslation(updated.source+'manual edit',updated,'另一译文','inline'),/原文已修改/);
});
test('insertion receipts do not pretend a multi-paragraph selection remains contiguous',async()=>{
  const {translationInsertion,rebaseSelectionAfterInsertion}=await import('../src/core');
  const source='First paragraph.\n\nSecond paragraph.';const selected=snapshot('a.md',source,source);
  const part=snapshot('a.md',source,'First paragraph.');const receipt=translationInsertion(source,part,'第一段','below');
  assert.equal(rebaseSelectionAfterInsertion(selected,receipt),null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWordLookup, readingSnapshot, snapshot, insertTranslation, validateResult } from '../src/core';

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
test('a clipped word uses its complete source range for lookup and inline annotation', () => {
  const source = '*An earlier drought passed.*\n\n*Plants can withstand prolonged periods of drought.*';
  const wordStart = source.lastIndexOf('drought');
  for (const fragment of ['rought', 'drou', 'roug']) {
    const raw = snapshot('a.md', source, fragment, source.lastIndexOf(fragment));
    const completed = normalizeWordLookup(raw);
    assert.ok('path' in completed);
    assert.equal(completed.text, 'drought');
    assert.equal(completed.start, wordStart);
    assert.equal(completed.end, wordStart + 'drought'.length);
    assert.equal(completed.contextOffset, wordStart);
    assert.equal(insertTranslation(source, completed, '干旱', 'inline'), source.replace(/drought\.\*$/, 'drought（干旱）.*'));
    assert.equal(completed.originalSelection, raw);
  }
});
test('lookup completes a visibly clipped word without inventing a writable source range', () => {
  const source = '**d**rought occurred.';
  const rendered = 'drought occurred.';
  const raw = readingSnapshot('a.md', source, 'rought', {
    section: {lineStart: 0, lineEnd: 0, text: source}, paragraph: rendered, offset: 1,
  }, {text: rendered, offset: 1});
  const completed = normalizeWordLookup(raw);
  assert.ok('path' in completed);
  assert.equal(completed.text, 'drought');
  assert.equal(completed.contextOffset, 0);
  assert.throws(() => insertTranslation(source, completed, '干旱', 'inline'), /无法确认/);

  for (const [body, text] of [['A drought.', 'drought'], ['A rought.', 'rought'], ['A drought followed.', 'drought foll']]) {
    const snapshotRange = snapshot('a.md', body, text);
    assert.equal(normalizeWordLookup(snapshotRange), snapshotRange);
  }
});
test('word lookup trims extra spaces, punctuation and one verified clipped initial while keeping phrases', () => {
  const source = 'A drought, then rain. A drought. Storms followed.';
  const start = source.lastIndexOf('drought');
  for (const text of ['drought.', 'drought. ', 'drought. S', 'rought. S', ' drought.']) {
    const selection = snapshot('a.md', source, text, source.lastIndexOf(text));
    const adjusted = normalizeWordLookup(selection);
    assert.equal(adjusted.originalSelection, selection);
    assert.equal(adjusted.text, 'drought');
    assert.equal(adjusted.start, start);
    assert.equal(adjusted.contextOffset, start);
    assert.equal(insertTranslation(source, adjusted, '干旱', 'inline'), source.replace('drought. Storms', 'drought（干旱）. Storms'));
  }
  for (const [body, text] of [['Periods of drought.', 'of drought.'], ['A drought. Storms followed.', 'drought. St'],
    ['A drought. I left.', 'drought. I'], ['Vitamin C matters.', 'Vitamin C'],
    ['Is it drought-resistant?', 'drought'], ['CO2 levels', 'CO2']]) {
    const selection = snapshot('a.md', body, text);
    assert.equal(normalizeWordLookup(selection), selection);
  }
});
test('lookup keeps a whole first word when the next word is barely selected across a space', () => {
  const source = '*Certain seeds remain dormant until environmental conditions become favorable.*';
  const start = source.indexOf('become');
  for (const text of ['become f', 'become fa']) {
    const selection = snapshot('a.md', source, text, start);
    const adjusted = normalizeWordLookup(selection);
    assert.equal(adjusted.text, 'become');
    assert.equal(adjusted.originalSelection, selection);
    assert.equal(adjusted.context, selection.context);
    assert.equal(insertTranslation(source, adjusted, '变得', 'inline'), source.replace('become ', 'become（变得） '));
  }
  for (const text of ['become favorable', 'become fav', 'ecome fa', 'conditions become fa']) {
    const selection = snapshot('a.md', source, text);
    assert.equal(normalizeWordLookup(selection), selection);
  }
  const particle = snapshot('a.md', 'Turn off the lights.', 'Turn of');
  assert.equal(normalizeWordLookup(particle), particle);
});
test('reading view remaps the corrected word when the excess selection spans Markdown markup', () => {
  const source = '*A drought.* Storms followed.';
  const paragraph = 'A drought. Storms followed.';
  const offset = paragraph.indexOf('drought');
  const adjusted = readingSnapshot('a.md', source, 'drought. S', {
    section:{lineStart: 0, lineEnd: 0, text: source}, paragraph, offset,
  }, {text: paragraph, offset}, true);
  assert.equal(adjusted.text, 'drought');
  assert.equal(adjusted.originalSelection?.text, 'drought. S');
  assert.equal(insertTranslation(source, adjusted, '干旱', 'inline'), '*A drought（干旱）.* Storms followed.');
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
test('both insertion modes preserve a single italic span and clipping line breaks', async () => {
  const {translationInsertion, rebaseSelectionAfterInsertion} = await import('../src/core');
  for (const marker of ['*', '_']) {
    const paragraph = `${marker}(This essay is derived from a lecture.)${marker}  `;
    for (const newline of ['\n', '\r\n']) {
      const before = ['---', 'title: Example', '---', '  ', ''].join(newline);
      const after = ['', '  ', 'Next paragraph.'].join(newline);
      const source = before + paragraph + after;
      const selected = snapshot('a.md', source, 'derived');
      const inline = translationInsertion(source, selected, '源自', 'inline');
      const below = translationInsertion(source, selected, '源自', 'below');
      assert.equal(inline.after, before + paragraph.replace('derived', 'derived（源自）') + after);
      assert.equal(below.after, before + paragraph + newline + newline + '源自' + after);
      for (const [mode, receipt] of [['inline', inline], ['below', below]] as const) {
        const rebased = rebaseSelectionAfterInsertion(selected, receipt)!;
        assert.equal(rebased.text, selected.text);
        assert.equal(rebased.context, selected.context);
        assert.throws(() => insertTranslation(rebased.source, rebased, '源自', mode), /已包含/);
      }
    }
  }
});
test('inline emphasis inside a plain paragraph keeps a translation before the closing delimiter', () => {
  const source = 'This was *derived* from a talk.';
  assert.equal(insertTranslation(source, snapshot('a.md', source, 'derived'), '源自', 'inline'), 'This was *derived（源自）* from a talk.');
  assert.throws(() => insertTranslation(source, snapshot('a.md', source, 'was *derived'), '译文', 'inline'), /复杂/);
});
test('writes refuse non-prose blocks and unsupported Obsidian syntax', () => {
  for (const source of [
    '- A *word*.', '```\n*A word.*\n```', '\t*A word.*', '    *A word.*', '> *A word.*',
    '---\ntitle: *A word.*\n---', '# *A word.*', '`*A word.*`', '*A word.* | value',
    '*A word.*\n====', 'A word. [[Note|alias]]', 'A word. ^block',
  ]) {
    for (const mode of ['inline', 'below'] as const) {
      assert.throws(() => insertTranslation(source, snapshot('a.md', source, 'word'), '词', mode), /复杂/, source);
    }
  }
});
test('invalid, missing and excessive model fields are rejected', () => {
  for (const value of [null, [], {}, {translation: ''}, {translation: 'a'.repeat(24001)}]) assert.throws(() => validateResult(value, 'translate'));
  assert.throws(() => validateResult({ translation: '词' }, 'explain'));
  assert.deepEqual(validateResult({translation: '词', unwanted: '<script>'}, 'translate'), {translation: '词'});
});

test('headwords survive validation and legacy results remain compatible', () => {
  const base = {translation:'解读',meaning:'含义',usage:'用法',example:'例句',pronunciation:null,
    assessment:{status:'natural',explanation:'自然',correction:null}};
  assert.equal(validateResult({...base,headword:' interpret '},'explain').headword,'interpret');
  assert.equal(validateResult({...base,headword:null},'explain').headword,null);
  assert.equal(Object.hasOwn(validateResult(base,'explain'),'headword'),false);
  for (const headword of ['', ' ', 42, {}, 'a'.repeat(201), 'interpret\n# injected', 'a\0b']) {
    assert.throws(() => validateResult({...base,headword},'explain'), /词头/);
  }
  assert.deepEqual(validateResult({translation:'解读',headword:'interpret'},'translate'),{translation:'解读'});
});

test('supplementary usages validate as a bounded list of short text fields', () => {
  const base = {translation:'发布',meaning:'含义',usage:'用法',example:'例句',pronunciation:null,
    assessment:{status:'natural',explanation:'自然',correction:null}};
  const usage = {partOfSpeech:'名词',meaning:'问题',example:'a serious issue（一个严重的问题）'};
  const input = {...base,commonUsages:[{...usage,example:` ${usage.example} `,ignored:'extra'}]};
  assert.deepEqual(validateResult(input,'explain').commonUsages,[usage]);
  assert.deepEqual(validateResult({...base,commonUsages:[]},'explain').commonUsages,[]);
  for (const commonUsages of [null, {}, Array(4).fill(usage), [null], [{...usage,partOfSpeech:' '}],
    [{...usage,meaning:'x'.repeat(161)}], [{...usage,example:'first\nsecond'}]]) {
    assert.throws(() => validateResult({...base,commonUsages},'explain'),/常见用法/);
  }
});
test('word family validates distinct related headwords and keeps older explanations readable', () => {
  const base = {headword:'confirmation',translation:'确认',meaning:'含义',usage:'用法',example:'例句',pronunciation:null,
    assessment:{status:'natural',explanation:'自然',correction:null}};
  const related = {word:'confirm',partOfSpeech:'动词',meaning:'确认；证实'};
  const wordFamily = [related, {...related,word:'Confirm'}, {...related,word:'confirmation'}];
  assert.deepEqual(validateResult({...base,wordFamily},'explain').wordFamily,[related]);
  const withIpa = {...related, pronunciation:'英 /kənˈfɜːm/；美 /kənˈfɝːm/'};
  assert.deepEqual(validateResult({...base,wordFamily:[withIpa]},'explain').wordFamily,[withIpa]);
  assert.throws(() => validateResult({...base,wordFamily:[{...related,pronunciation:'confirm'}]},'explain'), /同族词音标/);
  assert.deepEqual(validateResult({...base,headword:null,wordFamily},'explain').wordFamily,[]);
  assert.equal(validateResult(base,'explain').wordFamily,undefined);
  assert.throws(() => validateResult({...base,wordFamily:[{...related,word:'confirm\n# separate'}]},'explain'), /同族词/);
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

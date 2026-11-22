import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionFeedback, CollectionStore, loadCollection, recordMarkdown, SIDEBAR_NOTE_PATH, type CollectionData, type StoragePort } from '../src/collection';
import { readingSnapshot, snapshot, type DigestResult } from '../src/core';
import { articleBody, locateAnchor, LEARNING_BOUNDARY, LEARNING_HEADING } from '../src/anchors';
import { addWordVocabulary, wordNoteBody } from '../src/word-vocabulary';
const source = '# Article\n\nA compelling argument.\n\nA compelling story.';
const path = 'Articles/Learning.md';
const result: DigestResult = { translation:'有说服力的', pronunciation:'/kəmˈpelɪŋ/', meaning:'形容论点令人信服', usage:'a compelling argument\n另一个搭配', example:'It is compelling. 它令人信服。', assessment:{status:'natural', explanation:'搭配自然', correction:null} };
function fixture(initial?: CollectionData) {
  const files = new Map<string, string>([[path, source]]);
  let durable: CollectionData = initial ?? loadCollection(null);
  let failPath = ''; let persistFails = false;
  const port: StoragePort = {
    async read(path) { return files.get(path) ?? null; },
    async update(path, transform) { if (path.includes(failPath) && failPath) throw new Error('模拟磁盘失败'); files.set(path, transform(files.get(path) ?? null)); },
    async persist(data) { if (persistFails) throw new Error('模拟元数据失败'); durable = structuredClone(data); }
  };
  let id = 0; const store = new CollectionStore(durable, port, () => `id-${++id}`);
  return {files, store, port, durable: () => durable, fail: (value: string) => failPath=value, failPersist:(value:boolean) => persistFails=value};
}
const select = () => snapshot(path, source, 'compelling', source.indexOf('compelling'));
test('a new learning marker belongs below its heading and keeps a section moved above it in the body', async () => {
  const f = fixture();
  await f.store.save(select(), result, 'word', 'source');
  const current = f.files.get(path)!;
  assert.ok(current.includes(LEARNING_HEADING + LEARNING_BOUNDARY));
  assert.equal(articleBody(current), source);
  const heading = current.indexOf(LEARNING_HEADING);
  const movedSection = '## Evening practice\n\nAn email confirmation arrived.\n\n';
  const reordered = current.slice(0, heading) + movedSection + current.slice(heading);
  assert.equal(articleBody(reordered), `${source}\n\n${movedSection.trimEnd()}`);
  const selected = snapshot(path, reordered, 'confirmation');
  f.files.set(path, reordered);
  const saved = await f.store.save(selected,result,'word','source');
  assert.equal(saved.targets[0].ok, true);
  assert.equal(f.files.get(path)!.split('<!-- note-digest:learning -->').length, 2);
});

test('a collection with a verified table position saves both full cards with the visible cell context', async () => {
  const f = fixture();
  const table = '| Prior | Current |\n| --- | --- |\n| Another compelling claim. | **Hotel:** A compelling example. |';
  f.files.set(path, table);
  const paragraph = 'Hotel: A compelling example.';
  const offset = paragraph.indexOf('compelling');
  const selection = readingSnapshot(path, table, 'compelling', {
    section:{lineStart:0,lineEnd:2,text:table},paragraph,offset,cell:{row:1,column:1,rows:2,columns:2},
  }, {text:paragraph,offset});
  const saved = await f.store.save(selection,result,'word','both');
  assert.equal(saved.targets.length, 2);
  assert.deepEqual(saved.targets.map(target => target.ok), [true,true]);
  assert.equal(locateAnchor(table,saved.record.anchor), table.lastIndexOf('compelling'));
  for (const target of saved.targets) {
    const card = f.files.get(target.path)!.split('**原始语境**')[1];
    assert.match(card, /Hotel: A compelling example/);
    assert.match(card, /语境含义/);
    assert.doesNotMatch(card, /Another compelling claim/);
  }
  assert.equal(articleBody(f.files.get(path)!), table);
});

test('a large table keeps a bounded anchor and can still save to the source', async () => {
  const f = fixture();
  const table = '| Original | Revised |\n| --- | --- |\n' + '| Earlier line | earlier text |\n'.repeat(830) +
    '| A compelling request. | revised text |';
  f.files.set(path, table);
  const selection = snapshot(path, table, 'compelling', table.indexOf('compelling'));
  const saved = await f.store.save(selection, result, 'word', 'source');
  assert.deepEqual(saved.targets.map(target => target.ok), [true]);
  const record = loadCollection(f.durable()).records[0];
  assert.ok(record.anchor.block.length <= 24000);
  assert.equal(locateAnchor(table, record.anchor), selection.start);
  assert.equal(locateAnchor(table + '\n\n' + table, record.anchor), null);
});

test('unresolved selections fall back to the article learning note without matching a different occurrence', async () => {
  const f = fixture();
  const context = 'An embedded compelling example.';
  const unresolved = readingSnapshot(path, source, 'compelling', undefined, {text:context,offset:context.indexOf('compelling')});
  const saved = await f.store.save(unresolved,result,'word','both');
  assert.equal(saved.record.unlocated, true);
  assert.equal(saved.targets.length, 1);
  assert.equal(saved.targets[0].ok, true);
  assert.equal(f.files.get(path), source);
  assert.match(f.files.get(saved.targets[0].path)!, /An embedded compelling example/);
  const restarted = new CollectionStore(loadCollection(f.durable()), f.port, () => 'another');
  const duplicate = await restarted.save(unresolved,result,'word','source');
  assert.equal(duplicate.record.id, saved.record.id);
  assert.deepEqual(await restarted.matchingWords(select()), []);
});

test('if a source-only collection cannot append, it saves the same card in the learning note', async () => {
  const f = fixture();
  f.fail(path);
  const saved = await f.store.save(select(),result,'word','source');
  assert.deepEqual(saved.targets.map(target => target.ok), [false,true]);
  assert.equal(f.files.get(path), source);
  f.fail('');
  const retry = await f.store.save(select(),result,'word','both');
  assert.equal(retry.record.id, saved.record.id);
  assert.deepEqual(retry.targets.map(target => target.message), ['已保存','已收藏']);
});
test('normalized cards use the base headword in both targets and keep original anchors across reload', async () => {
  const f=fixture();
  const original='Interpreting Research Findings';
  f.files.set(path,original);
  const selection=snapshot(path,original,'Interpreting');
  const commonUsages=[{partOfSpeech:'动词',meaning:'口译',example:'interpret for a guest（为一位客人口译）'}];
  const explanation={...result,headword:'interpret',translation:'解读',pronunciation:'/ɪnˈtɜːprɪt/',commonUsages};
  const saved=await f.store.save(selection,explanation,'word','both');
  for (const target of saved.targets) {
    const text=f.files.get(target.path)!;
    assert.match(text,/#### interpret\n/);
    assert.match(text,/\*\*原文词形\*\* Interpreting/);
    assert.ok(text.includes('Interpreting Research Findings'));
    assert.match(text,/\*\*其他常见用法\*\*\n\n- \*\*动词 · 口译\*\* — interpret for a guest/);
  }
  const record=loadCollection(f.durable()).records[0];
  assert.equal(record.result.headword,'interpret');
  assert.deepEqual(record.result.commonUsages,commonUsages);
  assert.equal(record.anchor.text,'Interpreting');
  assert.equal(locateAnchor(original,record.anchor),0);
  const duplicate=await f.store.save(selection,explanation,'word','both');
  assert.equal(duplicate.record.id,saved.record.id);
  const sidebar=await f.store.saveSidebarWord({sidebar:true,text:'Interpreting',context:original,contextOffset:0},explanation);
  assert.equal(sidebar.duplicate,false);
  assert.equal(sidebar.path,saved.targets[1].path);
  assert.match(f.files.get(sidebar.path)!,/#### interpret\n[\s\S]*其他常见用法[\s\S]*interpret for a guest/);
});

test('explicit update changes an old inflected title in both copies and preserves manual notes', async () => {
  const f=fixture();
  const original='Interpreting Research Findings';
  f.files.set(path,original);
  const selection=snapshot(path,original,'Interpreting');
  const saved=await f.store.save(selection,result,'word','both');
  for (const {path:target} of saved.targets) {
    f.files.set(target,f.files.get(target)!.replace('**音标**','我的备注\n\n**音标**'));
  }
  const commonUsages=[{partOfSpeech:'动词',meaning:'口译',example:'interpret for a guest（为一位客人口译）'}];
  await f.store.updateExplanation(selection,saved.record.id,{...result,headword:'interpret',commonUsages});
  for (const {path:target} of saved.targets) {
    assert.match(f.files.get(target)!,/#### interpret\n/);
    assert.match(f.files.get(target)!,/我的备注/);
    assert.match(f.files.get(target)!,/\*\*原文词形\*\* Interpreting/);
    assert.match(f.files.get(target)!,/其他常见用法[\s\S]*interpret for a guest/);
  }
  await f.store.removeNotes(saved.record.id);
  assert.equal(articleBody(f.files.get(path)!),original);
  for (const {path:target} of saved.targets) assert.ok(!f.files.get(target)!.includes(`<!-- note-digest:record:${saved.record.id} -->`));
});
const sidebarWord = (context: string, contextOffset = context.indexOf('compelling')) =>
  ({sidebar:true as const, text:'compelling', context, contextOffset});

test('sidebar lookup saves the exact source sentence and complete word card in its own note only', async () => {
  const f = fixture();
  const context = 'A compelling story. The editor needs a compelling argument. Read the whole paragraph.';
  const saved = await f.store.saveSidebarWord(sidebarWord(context, context.lastIndexOf('compelling')), result);
  assert.equal(saved.duplicate, false);
  assert.deepEqual([...f.files.keys()], [path, 'Digest/单词学习/compelling.md']);
  assert.equal(f.files.get(path), source);
  assert.equal(f.durable().records.length, 0);
  assert.equal(f.store.isLearningNote(SIDEBAR_NOTE_PATH), true);
  const note = f.files.get(saved.path)!;
  assert.match(note, /#### compelling\n/);
  assert.ok(note.includes('The editor needs a compelling argument\\.'));
  assert.doesNotMatch(note, /返回原文|A compelling story|Read the whole paragraph/);
  for (const field of ['音标','有说服力的','语境含义','用法','例句','另一个搭配']) assert.ok(note.includes(field));
});

test('sidebar saves deduplicate across restarts, keep distinct sentences and preserve edits', async () => {
  const f = fixture();
  const same = sidebarWord('A compelling argument.');
  const {path:wordPath}=await f.store.saveSidebarWord(same, result);
  const edited = f.files.get(wordPath)!.replace('有说服力的', '我的译文') + '\n我的备注\n';
  f.files.set(wordPath, edited);
  const restarted = new CollectionStore(loadCollection(f.durable()), f.port);
  const outcomes = await Promise.all([
    restarted.saveSidebarWord(sidebarWord('Introduction. A compelling argument. Closing thoughts.'), {...result, translation:'另一版译文'}),
    restarted.saveSidebarWord(same, {...result, headword:'different'}),
  ]);
  assert.ok(outcomes.every(saved => saved.duplicate));
  assert.equal(f.files.get(wordPath), edited);
  await restarted.saveSidebarWord(sidebarWord('A compelling story.'), result);
  const note = f.files.get(wordPath)!;
  assert.equal((note.match(/#### compelling/g) ?? []).length, 2);
  assert.ok(note.includes('我的译文') && note.endsWith('我的备注\n'));
});

test('sidebar saves validate explanations, reject a foreign note and allow retry after failure', async () => {
  const f = fixture();
  const withoutContext = sidebarWord('', 0);
  const wordPath = 'Digest/单词学习/compelling.md';
  await assert.rejects(f.store.saveSidebarWord(withoutContext, {translation:'单独译文'}));
  assert.equal(f.files.has(wordPath), false);
  f.files.set(wordPath, '# 用户自己的笔记\n');
  await assert.rejects(f.store.saveSidebarWord(withoutContext, result), /目标笔记已有其他内容/);
  assert.equal(f.files.get(wordPath), '# 用户自己的笔记\n');
  f.files.delete(wordPath);
  f.fail(wordPath);
  await assert.rejects(f.store.saveSidebarWord(withoutContext, result), /模拟磁盘失败/);
  f.fail('');
  await f.store.saveSidebarWord(withoutContext, result);
  assert.match(f.files.get(wordPath)!, /原始语境\*\*\n\n> compelling\n/);
});

test('migration copies bounded sidebar cards to the shared word note and detects unrelated text', async () => {
  const seed = fixture();
  const selection = {sidebar:true as const,text:'compelling.',context:'The story is compelling.',contextOffset:13};
  const saved = await seed.store.saveSidebarWord(selection,result);
  const card = seed.files.get(saved.path)!.match(/<!-- note-digest:record:[\s\S]*?<!-- note-digest:record-end:[^\n]+\n/)![0];
  const legacy = `<!-- note-digest:sidebar-words -->\n# 侧栏学习笔记\n\n<!-- note-digest:group:word -->\n### 单词\n\n${card}\n<!-- note-digest:end:word -->\n`;
  const f = fixture();
  const article = await f.store.save(select(),result,'word','note');
  f.files.set(SIDEBAR_NOTE_PATH,legacy + '\n我的手工备注\n');
  const first = await f.store.copyLegacySidebarWords();
  assert.equal(first?.cards,1);
  assert.equal(first?.onlyCards,false);
  assert.deepEqual(first?.paths,[article.targets[0].path]);
  assert.ok(f.files.get(article.targets[0].path)!.includes(card));
  assert.equal(f.files.get(SIDEBAR_NOTE_PATH),legacy + '\n我的手工备注\n');
  f.files.set(SIDEBAR_NOTE_PATH,legacy);
  const restarted = new CollectionStore(loadCollection(f.durable()),f.port);
  assert.equal((await restarted.copyLegacySidebarWords())?.onlyCards,true);
  assert.equal(f.files.get(article.targets[0].path)!.split(card).length,2);
  assert.equal((await restarted.saveSidebarWord(selection,result)).duplicate,true);
});

test('article and sidebar saves reuse a renamed sidebar-only word note', async () => {
  const f = fixture();
  const saved = await f.store.saveSidebarWord(sidebarWord('A compelling story.'), result);
  const renamed = 'Moved/Compelling.md';
  f.files.set(renamed, f.files.get(saved.path)!);
  f.files.delete(saved.path);
  await f.store.rename(saved.path,renamed);
  const restarted = new CollectionStore(loadCollection(f.durable()),f.port);
  assert.ok(restarted.isLearningNote(renamed));
  assert.equal((await restarted.save(select(),result,'word','note')).targets[0].path,renamed);
  assert.equal((await restarted.saveSidebarWord(sidebarWord('A compelling example.'), result)).path,renamed);
});

test('both save paths set vocabulary properties and keep them through append and undo', async () => {
  const f=fixture();
  const lexical = {...result, dictionarySenses:[{partOfSpeech:'形容词',meaning:'有说服力的',pronunciation:'/kəmˈpelɪŋ/'}],
    wordFamily:[{word:'compel',partOfSpeech:'动词',meaning:'迫使'}]};
  const first = await f.store.save(select(),lexical,'word','note');
  const wordPath = first.targets[0].path;
  const saved = f.files.get(wordPath)!;
  assert.match(saved, /^---\ndigest_word: "compelling"\ndigest_pos: \["形容词"\]\ndigest_ipa: \["\/kəmˈpelɪŋ\/"\]\ndigest_meaning: \["有说服力的"\]/);
  assert.match(wordNoteBody(saved), /\*\*同族词\*\*\n\n- \*\*compel\*\* · 动词 · 迫使/);
  assert.ok((await f.store.undoSave(first.undo!))?.complete);
  assert.match(f.files.get(wordPath)!, /digest_has_cards: false/);
  assert.doesNotMatch(f.files.get(wordPath)!, /<!-- note-digest:record:/);
  const sidebar = await f.store.saveSidebarWord(sidebarWord('A compelling example.'), {...lexical, dictionarySenses:[]});
  assert.equal(sidebar.path,wordPath);
  assert.match(f.files.get(wordPath)!, /digest_has_cards: true/);
  assert.match(f.files.get(wordPath)!, /digest_meaning: \["有说服力的"\]/);
  const newSidebar = await f.store.saveSidebarWord({sidebar:true,text:'issue',context:'An important issue.',contextOffset:13}, {...lexical,
    headword:'issue',dictionarySenses:[{partOfSpeech:'名词',meaning:'问题',pronunciation:'/ˈɪʃuː/'},{partOfSpeech:'动词',meaning:'发布',pronunciation:'/ˈɪʃuː/'}]});
  assert.match(f.files.get(newSidebar.path)!, /digest_meaning: \["名词 · 问题","动词 · 发布"\]/);
});

test('indexing existing notes changes only properties and distinguishes common homographs', () => {
  const body = '<!-- note-digest:word-note:example -->\r\n# lead\r\n\r\nExisting card.\r\n';
  const existing = '---\r\ntags: [words]\r\ndigest_pos: ["我自己的词性"]\r\n---\r\n' + body;
  const senses = [{partOfSpeech:'动词',meaning:'带领',pronunciation:'/liːd/'},
    {partOfSpeech:'名词',meaning:'领先',pronunciation:'/liːd/'}, {partOfSpeech:'名词',meaning:'铅',pronunciation:'/led/'}];
  const indexed = addWordVocabulary(existing,'lead',senses);
  assert.equal(wordNoteBody(indexed),body);
  assert.match(indexed,/digest_ipa: \["动词 · \/liːd\/","名词 · \/liːd\/","名词 · \/led\/"\]\r\n/);
  assert.match(indexed,/"名词（\/led\/） · 铅"/);
  assert.match(indexed,/tags: \[words\]\r\ndigest_pos: \["我自己的词性"\]/);
  assert.equal(addWordVocabulary(indexed,'lead',senses),indexed);
});

test('both targets retain full explanation, source body and saved identity', async () => {
  const f=fixture(); const saved=await f.store.save(select(),result,'word','both');
  assert.ok(saved.targets.every(t=>t.ok)); assert.equal(f.store.recordsFor(path).length,1);
  for(const t of saved.targets) {
    const text=f.files.get(t.path)!;
    for(const field of ['音标','语境含义','用法','例句','另一个搭配']) assert.ok(text.includes(field));
  }
  assert.equal(articleBody(f.files.get(path)!),source);
  assert.equal(locateAnchor(f.files.get(path)!,saved.record.anchor),source.indexOf('compelling'));
  assert.equal(new CollectionStore(loadCollection(f.durable()), f.port).recordsFor(path).length,1);
});
test('a short word in a long clipping with whitespace-only blank lines can be saved and located', async () => {
  const f = fixture();
  const paragraph = 'Some surrounding text. '.repeat(30).trim();
  const body = [...Array(40).fill(paragraph), 'A compelling argument.', paragraph].join('\r\n \t\r\n');
  assert.ok(body.length > 24000);
  f.files.set(path, body);
  const word = snapshot(path, body, 'compelling');
  const saved = await f.store.save(word, result, 'word', 'both');
  assert.ok(saved.targets.every(target => target.ok));
  assert.equal(saved.record.anchor.block, 'A compelling argument.');
  assert.equal(articleBody(f.files.get(path)!), body);
  assert.equal(locateAnchor(f.files.get(path)!, saved.record.anchor), word.start);
});
test('an older anchor across whitespace-only blank lines remains locatable and reuses the existing card', async () => {
  const f = fixture();
  const body = 'Preface.\n \nA compelling argument.';
  f.files.set(path, body);
  const first = await f.store.save(snapshot(path, body, 'compelling'), result, 'word', 'note');
  const historical = f.durable();
  historical.records[0].anchor = {block: body, offset: body.indexOf('compelling'), text: 'compelling'};
  assert.equal(locateAnchor(body, historical.records[0].anchor), body.indexOf('compelling'));
  const reopened = new CollectionStore(loadCollection(historical), f.port);
  const again = await reopened.save(snapshot(path, body, 'compelling'), result, 'word', 'note');
  assert.equal(again.record.id, first.record.id);
  assert.equal(reopened.recordsFor(path).length, 1);
});
test('repeat save and recapture after generated tail never duplicate or overwrite manual edits', async () => {
  const f=fixture(); const first=await f.store.save(select(),result,'word','both');
  const note=first.targets[1].path;
  f.files.set(note,f.files.get(note)!+'\n我的手工备注');
  const updated=snapshot(path,f.files.get(path)!,'compelling',source.indexOf('compelling'));
  const again=await f.store.save(updated,{...result,translation:'模型新答案'},'word','both');
  assert.equal(again.record.id,first.record.id);
  assert.equal(again.record.result.translation,result.translation);
  assert.equal(f.files.get(note)!.split(`<!-- note-digest:record:${first.record.id} -->`).length,2);
  assert.ok(f.files.get(note)!.endsWith('我的手工备注'));
});
test('different contexts and different kinds remain separate', async()=>{
  const f=fixture(); await f.store.save(select(),result,'word','note');
  await f.store.save(snapshot(path,source,'compelling',source.lastIndexOf('compelling')),result,'word','note');
  await f.store.save(snapshot(path,source,'A compelling argument.'),result,'quote','note');
  assert.equal(f.store.recordsFor(path).length,3);
});

test('accidental whitespace, punctuation and partial neighboring words reuse the saved card', async () => {
  const f = fixture();
  const body = 'The Supply, “Stranglehold,” Loosens.\n\nA Stranglehold remains.';
  f.files.set(path, body);
  const saved = await f.store.save(snapshot(path, body, 'Stranglehold', body.indexOf('Stranglehold')), result, 'word', 'both');
  const before = new Map(f.files);
  for (const text of ['Stranglehold,', ' “Stranglehold,” ', 'ly, “Stranglehold,” Lo']) {
    const again = await f.store.save(snapshot(path, body, text), {...result, translation:'新译文'}, 'word', 'both');
    assert.equal(again.record.id, saved.record.id);
    assert.deepEqual(again.targets.map(target => target.message), ['已收藏', '已收藏']);
    assert.deepEqual(f.files, before);
  }
  const phrase = await f.store.save(snapshot(path, body, 'Supply, “Stranglehold'), result, 'word', 'note');
  assert.notEqual(phrase.record.id, saved.record.id);
  assert.equal(phrase.record.anchor.text, 'Supply, “Stranglehold');
  const second = await f.store.save(snapshot(path, body, 'Stranglehold', body.lastIndexOf('Stranglehold')), result, 'word', 'note');
  assert.notEqual(second.record.id, saved.record.id);
});

test('new cards omit accidental edges and match legacy anchors without rewriting them', async () => {
  const f = fixture();
  const first = await f.store.save(snapshot(path, source, ' compelling ar'), result, 'word', 'note');
  assert.equal(first.record.anchor.text, 'compelling');
  const data = f.durable();
  const legacy = data.records[0].anchor;
  legacy.text = 'compelling ';
  const reopened = new CollectionStore(loadCollection(data), f.port);
  const again = await reopened.save(select(), result, 'word', 'note');
  assert.equal(again.record.id, first.record.id);
  assert.equal(again.record.anchor.text, 'compelling ');
  assert.equal(again.targets[0].message, '已收藏');
});

test('new collections distinguish identical paragraphs using confirmed source positions after reload', async () => {
  const f = fixture();
  const body = 'A compelling argument.\n\nA compelling argument.';
  f.files.set(path, body);
  const first = await f.store.save(snapshot(path, body, 'compelling', body.indexOf('compelling')), result, 'word', 'note');
  const second = await f.store.save(snapshot(path, body, 'compelling', body.lastIndexOf('compelling')), result, 'word', 'note');
  assert.notEqual(second.record.id, first.record.id);
  const reopened = new CollectionStore(loadCollection(f.durable()), f.port);
  const again = await reopened.save(snapshot(path, body, 'compelling ar', body.lastIndexOf('compelling')), result, 'word', 'note');
  assert.equal(again.record.id, second.record.id);
  assert.equal(again.targets[0].message, '已收藏');
});
test('partial failure can retry after reload without duplicating successful target',async()=>{
  const f=fixture();f.fail('Digest/');
  const first=await f.store.save(select(),result,'word','both');
  assert.equal(first.targets[0].ok,true);assert.equal(first.targets[1].ok,false);
  const afterSource=f.files.get(path);f.fail('');
  const restarted=new CollectionStore(loadCollection(f.durable()),f.port);
  const retry=await restarted.save(select(),result,'word','both');
  assert.ok(retry.targets.every(t=>t.ok));assert.equal(f.files.get(path),afterSource);assert.equal(retry.record.id,first.record.id);
});
test('all-target failure does not highlight; durable intent is reusable',async()=>{
  const f=fixture();f.fail('Digest/');
  const failed=await f.store.save(select(),result,'word','note');
  assert.equal(failed.targets[0].ok,false);assert.equal(f.store.recordsFor(path).length,0);
  f.fail('');const retry=await f.store.save(select(),result,'word','note');assert.equal(retry.record.id,failed.record.id);
});
test('metadata failure prevents writes and does not poison later operations',async()=>{
  const f=fixture();f.failPersist(true);
  await assert.rejects(f.store.save(select(),result,'word','both'));
  assert.equal(f.files.size,1);assert.equal(f.store.recordsFor(path).length,0);
  f.failPersist(false);await f.store.save(select(),result,'word','note');assert.equal(f.store.recordsFor(path).length,1);
});
test('concurrent saves and settings update serialize without losing records or secrets reference',async()=>{
  const f=fixture();await Promise.all([f.store.save(select(),result,'word','both'),f.store.setSecretName('deepseek-name'),f.store.save(select(),result,'word','both')]);
  assert.equal(f.durable().secretName,'deepseek-name');assert.equal(f.durable().records.length,1);
});
test('source change, deleted source, translation-only word and generated learning area refuse save',async()=>{
  const f=fixture();f.files.set(path,source+' Changed');await assert.rejects(f.store.save(select(),result,'word','source'),/原文/);
  f.files.delete(path);await assert.rejects(f.store.save(select(),result,'word','source'),/原文/);
  f.files.set(path,source);await assert.rejects(f.store.save(select(),{translation:'词'},'word','source'));
  const withTail=source+LEARNING_BOUNDARY+'generated unique text';
  assert.throws(()=>snapshot(path,withTail,'generated unique text'));
});
test('rename preserves document identity; cancellation preserves written notes; re-save is idempotent',async()=>{
  const f=fixture();const first=await f.store.save(select(),result,'word','both');
  const before=f.files.get(first.targets[1].path);
  await f.store.deactivate(first.record.id);assert.equal(f.store.recordsFor(path).length,0);assert.equal(f.files.get(first.targets[1].path),before);
  await f.store.rename('Articles','Moved');f.files.set('Moved/Learning.md',f.files.get(path)!);f.files.delete(path);
  const next=await f.store.save({...select(),path:'Moved/Learning.md'},result,'word','both');
  assert.equal(next.record.id,first.record.id);assert.equal(f.store.recordsFor('Moved/Learning.md').length,1);
  await f.store.rename('Moved/Learning.md',null);assert.equal(f.store.recordsFor('Moved/Learning.md').length,0);
});
test('foreign learning note collision refuses overwrite',async()=>{
  const f=fixture();
  const wordNote='Digest/单词学习/compelling.md';
  f.files.set(wordNote,'用户已有内容');
  const saved=await f.store.save(select(),result,'word','note');
  assert.equal(saved.targets[0].ok,false);
  assert.equal(f.files.get(wordNote),'用户已有内容');
});
test('load rejects invalid/future data instead of discarding it; legacy settings migrate',()=>{
  assert.equal(loadCollection({secretName:'name'}).secretName,'name');
  for(const data of [{version:2},{secretName:'name',unexpected:[]},{version:1,secretName:'',documents:[{id:'x',path:'../x.md',notePath:'n.md'}],records:[]}]) assert.throws(()=>loadCollection(data));
});
test('Markdown output escapes model markup and preserves correction',async()=>{
  const f=fixture();const r={...result,usage:'<script> [[evil]]',assessment:{status:'incorrect' as const,explanation:'语法问题',correction:'He goes.'}};
  const saved=await f.store.save(select(),r,'word','note');const text=f.files.get(saved.targets[0].path)!;
  assert.ok(!text.includes('<script>'));assert.ok(!text.includes('[[evil]]'));assert.ok(text.includes('建议改法'));assert.ok(text.includes('He goes'));
});

test('source changes between read and atomic update cannot be overwritten',async()=>{
  const f=fixture();const originalUpdate=f.port.update;
  f.port.update=async (p,transform)=>{
    if(p===path) f.files.set(path,source+'\n\n用户刚写的新段落');
    return originalUpdate(p,transform);
  };
  const report=await f.store.save(select(),result,'word','both');
  assert.equal(report.targets[0].ok,false);assert.equal(report.targets[1].ok,true);
  assert.equal(f.files.get(path),source+'\n\n用户刚写的新段落');
});
test('file write followed by metadata failure recovers with the same record on retry',async()=>{
  const f=fixture();const persist=f.port.persist;let count=0;
  f.port.persist=async data=>{if(++count===2)throw new Error('元数据暂不可写');await persist(data);};
  const first=await f.store.save(select(),result,'word','source');assert.equal(first.targets[0].ok,false);
  const written=f.files.get(path);assert.ok(written!.includes('note-digest:record'));
  const restarted=new CollectionStore(loadCollection(f.durable()),f.port);
  const next=await restarted.save(select(),result,'word','source');
  assert.equal(next.record.id,first.record.id);assert.equal(next.targets[0].ok,true);assert.equal(f.files.get(path),written);
});

test('compact cards put IPA and translation before short context with no duplicate word or per-card metadata',async()=>{
  const f=fixture();const saved=await f.store.save(select(),result,'word','both');
  const card=recordMarkdown(saved.record,f.durable().documents[0]);
  assert.ok(!card.includes('返回原文'));assert.ok(!card.includes(saved.record.createdAt.slice(0,10)));
  assert.ok(!card.includes('> compelling\n'));
  assert.ok(card.indexOf('**音标**')<card.indexOf('有说服力的'));
  assert.ok(card.indexOf('有说服力的')<card.indexOf('原始语境'));
  assert.ok(!card.includes('A compelling story'));
  assert.ok(f.files.get(saved.targets[1].path)!.includes('返回原文')); // one link at notebook top
});
test('legacy cleanup changes only exact generated cards and is repeatable',async()=>{
  const {compactLegacyCards}=await import('../src/collection');
  const f=fixture();const saved=await f.store.save(snapshot(path,source,'A compelling argument.'),{translation:'有说服力的论点'},'quote','both');
  const doc=f.durable().documents[0], rec=saved.record;
  const old=`\n\n<!-- note-digest:record:${rec.id} -->\n### 金句：A compelling argument\\.\n\n[返回原文](/Articles/Learning.md) · ${rec.createdAt.slice(0,10)}\n\n> A compelling argument\\.\n\n**中文翻译**\n\n> 有说服力的论点\n`;
  const before='原文不动'+old+'\n手工备注';
  const compact=compactLegacyCards(before,[rec],doc);
  assert.equal(compact.count,1);assert.ok(compact.text.startsWith('原文不动'));assert.ok(compact.text.includes('手工备注'));assert.ok(compact.text.includes('### 金句'));assert.ok(compact.text.includes(recordMarkdown(rec,doc)));
  assert.equal(compactLegacyCards(compact.text,[rec],doc).count,0);
  const edited=before.replace('有说服力的论点','用户修改的译文');
  assert.deepEqual(compactLegacyCards(edited,[rec],doc),{text:edited,count:0});
  f.files.set(path,before);await f.store.compact(path);assert.equal(f.files.get(path),compact.text);
});

test('natural usage omits advice, errors preserve correction; words and quotes have distinct groups',async()=>{
  const f=fixture();const word=await f.store.save(select(),result,'word','both');
  const card=recordMarkdown(word.record,f.durable().documents[0]);assert.ok(!card.includes('表达判断'));
  const quote=await f.store.save(snapshot(path,source,'A compelling argument.'),{translation:'有说服力的论点'},'quote','both');
  const text=f.files.get(path)!;
  const wordStart=text.indexOf('<!-- note-digest:group:word -->');const wordEnd=text.indexOf('<!-- note-digest:end:word -->');
  assert.ok(text.indexOf('#### compelling')>wordStart && text.indexOf('#### compelling')<wordEnd);
  assert.ok(text.indexOf('#### 金句')>wordEnd);
  assert.doesNotMatch(f.files.get(word.targets[1].path)!, /### 金句/);
  assert.doesNotMatch(f.files.get(quote.targets[1].path)!, /### 单词/);
});

test('one independent note combines distinct article contexts and undo preserves the other source', async () => {
  const f=fixture();
  const other='Articles/Second.md';
  const otherSource='A compelling case study.';
  f.files.set(other,otherSource);
  const first=await f.store.save(select(),result,'word','note');
  const last=await f.store.save(snapshot(other,otherSource,'compelling'),{...result, headword:'Compelling', translation:'引人入胜的'},'word','note');
  const wordPath='Digest/单词学习/compelling.md';
  assert.equal(first.targets[0].path,wordPath);
  assert.equal(last.targets[0].path,wordPath);
  const combined=f.files.get(wordPath)!;
  assert.match(combined, /# compelling\n[\s\S]*?\[返回原文\]\(\/Articles\/Learning\.md\)[\s\S]*?\[返回原文\]\(\/Articles\/Second\.md\)[\s\S]*?#### compelling/);
  assert.match(combined,/A compelling argument/);
  assert.match(combined,/A compelling case study/);
  assert.equal((await f.store.undoSave(last.undo!))?.complete,true);
  const remaining=f.files.get(wordPath)!;
  assert.match(remaining,/返回原文\]\(\/Articles\/Learning\.md\)/);
  assert.doesNotMatch(remaining,/Articles\/Second\.md|case study/);
  assert.equal(f.store.recordsFor(path).length,1);
  assert.equal(f.store.recordsFor(other,true).length,0);
});

test('splitting a legacy note copies an edited bounded word card before removing it and resumes safely', async () => {
  const f=fixture();
  const saved=await f.store.save(select(),result,'word','source');
  const data=f.durable();
  const doc=data.documents[0];
  const record=data.records[0];
  delete record.wordNote;
  record.savedTo.push(doc.notePath);
  const oldCard=recordMarkdown(saved.record,doc).replace('**语境含义**','我的卡内补充\n\n**语境含义**');
  const legacyHeader=`<!-- note-digest:document:${doc.id} -->\n# 旧笔记\n`;
  const legacy=legacyHeader + oldCard + '\n卡片外的个人笔记';
  f.files.set(doc.notePath,legacy);
  const articleBefore=f.files.get(path);
  const store=new CollectionStore(loadCollection(data),f.port);
  f.fail('Digest/文章学习/');
  const interrupted=await store.splitWordNotes();
  assert.equal(interrupted.failures.length,1);
  assert.equal(f.files.get(doc.notePath),legacy);
  f.fail('');
  const restarted=new CollectionStore(loadCollection(f.durable()),f.port);
  assert.deepEqual(await restarted.splitWordNotes(),{moved:1,notes:1,failures:[]});
  const word=f.files.get('Digest/单词学习/compelling.md')!;
  assert.ok(word.includes(oldCard.trimStart()));
  assert.equal(word.split(`<!-- note-digest:record:${record.id} -->`).length,2);
  assert.equal(f.files.get(doc.notePath),legacyHeader + '\n\n\n卡片外的个人笔记');
  assert.equal(f.files.get(path),articleBefore);
  assert.deepEqual(await restarted.splitWordNotes(),{moved:0,notes:0,failures:[]});
});
test('group insertion preserves edited entries and refuses broken group boundaries',async()=>{
  const f=fixture();await f.store.save(select(),result,'word','source');
  const current=f.files.get(path)!;f.files.set(path,current.replace('<!-- note-digest:end:word -->','手工破坏的标记'));
  const second=snapshot(path,f.files.get(path)!,'compelling',source.lastIndexOf('compelling'));
  const before=f.files.get(path);const report=await f.store.save(second,result,'word','source');
  assert.equal(report.targets[0].ok,false);assert.equal(f.files.get(path),before);
});

test('delete removes both saved copies and highlight, preserving source and other contexts',async()=>{
  const f=fixture();const first=await f.store.save(select(),result,'word','both');
  const other=await f.store.save(snapshot(path,source,'compelling',source.lastIndexOf('compelling')),result,'word','both');
  const deleted=await f.store.removeNotes(first.record.id);assert.equal(deleted.complete,true);
  assert.equal(articleBody(f.files.get(path)!),source);
  for(const target of first.targets){
    const text=f.files.get(target.path)!;assert.ok(!text.includes(`note-digest:record:${first.record.id}`));assert.ok(text.includes(`note-digest:record:${other.record.id}`));
  }
  assert.equal(f.store.recordsFor(path).length,1);assert.equal(f.store.recordsFor(path,true).length,1);
  assert.equal((await f.store.removeNotes(first.record.id)).complete,true);
});
test('undo removes the newly saved copy and keeps an earlier copy and its highlight', async () => {
  const f = fixture();
  const original = await f.store.save(select(),result,'word','source');
  const previous = f.files.get(path);
  const added = await f.store.save(select(),result,'word','both');
  const duplicate = await f.store.save(select(),result,'word','both');
  assert.equal(duplicate.undo, undefined);
  assert.equal((await f.store.undoSave(added.undo!))?.complete, true);
  assert.equal(f.files.get(path), previous);
  assert.ok(!f.files.get(added.targets[1].path)?.includes(`note-digest:record:${original.record.id}`));
  assert.deepEqual(f.store.recordsFor(path).map(record => record.savedTo), [[path]]);
  assert.equal(await f.store.undoSave(original.undo!), undefined);
});
test('undo retries only unfinished copies after a reload and preserves hand-edited cards', async () => {
  const f = fixture();
  const saved = await f.store.save(select(),result,'word','both');
  const notePath = saved.targets[1].path;
  const clean = f.files.get(notePath)!;
  const edited = clean.replace('有说服力的', '我手工修改过');
  f.files.set(notePath, edited);
  const partial = await f.store.undoSave(saved.undo!);
  assert.deepEqual(partial?.targets.map(target => target.ok), [true,false]);
  assert.equal(f.files.get(notePath), edited);
  assert.equal(f.store.recordsFor(path).length, 0);
  assert.deepEqual(f.store.recordsFor(path,true)[0].pendingUndo?.paths, [notePath]);
  await assert.rejects(f.store.save(select(), result, 'word', 'both'), /撤销尚未完成/);
  f.files.set(notePath, clean);
  const restarted = new CollectionStore(loadCollection(f.durable()),f.port);
  assert.equal((await restarted.undoSave(saved.record.id))?.complete, true);
  assert.equal(restarted.recordsFor(path,true).length, 0);
  assert.equal(articleBody(f.files.get(path)!), source);
});
test('undo handles fallback to an independent note and can retry after status persistence fails', async () => {
  const f = fixture();
  f.fail(path);
  const saved = await f.store.save(select(),result,'word','both');
  f.fail('');
  const persist = f.port.persist;
  let commits = 0;
  f.port.persist = async data => {
    if (++commits === 2) throw new Error('状态写入失败');
    await persist(data);
  };
  await assert.rejects(f.store.undoSave(saved.undo!), /状态写入失败/);
  assert.equal(f.files.get(path), source);
  const restarted = new CollectionStore(loadCollection(f.durable()),f.port);
  assert.equal((await restarted.undoSave(saved.record.id))?.complete, true);
  assert.equal(restarted.recordsFor(path,true).length, 0);
});
test('inactive retained records remain deletable; missing files are not recreated',async()=>{
  const f=fixture();const saved=await f.store.save(select(),result,'word','both');
  await f.store.deactivate(saved.record.id);assert.equal(f.store.recordsFor(path).length,0);assert.equal(f.store.recordsFor(path,true).length,1);
  f.files.delete(saved.targets[1].path);await f.store.removeNotes(saved.record.id);
  assert.equal(f.files.has(saved.targets[1].path),false);assert.equal(f.store.recordsFor(path,true).length,0);
});
test('partially failed deletion cancels highlight and survives reload for retry',async()=>{
  const f=fixture();const saved=await f.store.save(select(),result,'word','both');f.fail('Digest/');
  const partial=await f.store.removeNotes(saved.record.id);assert.equal(partial.complete,false);assert.equal(f.store.recordsFor(path).length,0);
  assert.equal(f.store.recordsFor(path,true)[0].deletionPending,true);
  const afterSource=f.files.get(path);f.fail('');const restarted=new CollectionStore(loadCollection(f.durable()),f.port);
  const retry=await restarted.removeNotes(saved.record.id);assert.equal(retry.complete,true);assert.equal(f.files.get(path),afterSource);
  assert.equal(restarted.recordsFor(path,true).length,0);
});
test('metadata failure before cancellation leaves both documents intact',async()=>{
  const f=fixture();const saved=await f.store.save(select(),result,'word','both');const before=new Map(f.files);
  f.failPersist(true);await assert.rejects(f.store.removeNotes(saved.record.id));assert.deepEqual(f.files,before);assert.equal(f.store.recordsFor(path).length,1);
});
test('bounded edited card can be removed without deleting manual notes outside it',async()=>{
  const f=fixture();const saved=await f.store.save(select(),result,'word','source');
  const end=`<!-- note-digest:record-end:${saved.record.id} -->`;
  f.files.set(path,f.files.get(path)!.replace(end,'这张卡片的补充\n'+end)+'\n卡片外的私人备注');
  await f.store.removeNotes(saved.record.id);const remaining=f.files.get(path)!;
  assert.ok(!remaining.includes('这张卡片的补充'));assert.ok(remaining.includes('卡片外的私人备注'));assert.equal(articleBody(remaining),source);
});
test('legacy exact card deletes safely while modified unbounded legacy card is retained',async()=>{
  const f=fixture();const saved=await f.store.save(select(),result,'word','source');
  const old=f.files.get(path)!.replace(`<!-- note-digest:record-end:${saved.record.id} -->\n`,'');
  f.files.set(path,old.replace('有说服力的','用户修改的译文'));
  const edited=f.files.get(path);const blocked=await f.store.removeNotes(saved.record.id);
  assert.equal(blocked.complete,false);assert.equal(f.files.get(path),edited);
  f.files.set(path,old);assert.equal((await f.store.removeNotes(saved.record.id)).complete,true);
});
test('duplicate markers and nested card boundaries stop deletion',async()=>{
  const f=fixture();const saved=await f.store.save(select(),result,'word','source');const base=f.files.get(path)!;
  const marker=`<!-- note-digest:record:${saved.record.id} -->`;
  for(const broken of [base+'\n'+marker,base.replace(`<!-- note-digest:record-end:${saved.record.id} -->`,'<!-- note-digest:record:another -->\n'+`<!-- note-digest:record-end:${saved.record.id} -->`)]){
    f.files.set(path,broken);assert.equal((await f.store.removeNotes(saved.record.id)).complete,false);assert.equal(f.files.get(path),broken);
  }
});
test('delete then save again recreates one card per target and reactivates highlight',async()=>{
  const f=fixture();const first=await f.store.save(select(),result,'word','both');await f.store.removeNotes(first.record.id);
  const again=await f.store.save(select(),result,'word','both');assert.equal(again.record.id,first.record.id);assert.equal(f.store.recordsFor(path).length,1);
  for(const target of again.targets) assert.equal(f.files.get(target.path)!.split(`<!-- note-digest:record:${again.record.id} -->`).length,2);
});
test('write success followed by metadata failure leaves a retryable deletion intent',async()=>{
  const f=fixture();const saved=await f.store.save(select(),result,'word','both');const persist=f.port.persist;let count=0;
  f.port.persist=async data=>{if(++count===2)throw new Error('状态写入失败');await persist(data);};
  const partial=await f.store.removeNotes(saved.record.id);assert.equal(partial.complete,false);
  const restarted=new CollectionStore(loadCollection(f.durable()),f.port);assert.equal((await restarted.removeNotes(saved.record.id)).complete,true);
});

test('save feedback condenses duplicates and reports a failed destination', async () => {
  const f=fixture();
  await f.store.save(select(),result,'word','both');
  const duplicate=await f.store.save(select(),result,'word','both');
  assert.deepEqual(collectionFeedback(duplicate),{text:'本词已收藏',duplicate:true});
  f.fail('Digest/');
  const failure=await f.store.save(select(),result,'word','both');
  const feedback=collectionFeedback(failure);
  assert.equal(feedback.duplicate,false);
  assert.match(feedback.text,/部分位置已有收藏/);
  assert.match(feedback.text,/Digest.*模拟磁盘失败/);
  assert.ok(!feedback.text.includes(path));
});

test('explicit card cleanup removes the old word prefix only from an exact generated card', async () => {
  const {compactLegacyCards}=await import('../src/collection');
  const f=fixture();
  const saved=await f.store.save(select(),result,'word','source');
  const original=f.files.get(path)!;
  const legacy=original.replace('#### compelling','#### 词语：compelling');
  const doc=f.durable().documents[0];
  assert.deepEqual(compactLegacyCards(legacy,[saved.record],doc),{text:original,count:1});
  const edited=legacy.replace('有说服力的','手动补充');
  assert.deepEqual(compactLegacyCards(edited,[saved.record],doc),{text:edited,count:0});
});

test('explicit explanation update preserves manual paragraphs inside and outside both copies', async () => {
  const f = fixture();
  const saved = await f.store.save(select(),result,'word','both');
  const paths = saved.targets.map(target => target.path);
  for (const path of paths) {
    const text = f.files.get(path)!;
    f.files.set(path,text.replace('**语境含义**','我的卡内备注\n\n**语境含义**') + '\n我的卡外备注');
  }
  const edited = {...result, translation:'新版译文', meaning:'新版含义', example:'新版例句'};
  const before = new Map(f.files);
  const duplicate = await f.store.save(select(),edited,'word','both');
  assert.equal(duplicate.record.result.translation,result.translation);
  assert.deepEqual(f.files,before);
  assert.equal(await f.store.updateExplanation(select(),saved.record.id,edited),'已更新单词卡');
  for (const path of paths) {
    const text = f.files.get(path)!;
    assert.match(text,/> 新版译文/);
    assert.match(text,/我的卡内备注\n\n\*\*语境含义\*\*\n\n> 新版含义/);
    assert.match(text,/我的卡外备注$/);
    assert.equal(text.split(`<!-- note-digest:record:${saved.record.id} -->`).length,2);
  }
  assert.equal(articleBody(f.files.get(path)!),source);
  assert.deepEqual(f.store.recordsFor(path)[0].result,edited);
});

test('a manually edited generated field protects both copies before an update starts', async () => {
  const f = fixture();
  const saved = await f.store.save(select(),result,'word','both');
  const note = saved.targets[1].path;
  f.files.set(note,f.files.get(note)!.replace('> 有说服力的','> 自己改过的译文'));
  const before = new Map(f.files);
  await assert.rejects(f.store.updateExplanation(select(),saved.record.id,{...result, translation:'新版译文'}),/手工修改/);
  assert.deepEqual(f.files,before);
  assert.equal(f.durable().records[0].pendingExplanation,undefined);
});

test('partial card update resumes the original explanation after reopening', async () => {
  const f = fixture();
  const saved = await f.store.save(select(),result,'word','both');
  f.fail('Digest/');
  assert.match(await f.store.updateExplanation(select(),saved.record.id,{...result,translation:'这次的译文'}),/尚未完成/);
  const sourceAfter = f.files.get(path);
  assert.match(sourceAfter!,/这次的译文/);
  f.fail('');
  const reopened = new CollectionStore(loadCollection(f.durable()),f.port);
  assert.equal(await reopened.updateExplanation(select(),saved.record.id,{...result,translation:'另一份解释'}),'已完成上次更新');
  assert.equal(f.files.get(path),sourceAfter);
  assert.match(f.files.get(saved.targets[1].path)!,/这次的译文/);
  assert.equal(f.durable().records[0].pendingExplanation,undefined);
  assert.equal(f.durable().records[0].result.translation,'这次的译文');
});

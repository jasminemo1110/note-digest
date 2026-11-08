import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollectionStore, loadCollection, recordMarkdown, type CollectionData, type StoragePort } from '../src/collection';
import { snapshot, type DigestResult } from '../src/core';
import { articleBody, locateAnchor, LEARNING_BOUNDARY } from '../src/anchors';
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
  const f=fixture();f.files.set('Digest/文章学习/Learning--id-1.md','用户已有内容');
  const saved=await f.store.save(select(),result,'word','note');assert.equal(saved.targets[0].ok,false);assert.equal(f.files.get('Digest/文章学习/Learning--id-1.md'),'用户已有内容');
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
  await f.store.save(snapshot(path,source,'A compelling argument.'),{translation:'有说服力的论点'},'quote','both');
  for(const target of word.targets){
    const text=f.files.get(target.path)!;assert.ok(text.includes('### 单词'));assert.ok(text.includes('### 金句'));
    const wordStart=text.indexOf('<!-- note-digest:group:word -->');const wordEnd=text.indexOf('<!-- note-digest:end:word -->');
    assert.ok(text.indexOf('#### 词语')>wordStart && text.indexOf('#### 词语')<wordEnd);
    assert.ok(text.indexOf('#### 金句')>wordEnd);
  }
});
test('group insertion preserves edited entries and refuses broken group boundaries',async()=>{
  const f=fixture();await f.store.save(select(),result,'word','source');
  const current=f.files.get(path)!;f.files.set(path,current.replace('<!-- note-digest:end:word -->','手工破坏的标记'));
  const second=snapshot(path,f.files.get(path)!,'compelling',source.lastIndexOf('compelling'));
  const before=f.files.get(path);const report=await f.store.save(second,result,'word','source');
  assert.equal(report.targets[0].ok,false);assert.equal(f.files.get(path),before);
});

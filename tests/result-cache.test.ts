import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest, type Transport } from '../src/provider';
import { ResultCache } from '../src/result-cache';

function storage() {
  const values = new Map<string, unknown>();
  return { values, load: (key: string) => values.get(key),
    save: (key: string, value: unknown) => { if (value === null) values.delete(key); else values.set(key, value); } };
}

function response(value: unknown) {
  return {status: 200, json: {choices: [{finish_reason: 'stop', message: {content: JSON.stringify(value)}}]}};
}

test('cache deduplicates in-flight requests and only persists when enabled', async () => {
  const local = storage();
  const cache = new ResultCache(local);
  let calls = 0;
  const transport: Transport = async () => response({translation: `译文 ${++calls}`});
  const selected = {text: 'right', context: 'Turn right.'};
  const translate = (cache: ResultCache, regenerate = false, onRequest?: () => void) =>
    digest(selected, 'translate', 'test', transport, {cache, regenerate, onRequest});
  const [first, second] = await Promise.all([translate(cache), translate(cache)]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(local.values.size, 0);
  assert.equal((await translate(cache, false, () => assert.fail('cache hit showed request progress'))).translation, '译文 1');
  cache.setPersistent(true);
  assert.equal((await translate(new ResultCache(local))).translation, '译文 1');
  assert.equal((await translate(cache, true)).translation, '译文 2');
  assert.equal((await translate(new ResultCache(local))).translation, '译文 2');
  cache.setPersistent(false);
  assert.equal((await translate(cache)).translation, '译文 2');
  assert.equal((await translate(new ResultCache(local))).translation, '译文 3');
});

test('cache keeps identical words in different contexts and explanation separate from translation', async () => {
  const cache = new ResultCache(storage());
  let calls = 0;
  const transport: Transport = async request => {
    calls++;
    const payload = JSON.parse(request.body as string);
    const selected = JSON.parse(payload.messages[1].content);
    return response(payload.messages[0].content.includes('Also return headword')
      ? {translation:'正确', headword:'right', meaning:'合乎事实', usage:'be right', example:'You are right. 你说对了',
        pronunciation:null, assessment:{status:'natural', explanation:'自然', correction:null}}
      : {translation: selected.selectionOffset === 0 ? '正确' : '右边'});
  };
  const first = {text:'right', context:'right, turn right', contextOffset:0};
  const second = {...first, contextOffset:12};
  const run = (selection: typeof first, action: 'translate' | 'explain') =>
    digest(selection, action, 'test', transport, {cache});
  assert.equal((await run(first, 'translate')).translation, '正确');
  assert.equal((await run(second, 'translate')).translation, '右边');
  assert.equal((await run(first, 'explain')).meaning, '合乎事实');
  assert.equal((await run(first, 'explain')).meaning, '合乎事实');
  assert.equal(calls, 3);
});

test('a malformed replacement leaves the previous validated result available', async () => {
  const cache = new ResultCache(storage());
  let calls = 0;
  const transport: Transport = async () => response({translation: ++calls === 1 ? '原来的结果' : ''});
  const run = (regenerate = false) => digest({text:'yes', context:'yes'}, 'translate', 'test', transport, {cache, regenerate});
  await run();
  await assert.rejects(run(true), /格式异常/);
  assert.equal((await run()).translation, '原来的结果');
  assert.equal(calls, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, languageInstruction, type Transport } from '../src/provider';
import { snapshot } from '../src/core';
const selected = snapshot('a.md', 'A compelling argument.', 'compelling');
const credential = 'synthetic-test-value';

test('temporary request includes bounded context and only returns validated fields', async () => {
  const transport: Transport = async request => {
    const body = JSON.parse(request.body as string);
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(JSON.parse(body.messages[1].content), {selected: selected.text, context: selected.context});
    return { status: 200, json: {choices: [{finish_reason: 'stop', message: {content: '{"translation":"有说服力的"}'}}]} };
  };
  assert.deepEqual(await digest(selected, 'translate', credential, transport), {translation:'有说服力的'});
});
test('missing secret prevents any network request', async () => {
  await assert.rejects(digest(selected, 'translate', '', async () => { throw new Error('must not execute'); }), /设置/);
});
test('truncation, malformed content and authentication fail safely', async () => {
  for (const response of [
    {status:401,json:{}},
    {status:200,json:{choices:[{finish_reason:'length',message:{content:'{}'}}]}},
    {status:200,json:{choices:[{finish_reason:'stop',message:{content:'not JSON'}}]}}
  ]) await assert.rejects(digest(selected, 'translate', credential, async () => response));
});
test('transport errors do not expose secrets or source text', async () => {
  await assert.rejects(digest(selected, 'translate', credential, async () => { throw new Error(credential + selected.text); }), error => {
    assert.equal((error as Error).message, '网络请求失败，请检查网络后重试。'); return true;
  });
});
test('Japanese interface is reserved but not enabled', () => {
  assert.throws(() => languageInstruction('ja'), /第二版/);
});

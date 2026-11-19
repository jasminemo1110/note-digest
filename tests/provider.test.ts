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
    assert.match(body.messages[0].content, /"translation" field must be a Simplified Chinese equivalent of the exact text in "selected"/);
    assert.match(body.messages[0].content, /Use "context" only to choose the intended sense/);
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

test('explanation request asks for IPA and distinguishes errors from register; results stay structured', async () => {
  const explanation = {headword:'compelling', translation:'有说服力的', meaning:'形容论点令人信服', usage:'a compelling argument', example:'Her argument is compelling. 她的论点很有说服力。', pronunciation:'/kəmˈpelɪŋ/', assessment:{status:'natural', explanation:'与 argument 搭配自然。', correction:null}};
  const transport: Transport = async request => {
    const prompt = JSON.parse(request.body as string).messages[0].content;
    assert.match(prompt, /IPA/); assert.match(prompt, /informal/); assert.match(prompt, /uncertain/);
    assert.match(prompt, /Do not silently replace/);
    assert.match(prompt, /"translation" field must be a concise Simplified Chinese equivalent of the headword/);
    assert.match(prompt, /Put contextual elaboration in "meaning"/);
    return {status:200, json:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(explanation)}}]}};
  };
  assert.deepEqual(await digest(selected, 'explain', credential, transport), explanation);
});

test('inflected lookup teaches the base headword without changing the quoted source payload', async () => {
  const selection = snapshot('a.md', 'Interpreting Research Findings', 'Interpreting');
  const explanation = {headword:'interpret', translation:'解读；解释', meaning:'interpret 表示解读。原文 Interpreting 是其 -ing 形式，用于标题。', usage:'interpret findings 解读研究结果', example:'We interpret the data. 我们解读数据。', pronunciation:'/ɪnˈtɜːprɪt/', assessment:{status:'natural', explanation:'标题用法自然。', correction:null},
    commonUsages:[{partOfSpeech:'动词',meaning:'口译',example:'interpret for a guest（为一位客人口译）'}]};
  const response = await digest(selection, 'explain', credential, async request => {
    const body = JSON.parse(request.body as string);
    const prompt = body.messages[0].content;
    assert.match(prompt, /Interpreting -> interpret, went -> go/);
    assert.match(prompt, /glosses over -> gloss over/);
    assert.match(prompt, /Keep lexical adjectives/);
    assert.match(prompt, /pronunciation for the headword/);
    assert.match(prompt, /explicitly explain the original form/);
    assert.match(prompt, /Exclude the current sense/);
    assert.match(prompt, /Prefer one good entry to padding the list/);
    assert.deepEqual(JSON.parse(body.messages[1].content), {selected:'Interpreting', context:selection.context});
    return {status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify(explanation)}}]}};
  });
  assert.deepEqual(response, explanation);
  const {headword, ...missingHeadword} = explanation;
  await assert.rejects(digest(selection, 'explain', credential, async () => ({status:200,
    json:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(missingHeadword)}}]}})), /AI 返回格式异常/);
});

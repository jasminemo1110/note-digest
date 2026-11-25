import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, languageInstruction, type Transport } from '../src/provider';
import { snapshot } from '../src/core';
import { ResultCache } from '../src/result-cache';
const selected = snapshot('a.md', 'A compelling argument.', 'compelling');
const credential = 'synthetic-test-value';

test('temporary request includes bounded context and only returns validated fields', async () => {
  const transport: Transport = async request => {
    const body = JSON.parse(request.body as string);
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(body.model, 'deepseek-flash');
    assert.match(body.messages[0].content, /"translation" field must be a Simplified Chinese equivalent of the exact text in "selected"/);
    assert.match(body.messages[0].content, /Use "context" only to choose the intended sense/);
    assert.match(body.messages[0].content, /wordPronunciation as an object with uk and us/);
    assert.deepEqual(JSON.parse(body.messages[1].content), {selected: selected.text, context: selected.context});
    return { status: 200, json: {choices: [{finish_reason: 'stop', message: {content: '{"translation":"有说服力的","wordPronunciation":{"uk":"/kəmˈpelɪŋ/","us":"/kəmˈpelɪŋ/"}}'}}]} };
  };
  assert.deepEqual(await digest(selected, 'translate', credential, transport), {
    translation:'有说服力的', wordPronunciation:{uk:'/kəmˈpelɪŋ/', us:'/kəmˈpelɪŋ/'},
  });
});

test('IPA is requested only for a single word and validated before being shown or cached', async () => {
  const natural = snapshot('a.md', 'Natural recovery', 'Natural ');
  const phrase = snapshot('a.md', 'Natural recovery', 'Natural recovery');
  const response = (wordPronunciation: unknown): Awaited<ReturnType<Transport>> => ({
    status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify({translation:'自然恢复', wordPronunciation})}}]},
  });
  for (const invalid of [{uk:'/ˈnætʃərəl/', us:[]}, {uk:'/ /', us:'/ˈnætʃərəl/'}, {uk:'/a\nb/', us:'/c/'}]) {
    await assert.rejects(digest(natural, 'translate', credential, async () => response(invalid)), /AI 返回格式异常/);
  }
  assert.deepEqual(await digest(natural, 'translate', credential, async () => response(null)),
    {translation:'自然恢复', wordPronunciation:null});
  assert.deepEqual(await digest(phrase, 'translate', credential, async request => {
    assert.doesNotMatch(JSON.parse(request.body as string).messages[0].content, /wordPronunciation/);
    return response(null);
  }), {translation:'自然恢复'});
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
  const explanation = {headword:'compelling', translation:'有说服力的', meaning:'形容论点令人信服', usage:'a compelling argument', example:'Her argument is compelling. 她的论点很有说服力。', pronunciation:'/kəmˈpelɪŋ/', assessment:{status:'natural', explanation:'与 argument 搭配自然。', correction:null},
    wordFamily:[{word:'compel',pronunciation:'/kəmˈpel/',partOfSpeech:'动词',meaning:'迫使'}],
    dictionarySenses:[{partOfSpeech:'形容词',meaning:'令人信服的；引人入胜的',pronunciation:'/kəmˈpelɪŋ/'}]};
  const transport: Transport = async request => {
    const prompt = JSON.parse(request.body as string).messages[0].content;
    assert.match(prompt, /IPA/); assert.match(prompt, /informal/); assert.match(prompt, /uncertain/);
    assert.match(prompt, /Do not silently replace/);
    assert.match(prompt, /"translation" field must be a concise Simplified Chinese equivalent of the headword/);
    assert.match(prompt, /Put contextual elaboration in "meaning"/);
    assert.match(prompt, /Return wordFamily/);
    assert.match(prompt, /pronunciation \(standard IPA for that word and part of speech/);
    assert.match(prompt, /Exclude inflections, spelling variants, synonyms/);
    assert.match(prompt, /Return dictionarySenses.*independently of the selected sentence/);
    return {status:200, json:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(explanation)}}]}};
  };
  assert.deepEqual(await digest(selected, 'explain', credential, transport), explanation);
});

test('inflected lookup teaches the base headword without changing the quoted source payload', async () => {
  const selection = snapshot('a.md', 'Interpreting Research Findings', 'Interpreting');
  const explanation = {headword:'interpret', translation:'解读；解释', meaning:'interpret 表示解读。原文 Interpreting 是其 -ing 形式，用于标题。', usage:'interpret findings 解读研究结果', example:'We interpret the data. 我们解读数据。', pronunciation:'/ɪnˈtɜːprɪt/', assessment:{status:'natural', explanation:'标题用法自然。', correction:null},
    commonUsages:[{partOfSpeech:'动词',meaning:'口译',example:'interpret for a guest（为一位客人口译）'}],
    wordFamily:[{word:'interpretation',pronunciation:null,partOfSpeech:'名词',meaning:'解释；理解'}],
    dictionarySenses:[{partOfSpeech:'动词',meaning:'解释；口译',pronunciation:'英 /ɪnˈtɜːprət/；美 /ɪnˈtɝːprət/'}]};
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
    assert.deepEqual(JSON.parse(body.messages[1].content), {
      selectedContext:{before:'', after:' Research Findings'}, selected:'Interpreting', context:selection.context,
    });
    return {status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify(explanation)}}]}};
  });
  assert.deepEqual(response, explanation);
  const {headword, ...missingHeadword} = explanation;
  await assert.rejects(digest(selection, 'explain', credential, async () => ({status:200,
    json:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(missingHeadword)}}]}})), /AI 返回格式异常/);
});

test('context explanation anchors repeated words to the selected sentence and retries a false missing-sentence claim', async () => {
  const sentence = 'Years of drift took him from one temporary job to the next.';
  const source = '## drift\n\n- **n. 漂泊** · ' + sentence + '\n  多年的漂泊让他辗转于一份又一份临时工作。\n\nThey took part in a study.';
  const selection = snapshot('list.md', source, 'took', source.indexOf('took'));
  const explanation = {
    headword:'take', translation:'使……辗转', meaning:'took 是 take 的过去式，多年的漂泊使他辗转于一份又一份临时工作。',
    usage:'take someone from A to B 表示使某人从 A 到 B。',
    example:'The job took her from city to city. 这份工作让她辗转于不同城市。',
    pronunciation:'/teɪk/', assessment:{status:'natural', explanation:'搭配自然。', correction:null},
    wordFamily:[], dictionarySenses:[],
  };
  const contradiction = {...explanation, meaning:'具体义因原句未给出而无法确定。',
    assessment:{status:'uncertain', explanation:'上下文中没有出现被选中的“took”所在句子。', correction:null}};
  const response = (value: unknown) => ({
    status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify(value)}}]},
  });
  const storage = new Map<string, unknown>();
  const cached = () => new ResultCache({load:key=>storage.get(key), save:(key,value)=>{storage.set(key,value);}});
  let calls = 0;
  let repeatsContradiction = true;
  const transport: Transport = async ({body}) => {
    const [system, user] = JSON.parse(body as string).messages;
    const {selected, context, selectionOffset, selectedContext} = JSON.parse(user.content);
    assert.equal(selected, 'took');
    assert.equal(selectionOffset, source.indexOf('took'));
    assert.equal(context, source);
    const focus = selectedContext.before + selected + selectedContext.after;
    assert.ok(focus.includes(sentence));
    assert.ok(!focus.includes('took part'));
    if (++calls % 2 === 1) return response(contradiction);
    assert.match(system.content, /The sentence containing the selection is already in the source data/);
    return response(repeatsContradiction ? contradiction : explanation);
  };
  const run = () => digest(selection, 'explain', credential, transport, {cache:cached()});
  await assert.rejects(run(), /未能依据已提供的原句解释/);
  assert.equal(calls, 2);
  assert.equal(storage.size, 0);
  repeatsContradiction = false;
  assert.deepEqual(await run(), explanation);
  assert.deepEqual(await run(), explanation);
  assert.equal(calls, 4);
});

test('a real absence of context or ambiguity in a supplied sentence is not retried', async () => {
  for (const [context, explanation] of [
    ['right', '没有提供原句。'],
    ['That is right.', '有原句，但 right 可能指正确或恰当。'],
  ]) {
    const answer = {
      headword:null, translation:'正确或恰当', meaning:explanation, usage:'right 有多个常见义项。',
      example:'That is right. 那是对的。', pronunciation:null,
      assessment:{status:'uncertain', explanation, correction:null}, wordFamily:[], dictionarySenses:[],
    };
    let calls = 0;
    const result = await digest({text:'right',context}, 'explain', credential, async () => {
      calls++;
      return {status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify(answer)}}]}};
    });
    assert.deepEqual(result, answer);
    assert.equal(calls, 1);
  }
});

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
    commonUsages:[{partOfSpeech:'形容词',meaning:'引人入胜的',example:'a compelling story（一个引人入胜的故事）'}],
    wordFamily:[{word:'compel',pronunciation:'/kəmˈpel/',partOfSpeech:'动词',meaning:'迫使'}],
    dictionarySenses:[{partOfSpeech:'形容词',meaning:'令人信服的；引人入胜的',pronunciation:'/kəmˈpelɪŋ/'}]};
  let calls = 0;
  const transport: Transport = async request => {
    calls++;
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
  assert.equal(calls, 1);
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

test('a malformed vocabulary supplement does not discard the explanation for a phrase', async () => {
  const selection = snapshot('list.md', 'Several volunteers took part in a practice session.', 'took part ');
  const core = {headword:'take part', translation:'参加', meaning:'took part 是 take part 的过去式。',
    usage:'take part in + 活动', example:'She took part in the workshop. 她参加了研讨会。', pronunciation:'/teɪk pɑːt/',
    assessment:{status:'natural', explanation:'表达自然。', correction:null}};
  const dictionarySenses = [{partOfSpeech:'动词短语', meaning:'参加', pronunciation:'/teɪk pɑːt/'}];
  const contextExpression = {title:'take part in something', meaning:'参加某项活动', sourceText:'took part in a practice session'};
  const response = {...core, dictionarySenses, contextExpression,
    wordFamily:[{word:'take part', pronunciation:'/teɪk pɑːt/', partOfSpeech:'动词短语', meaning:'参加'}]};
  let calls = 0;
  const answer = await digest(selection, 'explain', credential, async () => {
    calls++;
    return {status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify(response)}}]}};
  });
  assert.deepEqual(answer, {...core, dictionarySenses, contextExpression});
  assert.equal(calls, 1);
});

test('an unusable explanation retries once with a shorter JSON request using the same source', async () => {
  const selection = snapshot('list.md', 'Several volunteers took part in a practice session.', 'took part ');
  const core = {headword:'take part', translation:'参加', meaning:'took part 是 take part 的过去式。',
    usage:'take part in + 活动', example:'She took part in the workshop. 她参加了研讨会。', pronunciation:'/teɪk pɑːt/',
    assessment:{status:'natural', explanation:'表达自然。', correction:null}};
  for (const first of ['invalid JSON', JSON.stringify({...core, usage:null})]) {
    for (const recovered of [true, false]) {
      const requests: {system:string; user:string}[] = [];
      const result = digest(selection, 'explain', credential, async ({body}) => {
        const [system,user] = JSON.parse(body as string).messages;
        requests.push({system:system.content,user:user.content});
        const content = requests.length === 1 || !recovered ? first : JSON.stringify(core);
        return {status:200, json:{choices:[{finish_reason:'stop',message:{content}}]}};
      });
      if (recovered) assert.deepEqual(await result,core);
      else await assert.rejects(result,/AI 返回格式异常/);
      assert.equal(requests.length,2);
      assert.equal(requests[1].user,requests[0].user);
      assert.match(requests[1].system,/Required keys/);
      assert.doesNotMatch(requests[1].system,/Return wordFamily|Return dictionarySenses/);
    }
  }
});

const stripSelection = snapshot('list.md', 'A narrow strip of land emerged as the tide went out.', 'strip');
const stripExplanation = {headword:'strip', translation:'狭长的一片', meaning:'这里作名词，指狭长的一片陆地。',
  usage:'a strip of land', example:'A strip of forest runs along the river. 一带狭长的树林沿河延伸。', pronunciation:'/strɪp/',
  assessment:{status:'natural', explanation:'用法自然。', correction:null}};
const stripVocabulary = {
  commonUsages:[{partOfSpeech:'动词', meaning:'去掉表层', example:'strip the paint off the door（去掉门上的漆）'}],
  wordFamily:[{word:'stripper', pronunciation:'/ˈstrɪpər/', partOfSpeech:'名词', meaning:'去除剂（如脱漆剂）'}],
};
const jsonResponse = (value: unknown) => ({status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify(value)}}]}});

test('the first strip lookup checks empty or invalid vocabulary and reuses the supplemented result', async () => {
  const storage = new Map<string, unknown>();
  const cache = () => new ResultCache({load:key=>storage.get(key), save:(key,value)=>{storage.set(key,value);}});
  const requests: {prompt:string; input:Record<string, unknown>}[] = [];
  const transport: Transport = async ({body}) => {
    const [system, user] = JSON.parse(body as string).messages;
    requests.push({prompt:system.content, input:JSON.parse(user.content)});
    return requests.length === 1
      ? jsonResponse({...stripExplanation, commonUsages:[], wordFamily:[{...stripVocabulary.wordFamily[0], pronunciation:'stripper'}]})
      : jsonResponse(stripVocabulary);
  };
  const expected = {...stripExplanation, ...stripVocabulary};
  assert.deepEqual(await digest(stripSelection, 'explain', credential, transport, {cache:cache()}), expected);
  assert.deepEqual(await digest(stripSelection, 'explain', credential, transport, {cache:cache()}), expected);
  assert.equal(requests.length, 2);
  assert.match(requests[0].prompt, /Always include both vocabulary arrays/);
  assert.match(requests[1].prompt, /Return commonUsages/);
  assert.match(requests[1].prompt, /Return wordFamily/);
  assert.deepEqual(requests[1].input, {headword:'strip', contextualGloss:stripExplanation.translation, contextualMeaning:stripExplanation.meaning});
});

test('a single word recovered by the shorter request checks only the vocabulary it is missing', async () => {
  const prompts: string[] = [];
  const result = await digest(stripSelection, 'explain', credential, async ({body}) => {
    prompts.push(JSON.parse(body as string).messages[0].content);
    if (prompts.length === 1) return jsonResponse({...stripExplanation, usage:null});
    if (prompts.length === 2) return jsonResponse({...stripExplanation, commonUsages:stripVocabulary.commonUsages});
    return jsonResponse({...stripVocabulary, commonUsages:[]});
  });
  assert.deepEqual(result, {...stripExplanation, ...stripVocabulary});
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /Required keys/);
  assert.match(prompts[2], /Return wordFamily/);
  assert.doesNotMatch(prompts[2], /Return commonUsages/);
});

test('supplement failure keeps the core explanation and the next lookup can recover without regenerating it', async () => {
  const cache = new ResultCache({load:()=>null, save:()=>{}});
  let calls = 0;
  const lookup = () => digest(stripSelection, 'explain', credential, async () => {
    calls++;
    if (calls === 1) return jsonResponse(stripExplanation);
    if (calls === 2) return {status:503, json:{}};
    return jsonResponse({commonUsages:stripVocabulary.commonUsages, wordFamily:[]});
  }, {cache});
  assert.deepEqual(await lookup(), stripExplanation);
  const expected = {...stripExplanation, commonUsages:stripVocabulary.commonUsages, wordFamily:[]};
  assert.deepEqual(await lookup(), expected);
  assert.deepEqual(await lookup(), expected);
  assert.equal(calls, 3);
});

const takeVocabulary = {
  commonUsages:[{partOfSpeech:'动词',meaning:'拿走',example:'take the books home（把书拿回家）'}],
  wordFamily:[{word:'taker',pronunciation:'/ˈteɪkə/',partOfSpeech:'名词',meaning:'接受者'}],
};

test('context explanation anchors repeated words to the selected sentence and retries a false missing-sentence claim', async () => {
  const sentence = 'Years of drift took him from one temporary job to the next.';
  const source = '## drift\n\n- **n. 漂泊** · ' + sentence + '\n  多年的漂泊让他辗转于一份又一份临时工作。\n\nThey took part in a study.';
  const selection = snapshot('list.md', source, 'took', source.indexOf('took'));
  const explanation = {
    headword:'take', translation:'使……辗转', meaning:'took 是 take 的过去式，多年的漂泊使他辗转于一份又一份临时工作。',
    usage:'take someone from A to B 表示使某人从 A 到 B。',
    example:'The job took her from city to city. 这份工作让她辗转于不同城市。',
    pronunciation:'/teɪk/', assessment:{status:'natural', explanation:'搭配自然。', correction:null},
    ...takeVocabulary, dictionarySenses:[],
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

test('a reusable pattern is returned only for a verbatim span containing the selected occurrence', async () => {
  const source = 'Years of drift took him from one temporary job to the next. He took a deep breath.';
  const selection = snapshot('list.md', source, 'took', source.indexOf('took'));
  const contextExpression = {
    title:'take someone from A to B', meaning:'使某人从 A 到 B', sourceText:'took him from one temporary job to the next',
  };
  const explanation = {
    headword:'take', translation:'使……辗转', meaning:'使他辗转于不同工作。', usage:'take someone from A to B',
    example:'Work took her from city to city. 她因工作辗转于各个城市。', pronunciation:'/teɪk/',
    assessment:{status:'natural',explanation:'搭配自然。',correction:null}, ...takeVocabulary, dictionarySenses:[],
  };
  for (const suggestion of [contextExpression, null,
    {...contextExpression, sourceText:'took a deep breath'},
    {...contextExpression, sourceText:'take him from one temporary job to the next'},
    {...contextExpression, sourceText:'took him from one temporary jo'},
    {...contextExpression, title:'take'},
  ]) {
    const result = await digest(selection, 'explain', credential, async ({body}) => {
      assert.match(JSON.parse(body as string).messages[0].content, /Return contextExpression/);
      return {status:200, json:{choices:[{finish_reason:'stop',
        message:{content:JSON.stringify({...explanation, contextExpression:suggestion})}}]}};
    });
    assert.deepEqual(result, suggestion === contextExpression ? {...explanation, contextExpression} : explanation);
  }
});

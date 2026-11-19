import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { insertClaudianCallout, readClaudianNote, watchClaudian } from '../src/claudian-callout';
import { claudianTitle } from '../src/claudian-title';
import { snapshot } from '../src/core';

const exchange = {question: 'A 和 B 都对应 consider 吗？', answer: '**是的。**\n\n- A 是名词短语。\n- B 是从句。'};

test('inserts a native collapsed Q&A after the selected occurrence, preserving the source', () => {
  const phrase = 'Researchers should consider A, not just B.';
  const paragraph = `*${phrase}*`;
  const source = ['# Note', '', paragraph, '', 'Translation one', '', paragraph, '', 'Translation two', ''].join('\r\n');
  const selection = snapshot('Article.md', source, phrase, source.lastIndexOf(phrase));
  const changed = insertClaudianCallout(source, selection, exchange);
  const start = changed.indexOf('> [!question]-');
  const block = changed.slice(start, changed.indexOf('\r\n\r\nTranslation two'));
  assert.ok(changed.startsWith(source.slice(0, source.indexOf('Translation two'))));
  assert.ok(block.includes('\r\n> - B 是从句。'));
  assert.equal(changed.replace(block + '\r\n\r\n', ''), source);
  assert.throws(() => insertClaudianCallout(changed, selection, exchange), /原文选区已变化/);
  const fresh = snapshot('Article.md', changed, phrase, source.lastIndexOf(phrase));
  assert.throws(() => insertClaudianCallout(changed, fresh, exchange), /已在原句下方/);
  const previouslySaved = changed.replace(/> \[!question\]- [^\r\n]+/, '> [!question]- Claudian 问答');
  const oldSelection = snapshot('Article.md', previouslySaved, phrase, source.lastIndexOf(phrase));
  assert.throws(() => insertClaudianCallout(previouslySaved, oldSelection, exchange), /已在原句下方/);
});

test('titles use the vocabulary, comparison, or sentence structure in the saved chat', () => {
  const vocab = {question: '英语里面“潜力”这个名词怎么说？', answer: '“潜力”就是 **potential**，它也可以作**不可数名词**。'};
  assert.equal(claudianTitle(vocab, ''), '单词问答：potential');
  assert.equal(claudianTitle({answer: vocab.answer}, ''), '单词笔记：potential');
  assert.equal(claudianTitle({
    question: '“Plausible” 这个词和 “reasonable” 有什么区别？',
    answer: '**核心区别：** plausible 偏“可信”，reasonable 偏“合理”。',
  }, ''), '词义辨析：plausible vs. reasonable');
  assert.equal(claudianTitle({
    question: '这两个是并列关系，对不对？也就是说，这句话的主干是 Researchers should consider A, not just B。',
    answer: '对，你抓住主干了：**Researchers should consider A, not just B.**',
  }, ''), '句子结构：consider A, not just B');
});

test('an unfamiliar topic uses a short one-line title and keeps its full reply', () => {
  const source = 'One paragraph.';
  const selection = snapshot('Article.md', source, source);
  const topic = '先通过一个具体例子了解微型课程的设计要求，再把同一个设计思路用于学生的阅读活动，并比较课堂上的实际效果与预期目标';
  const answer = `${topic}。\n\n下一步是记录反馈。`;
  const result = insertClaudianCallout(source, selection, {answer});
  const header = result.split('\n')[2];
  assert.match(header, /^> \[!note\]- 先通过一个具体例子.*…$/);
  assert.ok(Array.from(header.slice('> [!note]- '.length)).length <= 48);
  assert.ok(result.includes(`> ${topic}。\n>\n> 下一步是记录反馈。`));
});

test('keeps embeds, code queries, and HTML in a reply inert', () => {
  const source = 'One paragraph.';
  const answer = '<img src="remote">\n![[secret]]\n```dataviewjs\n```';
  const changed = insertClaudianCallout(source, snapshot('Article.md', source, source), {...exchange, answer});
  assert.ok(changed.includes('&lt;img'));
  assert.ok(changed.includes('!&#91;&#91;secret&#93;&#93;'));
  assert.ok(changed.includes('&#96;&#96;&#96;dataviewjs'));
});

test('both buttons save content from the clicked historical reply, and only the Q&A button uses the question', async () => {
  const dom = new JSDOM('<div class="claudian-messages"><div class="claudian-message" data-role="assistant" data-message-id="a1"><div class="claudian-message-actions"></div></div></div>');
  const messagesEl = dom.window.document.querySelector<HTMLElement>('.claudian-messages')!;
  const row = messagesEl.querySelector<HTMLElement>('[data-message-id="a1"]')!;
  const messages = [
    {id: 'q1', role: 'user', content: 'Private context', displayContent: exchange.question, turnId: 'first'},
    {id: 'a1', role: 'assistant', content: 'progress text', turnId: 'first', contentBlocks: [
      {type: 'text', content: 'Progress'}, {type: 'tool_use'}, {type: 'text', content: exchange.answer},
    ]},
    {id: 'q2', role: 'user', content: 'Second question', displayContent: 'Second question', turnId: 'second'},
    {id: 'a2', role: 'assistant', content: 'Second answer', turnId: 'second'},
  ];
  const view = {getActiveTab: () => ({dom: {messagesEl}, state: {messages}})};
  const saved: unknown[] = [];
  const cleanup = watchClaudian(messagesEl, (message, mode) => saved.push(readClaudianNote(view, message, mode)));
  const selector = 'button.note-digest-save-claudian';
  assert.equal(readClaudianNote(view, row, 'answer'), undefined);
  assert.equal(row.querySelector(selector), null);
  const copy = dom.window.document.createElement('button');
  copy.className = 'claudian-text-copy-btn';
  row.firstElementChild!.append(copy);
  await new Promise<void>(resolve => queueMicrotask(resolve));
  const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>(selector));
  assert.deepEqual(buttons.map(button => button.textContent), ['将问答存为原句批注', '仅答案存为原句批注']);
  buttons.forEach(button => button.click());
  assert.deepEqual(saved, [exchange, {answer: exchange.answer}]);
  assert.equal(readClaudianNote({getActiveTab: () => ({dom: {messagesEl: messagesEl.cloneNode()}})}, row, 'answer'), undefined);

  messages[0].displayContent = '很长的提问'.repeat(10_000);
  const source = 'One paragraph.\n\nTranslation.';
  const selection = snapshot('Article.md', source, 'One paragraph.');
  const contents = readClaudianNote(view, row, 'answer')!;
  assert.deepEqual(contents, {answer: exchange.answer});
  const result = insertClaudianCallout(source, selection, contents);
  assert.match(result, /^One paragraph\.\n\n> \[!note\]- A 是名词短语\n> \*\*是的。\*\*/);
  assert.doesNotMatch(result, /很长的提问|我的提问/);
  assert.ok(result.endsWith('\n\nTranslation.'));

  messages.shift();
  assert.deepEqual(readClaudianNote(view, row, 'answer'), contents);
  assert.equal(readClaudianNote(view, row, 'exchange'), undefined);
  cleanup();
  assert.equal(row.querySelector(selector), null);
});

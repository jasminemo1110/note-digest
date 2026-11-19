import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { insertExchange, readExchange, watchClaudian } from '../src/claudian-callout';
import { snapshot } from '../src/core';

const exchange = {question: 'A 和 B 都对应 consider 吗？', answer: '**是的。**\n\n- A 是名词短语。\n- B 是从句。'};

test('inserts a native collapsed Q&A after the selected occurrence, preserving the source', () => {
  const phrase = 'Researchers should consider A, not just B.';
  const paragraph = `*${phrase}*`;
  const source = ['# Note', '', paragraph, '', 'Translation one', '', paragraph, '', 'Translation two', ''].join('\r\n');
  const selection = snapshot('Article.md', source, phrase, source.lastIndexOf(phrase));
  const changed = insertExchange(source, selection, exchange);
  const start = changed.indexOf('> [!question]-');
  const block = changed.slice(start, changed.indexOf('\r\n\r\nTranslation two'));
  assert.ok(changed.startsWith(source.slice(0, source.indexOf('Translation two'))));
  assert.ok(block.includes('\r\n> - B 是从句。'));
  assert.equal(changed.replace(block + '\r\n\r\n', ''), source);
  assert.throws(() => insertExchange(changed, selection, exchange), /原文选区已变化/);
  const fresh = snapshot('Article.md', changed, phrase, source.lastIndexOf(phrase));
  assert.throws(() => insertExchange(changed, fresh, exchange), /已在原句下方/);
});

test('keeps embeds, code queries, and HTML in a reply inert', () => {
  const source = 'One paragraph.';
  const answer = '<img src="remote">\n![[secret]]\n```dataviewjs\n```';
  const changed = insertExchange(source, snapshot('Article.md', source, source), {...exchange, answer});
  assert.ok(changed.includes('&lt;img'));
  assert.ok(changed.includes('!&#91;&#91;secret&#93;&#93;'));
  assert.ok(changed.includes('&#96;&#96;&#96;dataviewjs'));
});

test('the clicked historical reply saves its own question and final text', async () => {
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
  const cleanup = watchClaudian(messagesEl, message => saved.push(readExchange(view, message)));
  const selector = 'button.note-digest-save-claudian';
  assert.equal(readExchange(view, row), undefined);
  assert.equal(row.querySelector(selector), null);
  const copy = dom.window.document.createElement('button');
  copy.className = 'claudian-text-copy-btn';
  row.firstElementChild!.append(copy);
  await new Promise<void>(resolve => queueMicrotask(resolve));
  row.querySelector<HTMLButtonElement>(selector)!.click();
  assert.deepEqual(saved, [exchange]);
  assert.equal(readExchange({getActiveTab: () => ({dom: {messagesEl: messagesEl.cloneNode()}})}, row), undefined);
  cleanup();
  assert.equal(row.querySelector(selector), null);
});

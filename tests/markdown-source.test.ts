import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCollectSelection, readingSnapshot, insertTranslation, translationInsertion, rebaseSelectionAfterInsertion } from '../src/core';

function select(source: string, paragraph: string, text: string, lineStart = 0, lineEnd = 0, offset = paragraph.indexOf(text)) {
  return readingSnapshot('a.md', source, text, {section: {lineStart, lineEnd, text: source}, paragraph, offset});
}

test('a visible occurrence never falls back to a different source occurrence', () => {
  const source = '[ex&#97;mple](https://site.org) from the article.\n\nAn ordinary example.';
  const selection = select(source, 'example from the article.', 'example');
  assert.equal(selection.start, 1);
  assert.equal(selection.end, 12);
  assert.equal(canCollectSelection(selection), false);
  assert.equal(insertTranslation(source, selection, '例子', 'inline'),
    '[ex&#97;mple](https://site.org)（例子） from the article.\n\nAn ordinary example.');

  const uncertain = select(source, 'example elsewhere.', 'example');
  assert.equal(uncertain.readOnly, true);
  assert.equal(uncertain.start, -1);
  assert.equal(canCollectSelection(uncertain), false);
  assert.throws(() => insertTranslation(source, uncertain, '例子', 'inline'), /无法确认/);
  const stale = readingSnapshot('a.md', source, 'example', {
    section:{lineStart:0, lineEnd:0, text:'Outdated source'}, paragraph:'example from the article.', offset:0,
  });
  assert.equal(stale.readOnly, true);
});

test('the clicked occurrence of repeated text is mapped using the rendered offset', () => {
  const source = '**word** next to word.';
  const selection = select(source, 'word next to word.', 'word', 0, 0, 13);
  assert.equal(selection.start, source.lastIndexOf('word'));
  assert.equal(insertTranslation(source, selection, '词', 'inline'), '**word** next to word（词）.');
  const bold = select(source, 'word next to word.', 'word');
  assert.equal(insertTranslation(source, bold, '词', 'inline'), '**word（词）** next to word.');
  assert.equal(insertTranslation(source, bold, '词', 'below'), source + '\n\n词');
  assert.equal(select('Same.\n\nSame.', 'Same.', 'Same', 0, 2).readOnly, true);
});

test('standard links keep the complete label and URL unchanged', () => {
  const source = 'See [the example](<https://site.org/a_(b)> "Title") today.';
  const paragraph = 'See the example today.';
  const whole = select(source, paragraph, 'the example');
  const partial = select(source, paragraph, 'example');
  const outside = select(source, paragraph, 'today');
  assert.equal(insertTranslation(source, whole, '示例', 'inline'), source.replace(' today', '（示例） today'));
  assert.throws(() => insertTranslation(source, partial, '示例', 'inline'), /复杂/);
  assert.equal(insertTranslation(source, partial, '示例', 'below'), source + '\n\n示例');
  assert.equal(insertTranslation(source, outside, '今天', 'inline'), source.replace('today', 'today（今天）'));
  const target = source.indexOf('site.org');
  for (const mode of ['inline', 'below'] as const) {
    assert.throws(() => insertTranslation(source, {...whole, start:target, end:target+8}, '词', mode), /复杂/);
  }
});

test('both insertion points handle a wrapped paragraph with LF and CRLF and a following heading', () => {
  for (const newline of ['\n', '\r\n']) {
    const body = 'The first line' + newline + '  continues here.  ';
    const source = body + newline + '# Next';
    const selected = select(source, 'The first line continues here.', 'line continues', 0, 1);
    const inline = translationInsertion(source, selected, '跨行文字', 'inline');
    assert.equal(inline.after, source.replace('continues', 'continues（跨行文字）'));
    assert.equal(rebaseSelectionAfterInsertion(selected, inline)?.text, 'line continues');
    assert.equal(insertTranslation(source, selected, '跨行文字', 'below'), body + newline.repeat(2) + '跨行文字' + newline.repeat(2) + '# Next');
    assert.throws(() => insertTranslation(source + ' Changed', selected, '译文', 'inline'), /原文已修改/);
  }
});

test('inserting adjacent to a Markdown delimiter is refused if it would change the parse', () => {
  const source = '**word**suffix';
  const selection = select(source, 'wordsuffix', 'word');
  assert.equal(selection.readOnly, undefined);
  assert.throws(() => insertTranslation(source, selection, '译文', 'inline'), /改变原文/);
});

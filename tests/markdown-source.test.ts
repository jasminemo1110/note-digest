import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCollectSelection, readingSnapshot, insertTranslation, snapshot, translationInsertion, rebaseSelectionAfterInsertion } from '../src/core';
import { articleBody, LEARNING_BOUNDARY, LEARNING_HEADING } from '../src/anchors';

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

test('table coordinates disambiguate repeated words and keep context inside the selected cell', () => {
  const source = '# Article\n\n| Original | Revised |\n| --- | --- |\n| First confirmation | Other confirmation |\n| **Hotel:** Received the confirmation email. | Other confirmation |';
  const paragraph = 'Hotel: Received the confirmation email.';
  const text = 'confirmation';
  const offset = paragraph.indexOf(text);
  const cell = {row:2, column:0, rows:3, columns:2};
  const section = {lineStart:2, lineEnd:5, text:source};
  const selected = readingSnapshot('a.md', source, text, {section,paragraph,offset,cell}, {text:paragraph,offset});
  assert.ok(canCollectSelection(selected));
  assert.equal(selected.start, source.indexOf('confirmation email'));
  assert.equal(selected.context, paragraph);
  assert.throws(() => insertTranslation(source, selected, '确认', 'inline'), /复杂/);
  const livePreview = readingSnapshot('a.md', source, text, {
    paragraph,offset,cell:{...cell,widgetStart:source.indexOf('| Original')},
  }, {text:paragraph,offset});
  assert.equal(livePreview.start, selected.start);
  const wrongCell = readingSnapshot('a.md', source, text, {section,paragraph,offset,cell:{...cell,column:1}});
  assert.equal(wrongCell.readOnly, true);
  const stale = readingSnapshot('a.md', source, text, {section:{...section,text:'stale'},paragraph,offset,cell});
  assert.equal(stale.readOnly, true);
});

test('headings, list items and quotes can save when their rendered positions match', () => {
  for (const [source, paragraph, tag] of [
    ['## An example heading', 'An example heading', 'h2'],
    ['- First item\n- An example item', 'An example item', 'li'],
    ['> An example quote', 'An example quote', 'p'],
  ]) {
    const selection = readingSnapshot('a.md', source, 'example', {
      section:{lineStart:0,lineEnd:source.split('\n').length-1,text:source},
      paragraph,offset:paragraph.indexOf('example'),tag,
    });
    assert.equal(selection.start, source.indexOf('example'));
    assert.ok(canCollectSelection(selection));
  }
});

test('content between a hidden learning marker and its verified heading is still original text', () => {
  const opening = 'A previous confirmation.' + LEARNING_BOUNDARY + '\n## Evening review\n\n';
  const table = '| Original | Revised |\n| --- | --- |\n| Hotel confirmation email. | Other example. |';
  const source = opening + table + '\n\n' + LEARNING_HEADING + '\n\n<!-- note-digest:group:word -->\n### 单词\n\nGenerated card.\n';
  const start = source.indexOf('confirmation email');
  const lineStart = opening.split('\n').length - 1;
  const paragraph = 'Hotel confirmation email.';
  const offset = paragraph.indexOf('confirmation');
  const rendered = readingSnapshot('a.md', source, 'confirmation', {
    section:{lineStart,lineEnd:lineStart+2,text:source},paragraph,offset,cell:{row:1,column:0,rows:2,columns:2},
  });
  assert.equal(rendered.start, start);
  assert.ok(canCollectSelection(rendered));
  const raw = snapshot('a.md', source, 'confirmation', start);
  assert.equal(raw.start, start);
  assert.match(raw.context, /Hotel confirmation email/);
  assert.doesNotMatch(raw.context, /Other example/);
  assert.doesNotMatch(articleBody(source), /note-digest:learning|Generated card/);
  assert.throws(() => snapshot('a.md',source,'Generated card.',source.indexOf('Generated card.')), /对应原文/);
});

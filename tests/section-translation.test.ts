import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleBody, digestText, LEARNING_BOUNDARY, sectionTranslationRanges } from '../src/anchors';
import { articleTranslationParagraphs, planArticleSummary, planSelectedSummary, sectionAt, sectionSource } from '../src/article-summary';
import { snapshot } from '../src/core';
import { changeSectionTranslation, savedSectionTranslation } from '../src/section-translation';

const note = '# First\n\nFirst paragraph.\n\nSecond paragraph.\n\n# Another\n\nAnother paragraph.\n\n**Notes**\n\nAn endnote.';
const path = 'example.md';

function rows(article: ReturnType<typeof planArticleSummary>, index: number, translations: string[]) {
  return articleTranslationParagraphs(article, sectionAt(article, index))
    .map((row, i) => ({...row, translation: translations[i]}));
}

test('each translation follows its own English paragraph and one undo keeps changes in other sections', async () => {
  for (const newline of ['\n', '\r\n']) {
    const source = ('---\ntitle: Example\n---\n\n' + note).replaceAll('\n', newline) + LEARNING_BOUNDARY + 'Learning card.';
    const original = planArticleSummary(path, source);
    const translated = rows(original, 0, ['标题', '第一段 <tag>。', '第二段。']);
    const first = await changeSectionTranslation(original, sectionAt(original, 0), translated, false);
    assert.ok(savedSectionTranslation(first, sectionAt(first, 0)));
    const blocks = sectionTranslationRanges(first.source);
    assert.equal(blocks.length, 3);
    assert.match(blocks[1].content, /第一段 &lt;tag&gt;。/);
    assert.match(blocks[2].content, /第二段。/);
    assert.ok(first.source.indexOf('First paragraph.') < blocks[1].start);
    assert.ok(blocks[1].end < first.source.indexOf('Second paragraph.'));
    assert.ok(first.source.indexOf('Second paragraph.') < blocks[2].start);
    const second = await changeSectionTranslation(first, sectionAt(first, 1), rows(first, 1, ['另一节', '另一段。']), false);
    const fresh = planArticleSummary(path, second.source);
    assert.equal(fresh.parts.length, 2);
    assert.doesNotMatch(articleBody(fresh.source), /第一段|第二段|Learning card/);
    for (const i of [0, 1, 2]) {
      assert.equal(sectionSource(fresh, sectionAt(fresh, i)).text, sectionSource(original, sectionAt(original, i)).text);
    }
    await assert.rejects(changeSectionTranslation(fresh, sectionAt(fresh, 0), translated, false), /原文已有/);
    const undone = await changeSectionTranslation(fresh, sectionAt(fresh, 0), [], true);
    let expected = second.source;
    for (const {start, end} of [...blocks].reverse()) expected = expected.slice(0, start) + expected.slice(end);
    assert.equal(undone.source, expected);
    const reverted = await changeSectionTranslation(undone, sectionAt(undone, 1), [], true);
    assert.equal(reverted.source, source);
  }
});

test('edited or incomplete translation groups stay in the note and unsafe placements fail atomically', async () => {
  const original = planArticleSummary(path, note);
  const saved = await changeSectionTranslation(original, original.parts[0], rows(original, 0, ['标题', '第一段', '第二段']), false);
  const changed = planArticleSummary(path, saved.source.replace('第一段', '手改的第一段'));
  await assert.rejects(changeSectionTranslation(changed, changed.parts[0], [], true), /已手动修改/);
  const [removed] = sectionTranslationRanges(saved.source);
  const incomplete = planArticleSummary(path, saved.source.slice(0, removed.start) + saved.source.slice(removed.end));
  await assert.rejects(changeSectionTranslation(incomplete, incomplete.parts[0], [], true), /已手动修改/);

  const selected = planSelectedSummary(snapshot(path, note, 'First para'));
  await assert.rejects(changeSectionTranslation(selected, selected.parts[0], rows(selected, 0, ['这部分']), false), /没有可安全写入/);
  const mismatched = rows(original, 0, ['标题', '第一段', '第二段']).reverse();
  await assert.rejects(changeSectionTranslation(original, original.parts[0], mismatched, false), /无法与目前的英文段落逐一对应/);
});

test('0.3.22 saved section blocks still support one-click undo', async () => {
  const source = 'First paragraph.\n\nSecond paragraph.';
  const content = '> [!note-digest-translation] 本节译文\n> 第一段。\n>\n> 第二段。';
  const digest = await digestText(JSON.stringify([source, content]));
  const marked = source + `\n\n<!-- note-digest:section-translation:${source.length}:${digest} -->\n\n${content}\n\n<!-- note-digest:section-translation-end -->\n\n`;
  const original = planArticleSummary(path, marked);
  assert.ok(savedSectionTranslation(original, original.parts[0]));
  assert.equal((await changeSectionTranslation(original, original.parts[0], [], true)).source, source);
});

test('blank lines inside fenced code and loose lists do not become insertion points', async () => {
  const source = 'First paragraph.\n\n```txt\ncode first\n\ncode last\n```\n\n- Item one\n\n- Item two\n\nLast paragraph.';
  const original = planArticleSummary(path, source);
  const translated = rows(original, 0, ['第一段', '代码', '列表', '末段']);
  assert.equal(translated.length, 4);
  const result = await changeSectionTranslation(original, original.parts[0], translated, false);
  assert.equal(sectionTranslationRanges(result.source).length, 4);
  assert.ok(result.source.includes('```txt\ncode first\n\ncode last\n```'));
  assert.ok(result.source.includes('- Item one\n\n- Item two'));
});

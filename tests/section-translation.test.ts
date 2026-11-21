import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleBody, LEARNING_BOUNDARY } from '../src/anchors';
import { planArticleSummary, planSelectedSummary, sectionAt, sectionSource } from '../src/article-summary';
import { snapshot } from '../src/core';
import { changeSectionTranslation, savedSectionTranslation } from '../src/section-translation';

const note = '# First\n\nFirst paragraph.\n\nSecond paragraph.\n\n# Another\n\nAnother paragraph.\n\n**Notes**\n\nAn endnote.';
const translated = [{source:'First paragraph.',start:0,end:0,translation:'第一段 <tag>。'},
  {source:'Second paragraph.',start:0,end:0,translation:'第二段。'}];

test('saved section translation is skipped by the planner and only its own bytes are undone', async () => {
  for (const newline of ['\n', '\r\n']) {
    const source = ('---\ntitle: Example\n---\n\n' + note).replaceAll('\n', newline) + LEARNING_BOUNDARY + 'Learning card.';
    const path = 'example.md';
    const original = planArticleSummary(path, source);
    const first = await changeSectionTranslation(original, sectionAt(original, 0), translated, false);
    const block = savedSectionTranslation(first, sectionAt(first, 0))!;
    assert.match(block.content, /第一段 &lt;tag&gt;。/);
    assert.match(block.content, /第二段。/);
    const second = await changeSectionTranslation(first, sectionAt(first, 1), translated, false);
    const fresh = planArticleSummary(path, second.source);
    assert.equal(fresh.parts.length, 2);
    assert.doesNotMatch(articleBody(fresh.source), /第一段|第二段|Learning card/);
    for (const i of [0, 1, 2]) {
      assert.equal(sectionSource(fresh, sectionAt(fresh, i)).text, sectionSource(original, sectionAt(original, i)).text);
    }
    await assert.rejects(changeSectionTranslation(fresh, sectionAt(fresh, 0), translated, false), /原文已有/);
    const undone = await changeSectionTranslation(fresh, sectionAt(fresh, 0), [], true);
    assert.equal(undone.source, second.source.slice(0, block.start) + second.source.slice(block.end));
    const reverted = await changeSectionTranslation(undone, sectionAt(undone, 1), [], true);
    assert.equal(reverted.source, source);
  }
});

test('edited translation stays in the note and selected fragments cannot split an original paragraph', async () => {
  const path = 'example.md';
  const original = planArticleSummary(path, note);
  const saved = await changeSectionTranslation(original, original.parts[0], translated, false);
  const changed = planArticleSummary(path, saved.source.replace('第一段', '手改的第一段'));
  await assert.rejects(changeSectionTranslation(changed, changed.parts[0], [], true), /已手动修改/);
  const selected = planSelectedSummary(snapshot(path, note, 'First para'));
  await assert.rejects(changeSectionTranslation(selected, selected.parts[0], translated, false), /没有可安全写入/);
});

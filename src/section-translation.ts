import { digestText, sectionTranslationRanges, SECTION_TRANSLATION_CALLOUT } from './anchors';
import { articlePartIsLocated, articleTranslationParagraphs, sectionSource, translationChunks, type ArticlePart, type ArticleSummary } from './article-summary';
import { escapeMarkdown } from './core';
import { markdownBody, markdownStructure } from './markdown-source';
import type { ParagraphTranslation } from './reading-layout';

interface TranslationEdit { start: number; end: number; text: string }

function sectionLayout(article: ArticleSummary, part: ArticlePart) {
  const section = sectionSource(article, part);
  const lastTextOffset = section.sourceOffset(section.text.trimEnd().length, 'end');
  const paragraphs = translationChunks(article, part).flatMap(chunk => articleTranslationParagraphs(article, chunk));
  const boundary = Math.max(lastTextOffset, paragraphs.at(-1)?.insertionOffset ?? 0);
  const blocks = sectionTranslationRanges(article.source).filter(range => range.start >= part.start && range.start <= boundary);
  const text = section.text.trim();
  const legacy = blocks.find(block => block.start === lastTextOffset && block.paragraph === undefined && block.length === text.length);
  const interleaved = blocks.filter(block => block.paragraph !== undefined && block.length === text.length);
  return {text, paragraphs, blocks, legacy, interleaved};
}

export function savedSectionTranslation(article: ArticleSummary, part: ArticlePart): boolean {
  if (!articlePartIsLocated(article)) return false;
  const {legacy, interleaved} = sectionLayout(article, part);
  return !!legacy || interleaved.length > 0;
}

function paragraphCallout(translation: string, newline: string): string {
  const lines = escapeMarkdown(translation.trim()).replace(/[%$^:]/g, char => `&#${char.charCodeAt(0)};`)
    .split(/\r\n|\r|\n/).map(line => '> ' + line);
  return [`> [!${SECTION_TRANSLATION_CALLOUT}|paragraph] 译文`, ...lines].join(newline);
}

/** Builds one edit against a known snapshot. The caller verifies that snapshot atomically before writing. */
export async function changeSectionTranslation(article: ArticleSummary, part: ArticlePart,
  translations: ParagraphTranslation[], undo: boolean): Promise<ArticleSummary> {
  if (!articlePartIsLocated(article)) throw new Error('无法确认本节在原文中的位置。');
  const {source} = article;
  const {text, paragraphs, blocks, legacy, interleaved} = sectionLayout(article, part);
  let edits: TranslationEdit[];
  if (undo) {
    if (legacy) {
      if (await digestText(JSON.stringify([text, legacy.content])) !== legacy.digest) {
        throw new Error('本节原文或译文已手动修改，请在原文中编辑。');
      }
      edits = [{start: legacy.start, end: legacy.end, text: ''}];
    } else {
      if (!interleaved.length) throw new Error('原文中没有可撤销的本节译文。');
      const complete = interleaved.length === paragraphs.length && interleaved.every((block, index) =>
        block.start === paragraphs[index].insertionOffset && block.paragraph === index + 1 && block.total === paragraphs.length &&
        block.digest === interleaved[0].digest);
      if (!complete || await digestText(JSON.stringify([text, interleaved.map(block => block.content)])) !== interleaved[0].digest) {
        throw new Error('本节原文或译文已手动修改，请在原文中编辑。');
      }
      edits = interleaved.map(({start, end}) => ({start, end, text: ''}));
    }
  } else {
    if (blocks.length) throw new Error('原文已有译文，请从原来的小节撤销后再加入。');
    if (!translations.length || translations.length !== paragraphs.length ||
        !translations.every((row, index) => row.source === paragraphs[index].source && row.translation.trim())) {
      throw new Error('译文无法与目前的英文段落逐一对应，请重新打开本节。');
    }
    const newline = source.match(/\r?\n/)?.[0] ?? '\n';
    const callouts = translations.map(({translation}) => paragraphCallout(translation, newline));
    const digest = await digestText(JSON.stringify([text, callouts]));
    edits = paragraphs.map(({insertionOffset: offset}, index) => ({
      start: offset,
      end: offset,
      text: ['', '', `<!-- note-digest:section-translation:${text.length}:${index + 1}/${paragraphs.length}:${digest} -->`,
        '', callouts[index], '', '<!-- note-digest:section-translation-end -->', '', ''].join(newline),
    }));
  }
  let after = '';
  let cursor = 0;
  for (const edit of edits) {
    after += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  after += source.slice(cursor);
  if (markdownStructure(markdownBody(source)) !== markdownStructure(markdownBody(after))) {
    throw new Error('本节没有可安全写入的完整 Markdown 段落边界，译文仍可在侧栏阅读。');
  }

  const shift = (position: number, end = false) => {
    let delta = 0;
    for (const edit of edits) {
      if (position < edit.start || (end && position === edit.start)) break;
      if (position < edit.end) return edit.start + delta + edit.text.length;
      delta += edit.text.length - (edit.end - edit.start);
    }
    return position + delta;
  };
  const rebase = <T extends ArticlePart>(range: T): T =>
    ({...range, start: shift(range.start), end: shift(range.end, true)});
  const previous = article.selection;
  let selection = previous;
  if (previous && 'path' in previous) {
    const range = rebase(previous);
    selection = {...range, source: after, text: after.slice(range.start, range.end)};
  }
  return {...article, source: after, selection, parts: article.parts.map(rebase),
    ...(article.supplements && {supplements: article.supplements.map(rebase)})};
}

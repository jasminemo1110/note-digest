import { digestText, sectionTranslationRanges, SECTION_TRANSLATION_CALLOUT } from './anchors';
import { articlePartIsLocated, sectionSource, type ArticlePart, type ArticleSummary } from './article-summary';
import { escapeMarkdown } from './core';
import { markdownBody, markdownStructure } from './markdown-source';
import type { ParagraphTranslation } from './reading-layout';

function sectionBoundary(article: ArticleSummary, part: ArticlePart) {
  const section = sectionSource(article, part);
  const offset = section.sourceOffset(section.text.trimEnd().length, 'end');
  return {offset, text: section.text.trim(), existing: sectionTranslationRanges(article.source).find(range => range.start === offset)};
}

export function savedSectionTranslation(article: ArticleSummary, part: ArticlePart) {
  if (!articlePartIsLocated(article)) return;
  const {text, existing} = sectionBoundary(article, part);
  return existing?.length === text.length ? existing : undefined;
}

/** Builds an edit against a known snapshot. The caller must verify that snapshot atomically before writing. */
export async function changeSectionTranslation(article: ArticleSummary, part: ArticlePart,
  paragraphs: ParagraphTranslation[], undo: boolean): Promise<ArticleSummary> {
  if (!articlePartIsLocated(article)) throw new Error('无法确认本节在原文中的位置。');
  const {source} = article;
  const {offset, text, existing} = sectionBoundary(article, part);
  let removed = 0;
  let insertion = '';
  if (undo) {
    if (!existing || existing.length !== text.length) throw new Error('原文中没有可撤销的本节译文。');
    if (await digestText(JSON.stringify([text, existing.content])) !== existing.digest) {
      throw new Error('本节原文或译文已手动修改，请在原文中编辑。');
    }
    removed = existing.end - existing.start;
  } else {
    if (existing) throw new Error('原文已有译文，请从原来的小节撤销后再加入。');
    if (!paragraphs.length) throw new Error('本节尚无可加入原文的译文。');
    const newline = source.match(/\r?\n/)?.[0] ?? '\n';
    const quoted = paragraphs.map(({translation}) => escapeMarkdown(translation.trim())
      .replace(/[%$^:]/g, char => `&#${char.charCodeAt(0)};`)
      .split(/\r\n|\r|\n/).map(line => '> ' + line).join(newline));
    const content = [`> [!${SECTION_TRANSLATION_CALLOUT}] 本节译文`, quoted.join(newline + '>' + newline)].join(newline);
    const digest = await digestText(JSON.stringify([text, content]));
    insertion = ['', '', `<!-- note-digest:section-translation:${text.length}:${digest} -->`, '', content, '',
      '<!-- note-digest:section-translation-end -->', '', ''].join(newline);
  }
  const after = source.slice(0, offset) + insertion + source.slice(offset + removed);
  if (markdownStructure(markdownBody(source)) !== markdownStructure(markdownBody(after))) {
    throw new Error('本节没有可安全写入的完整 Markdown 段落边界，译文仍可在侧栏阅读。');
  }

  const shift = (position: number, end = false) => {
    if (position < offset || (end && position === offset)) return position;
    return Math.max(position - removed, offset) + insertion.length;
  };
  const rebase = <T extends ArticlePart>(range: T): T =>
    ({...range, start: shift(range.start), end: shift(range.end, true)});
  const previous = article.selection;
  const selection = previous && 'path' in previous ? {
    ...rebase(previous), source: after, text: after.slice(shift(previous.start), shift(previous.end, true)),
  } : previous;
  return {...article, source: after, selection, parts: article.parts.map(rebase),
    ...(article.supplements && {supplements: article.supplements.map(rebase)})};
}

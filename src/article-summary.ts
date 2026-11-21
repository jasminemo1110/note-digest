import { articleBody, articleStart, frontmatterEnd, paragraphRanges, savedSummaryRanges, SUMMARY_CALLOUT, SUMMARY_START, SUMMARY_END } from './anchors';
import { canCollectSelection, escapeMarkdown, rebaseSelectionAfterInsertion, type DigestSelection, type InsertionReceipt } from './core';
import { proseText } from './markdown-source';

const SECTION_TARGET = 1800;
const SECTION_LENGTH = 6000;
const MAX_SECTIONS = 40;

export interface ArticlePart { start: number; end: number }
export interface SectionSummary { title: string; summary: string }
export interface ArticleSummary {
  path: string;
  source: string;
  selection?: DigestSelection;
  parts: ArticlePart[];
  sections: SectionSummary[];
  overview?: string;
}

function articleContent(source: string): {start: number; body: string} {
  const start = articleStart(source);
  return {start, body: articleBody(source).slice(start)};
}

export function planArticleSummary(path: string, source: string): ArticleSummary {
  const {start, body} = articleContent(source);
  return {path, source, parts: planParts(body, start), sections: []};
}

export function planSelectedSummary(selection: DigestSelection): ArticleSummary {
  if ('path' in selection) {
    const {start, body} = articleContent(selection.source);
    const end = start + body.length;
    const located = canCollectSelection(selection);
    const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');
    if ((located && selection.start <= start && selection.end >= end) ||
        (!located && (body.trim() === selection.text.trim() || normalize(proseText(body)) === normalize(selection.text)))) {
      return planArticleSummary(selection.path, selection.source);
    }
    if (located) {
      if (selection.start < start || selection.end > end) throw new Error('请在英文正文中划选要摘要的文字。');
      return {path: selection.path, source: selection.source, selection,
        parts: planParts(selection.text, selection.start), sections: []};
    }
    return {path: selection.path, source: selection.text, selection, parts: planParts(selection.text, 0), sections: []};
  }
  return {path: '', source: selection.text, selection, parts: planParts(selection.text, 0), sections: []};
}

function planParts(text: string, offset: number): ArticlePart[] {
  if (!text.trim()) throw new Error('没有可总结的正文。');
  const boundaries = new Map<number, 'section' | 'question'>([[0, 'section']]);
  let fence: string | undefined;
  let blank = true;
  for (const line of text.matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
    const value = line[0].trimEnd();
    const marker = value.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
    } else if (marker) {
      fence = marker[1];
    } else if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(value)) {
      boundaries.set(line.index, 'section');
    } else if (blank && /^(?:\*\*|__)?[\p{L}][\p{L}\p{N} .&’'-]{0,30}: .+\?(?:\*\*|__)?$/u.test(value.trim())) {
      boundaries.set(line.index, 'question');
    }
    blank = !value.trim();
  }
  const starts = [...boundaries.keys(), text.length];
  const parts: ArticlePart[] = [];
  for (let i = 1; i < starts.length; i++) {
    const start = starts[i - 1];
    const sectionEnd = starts[i];
    const target = boundaries.get(start) === 'question' ? SECTION_LENGTH : SECTION_TARGET;
    const breaks = paragraphRanges(text.slice(start, sectionEnd)).slice(1).map(range => start + range.start);
    let nextBreak = 0;
    let cursor = start;
    while (cursor < sectionEnd) {
      const limit = Math.min(cursor + SECTION_LENGTH, sectionEnd);
      const desired = Math.min(cursor + target, limit);
      let end = cursor;
      while (nextBreak < breaks.length && breaks[nextBreak] <= desired) end = breaks[nextBreak++];
      if (limit === sectionEnd && sectionEnd - desired < Math.min(440, target / 4)) end = limit;
      if (end === cursor) {
        end = breaks[nextBreak] !== undefined && breaks[nextBreak] <= limit ? breaks[nextBreak] : limit;
        if (end === breaks[nextBreak]) nextBreak++;
        if (end < sectionEnd && end === limit) {
          const hardEnd = end;
          while (end > cursor + SECTION_LENGTH / 2 && !/\s/.test(text[end - 1])) end--;
          if (end <= cursor + SECTION_LENGTH / 2) end = hardEnd;
          if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
        }
      }
      if (text.slice(cursor, end).trim()) {
        if (parts.length === MAX_SECTIONS) throw new Error(`正文超过目前的 ${MAX_SECTIONS} 节摘要上限，请分篇后再试。`);
        parts.push({start: offset + cursor, end: offset + end});
      }
      cursor = end;
    }
  }
  return parts;
}

export function articleFinished(article: ArticleSummary): boolean {
  return !!article.overview || (!!article.selection && article.parts.length > 1 && article.sections.length === article.parts.length);
}

export function articleFileSource(article: ArticleSummary): string | undefined {
  if (!article.selection) return article.source;
  if ('path' in article.selection) return article.selection.source;
}

export function articlePartIsLocated(article: ArticleSummary): boolean {
  return !article.selection || ('path' in article.selection && canCollectSelection(article.selection));
}

export function overviewInsertion(current: string, article: ArticleSummary): InsertionReceipt | undefined {
  if (!article.path || current !== articleFileSource(article)) throw new Error('原文已修改，请重新打开 Digest。');
  if (!article.overview) throw new Error('没有可以添加到文首的概览。');
  const newline = current.match(/\r?\n/)?.[0] ?? '\n';
  const title = article.selection ? '选段摘要' : '中文摘要';
  const content = escapeMarkdown(article.overview).replace(/[%$^:]/g, char => `&#${char.charCodeAt(0)};`);
  const block = [SUMMARY_START, '', `> [!${SUMMARY_CALLOUT}]+ ${title}`,
    ...content.split(/\r\n|\r|\n/).map(line => '> ' + line), '', SUMMARY_END].join(newline);
  if (savedSummaryRanges(current).some(range => current.slice(range.start, range.end).trimEnd() === block)) return;
  const offset = frontmatterEnd(current);
  const leading = offset > Number(current.startsWith('\uFEFF')) ? (current[offset - 1] === '\n' ? newline : newline.repeat(2)) : '';
  const insertion = leading + block + newline.repeat(2);
  return {path: article.path, before: current, offset, length: insertion.length,
    after: current.slice(0, offset) + insertion + current.slice(offset)};
}

export function rebaseAfterOverview(article: ArticleSummary, receipt: InsertionReceipt): ArticleSummary {
  const {selection} = article;
  if (!selection || articlePartIsLocated(article)) {
    return {...article, source: receipt.after, parts: article.parts.map(({start, end}) => ({
      start: start + receipt.length, end: end + receipt.length,
    })), selection: selection && 'path' in selection ? rebaseSelectionAfterInsertion(selection, receipt) ?? selection : selection};
  }
  return 'path' in selection ? {...article, selection: {...selection, source: receipt.after}} : article;
}

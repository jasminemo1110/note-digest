import { articleBody, articleStart, frontmatterEnd, readingProjection, savedSummaryRanges, SUMMARY_CALLOUT, SUMMARY_START, SUMMARY_END } from './anchors';
import { escapeMarkdown, rebaseSelectionAfterInsertion, type DigestSelection, type InsertionReceipt } from './core';
import { parseMarkdown, proseText } from './markdown-source';

const SECTION_TARGET = 1800;
const SECTION_LENGTH = 6000;
const MAX_SECTIONS = 40;

export interface ArticlePart { start: number; end: number }
export interface ArticleSupplement extends ArticlePart { label: string }
export interface SectionSummary { title: string; summary: string }
export interface ArticleSummary {
  path: string;
  source: string;
  selection?: DigestSelection;
  parts: ArticlePart[];
  supplements?: ArticleSupplement[];
  sections: SectionSummary[];
  overview?: string;
}

export function planArticleSummary(path: string, source: string): ArticleSummary {
  const body = articleBody(source);
  const reading = readingProjection(source, articleStart(source), body.length, body);
  const supplements = supplementalParts(reading.text);
  const parts = planParts(reading.text.slice(0, supplements[0]?.start), 0);
  const locate = ({start, end}: ArticlePart) => ({
    start: reading.sourceOffset(start, 'start'), end: reading.sourceOffset(end, 'end'),
  });
  return {path, source, parts: parts.map(locate), sections: [],
    ...(supplements.length && {supplements: supplements.map(part => ({...part, ...locate(part)}))})};
}

export function planSelectedSummary(selection: DigestSelection): ArticleSummary {
  if ('path' in selection) {
    const start = articleStart(selection.source);
    const end = articleBody(selection.source).length;
    const body = readingProjection(selection.source, start, end).text;
    const located = !selection.readOnly && selection.start >= 0 &&
      selection.source.slice(selection.start, selection.end) === selection.text;
    const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');
    if ((located && selection.start <= start && selection.end >= end) ||
        (!located && (body.trim() === selection.text.trim() || normalize(proseText(body)) === normalize(selection.text)))) {
      return planArticleSummary(selection.path, selection.source);
    }
    if (located) {
      if (selection.start < start || selection.end > end) throw new Error('请在英文正文中划选要摘要的文字。');
      const reading = readingProjection(selection.source, selection.start, selection.end);
      return {path: selection.path, source: selection.source, selection,
        parts: planParts(reading.text, 0).map(part => ({
          start: reading.sourceOffset(part.start, 'start'), end: reading.sourceOffset(part.end, 'end'),
        })), sections: []};
    }
    return {path: selection.path, source: selection.text, selection, parts: planParts(selection.text, 0), sections: []};
  }
  return {path: '', source: selection.text, selection, parts: planParts(selection.text, 0), sections: []};
}

const supplementName = /^(?:notes|endnotes|footnotes|references|bibliography|sources|further reading|acknowledg(?:e)?ments|supplementary (?:material|information)|appendix(?: [A-Z0-9]+)?|podcasts?)\s*[:：]?$/i;

function supplementalParts(body: string): ArticleSupplement[] {
  const headings = parseMarkdown(body).children.flatMap(node => {
    if (!node.position || (node.type !== 'heading' && node.type !== 'paragraph')) return [];
    const start = node.position.start.offset!;
    const raw = body.slice(start, node.position.end.offset);
    if (node.type === 'paragraph' && /[\r\n]/.test(raw)) return [];
    const label = proseText(raw).replace(/\s*[:：]$/, '');
    const supplemental = supplementName.test(label);
    if (node.type !== 'heading' && !supplemental) return [];
    return [{start, label, depth: node.type === 'heading' ? node.depth : 6, supplemental}];
  });
  const first = headings.findIndex((heading, index) => heading.supplemental && !!body.slice(0, heading.start).trim() &&
    !headings.slice(index + 1).some(next => !next.supplemental && next.depth <= heading.depth));
  if (first === -1) return [];
  const tail = headings.slice(first).filter(heading => heading.supplemental);
  return tail.map(({start, label}, index) => ({start, label, end: tail[index + 1]?.start ?? body.length}));
}

function planParts(text: string, offset: number): ArticlePart[] {
  if (!text.trim()) throw new Error('没有可总结的正文。');
  const boundaries = new Set([0]);
  const explicit = new Set<number>();
  const blockStarts: number[] = [];
  for (const node of parseMarkdown(text).children) {
    if (!node.position) continue;
    const start = node.position.start.offset!;
    blockStarts.push(start);
    const firstLine = text.slice(start, node.position.end.offset).split(/\r?\n/, 1)[0];
    const question = node.type === 'paragraph' &&
      /^(?:\*\*|__)?[\p{L}][\p{L}\p{N} .&’'-]{0,30}: .+\?(?:\*\*|__)?\s*$/u.test(firstLine);
    if (node.type === 'heading' || question) {
      explicit.add(start);
      boundaries.add(start);
    }
  }
  const starts = [...boundaries, text.length];
  const parts: ArticlePart[] = [];
  for (let i = 1; i < starts.length; i++) {
    const start = starts[i - 1];
    const sectionEnd = starts[i];
    const target = explicit.has(start) ? SECTION_LENGTH : SECTION_TARGET;
    const breaks = blockStarts.filter(point => point > start && point < sectionEnd);
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
  return !article.selection || ('path' in article.selection && !article.selection.readOnly && article.selection.start >= 0 &&
    article.selection.source === article.source);
}

export function sectionAt(article: ArticleSummary, index: number): ArticlePart {
  return article.parts[index] ?? article.supplements![index - article.parts.length];
}

export function sectionSource(article: ArticleSummary, part: ArticlePart) {
  return readingProjection(article.source, part.start, part.end);
}

export function translationChunks(article: ArticleSummary, part: ArticlePart): ArticlePart[] {
  const reading = sectionSource(article, part);
  return reading.text.length <= SECTION_LENGTH ? [part] : planParts(reading.text, 0).map(({start, end}) => ({
    start: reading.sourceOffset(start, 'start'), end: reading.sourceOffset(end, 'end'),
  }));
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
    const shift = <T extends ArticlePart>(part: T) => ({...part, start: part.start + receipt.length, end: part.end + receipt.length});
    return {...article, source: receipt.after, parts: article.parts.map(shift),
      ...(article.supplements && {supplements: article.supplements.map(shift)}),
      selection: selection && 'path' in selection ? rebaseSelectionAfterInsertion(selection, receipt) ?? selection : selection};
  }
  return 'path' in selection ? {...article, selection: {...selection, source: receipt.after}} : article;
}

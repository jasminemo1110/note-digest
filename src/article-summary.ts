import { articleBody, articleStart, frontmatterEnd, paragraphRanges, readingProjection, savedSummaryRanges, SUMMARY_CALLOUT, SUMMARY_START, SUMMARY_END } from './anchors';
import { escapeMarkdown, rebaseSelectionAfterInsertion, type DigestSelection, type InsertionReceipt } from './core';
import { parseMarkdown, proseText } from './markdown-source';
import type { RootContent } from 'mdast';

const SECTION_TARGET = 1800;
const SECTION_LENGTH = 6000;
export const MAX_SECTIONS = 40;

export interface ArticlePart { start: number; end: number }
export interface ArticleSupplement extends ArticlePart { label: string }
export interface SectionSummary { title: string; summary: string }
export interface DigestBatch { parts: ArticlePart[]; label?: string }
export interface ArticleSummary {
  path: string;
  source: string;
  selection?: DigestSelection;
  parts: ArticlePart[];
  supplements?: ArticleSupplement[];
  sections: SectionSummary[];
  overview?: string;
  batches?: DigestBatch[];
  batch?: {index: number; total: number; label?: string};
}

export function planArticleSummary(path: string, source: string): ArticleSummary {
  const body = articleBody(source);
  const reading = readingProjection(source, articleStart(source), body.length, body);
  const blocks = parseMarkdown(reading.text).children;
  const supplements = supplementalParts(reading.text, blocks);
  const text = reading.text.slice(0, supplements[0]?.start);
  const mainBlocks = blocks.filter(node => node.position!.start.offset! < text.length);
  const parts = planParts(text, mainBlocks);
  const locate = ({start, end}: ArticlePart) => ({
    start: reading.sourceOffset(start, 'start'), end: reading.sourceOffset(end, 'end'),
  });
  const located = parts.map(locate);
  const batches = parts.length > MAX_SECTIONS ? planBatches(text, mainBlocks, parts, located) : undefined;
  return {path, source, parts: located, sections: [], ...(batches && {batches}),
    ...(supplements.length && {supplements: supplements.map(part => ({...part, ...locate(part)}))})};
}

export function selectDigestBatch(plan: ArticleSummary, index: number): ArticleSummary {
  const {batches, supplements, ...article} = plan;
  const batch = batches?.[index];
  if (!batches || !batch) throw new Error('分篇范围已变化，请重新打开 Digest 全文。');
  return {...article, parts: batch.parts, sections: [], batch: {index, total:batches.length, label:batch.label},
    ...(index === batches.length - 1 && supplements && {supplements})};
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
        parts: boundedParts(reading.text).map(part => ({
          start: reading.sourceOffset(part.start, 'start'), end: reading.sourceOffset(part.end, 'end'),
        })), sections: []};
    }
    return {path: selection.path, source: selection.text, selection, parts: boundedParts(selection.text), sections: []};
  }
  return {path: '', source: selection.text, selection, parts: boundedParts(selection.text), sections: []};
}

const supplementName = /^(?:notes|endnotes|footnotes|references|bibliography|sources|further reading|acknowledg(?:e)?ments|supplementary (?:material|information)|appendix(?: [A-Z0-9]+)?|podcasts?)\s*[:：]?$/i;

function supplementalParts(body: string, blocks: RootContent[]): ArticleSupplement[] {
  const headings = blocks.flatMap(node => {
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

function boundedParts(text: string): ArticlePart[] {
  const parts = planParts(text);
  if (parts.length > MAX_SECTIONS) throw new Error(`所选范围超过 ${MAX_SECTIONS} 节，请缩短范围后再试。`);
  return parts;
}

function planParts(text: string, blocks = parseMarkdown(text).children): ArticlePart[] {
  if (!text.trim()) throw new Error('没有可总结的正文。');
  const boundaries = new Set([0]);
  const explicit = new Set<number>();
  const blockStarts: number[] = [];
  for (const node of blocks) {
    if (!node.position) continue;
    const start = node.position.start.offset!;
    blockStarts.push(start);
    const question = node.type === 'paragraph' &&
      /^(?:\*\*|__)?[\p{L}][\p{L}\p{N} .&’'-]{0,30}: .+\?(?:\*\*|__)?\s*$/u.test(text.slice(start, node.position.end.offset).split(/\r?\n/, 1)[0]);
    if (node.type === 'heading' || question) {
      explicit.add(start);
      boundaries.add(start);
    }
  }
  const starts = [...boundaries, text.length];
  const parts: ArticlePart[] = [];
  let nextBreak = 0;
  for (let i = 1; i < starts.length; i++) {
    const start = starts[i - 1];
    const sectionEnd = starts[i];
    const target = explicit.has(start) ? SECTION_LENGTH : SECTION_TARGET;
    while (nextBreak < blockStarts.length && blockStarts[nextBreak] <= start) nextBreak++;
    let cursor = start;
    while (cursor < sectionEnd) {
      const limit = Math.min(cursor + SECTION_LENGTH, sectionEnd);
      const desired = Math.min(cursor + target, limit);
      let end = cursor;
      while (nextBreak < blockStarts.length && blockStarts[nextBreak] < sectionEnd && blockStarts[nextBreak] <= desired) {
        end = blockStarts[nextBreak++];
      }
      if (limit === sectionEnd && sectionEnd - desired < Math.min(440, target / 4)) end = limit;
      if (end === cursor) {
        end = blockStarts[nextBreak] !== undefined && blockStarts[nextBreak] < sectionEnd && blockStarts[nextBreak] <= limit
          ? blockStarts[nextBreak++] : limit;
        if (end < sectionEnd && end === limit) {
          const hardEnd = end;
          while (end > cursor + SECTION_LENGTH / 2 && !/\s/.test(text[end - 1])) end--;
          if (end <= cursor + SECTION_LENGTH / 2) end = hardEnd;
          if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
        }
      }
      if (text.slice(cursor, end).trim()) {
        parts.push({start: cursor, end});
      }
      cursor = end;
    }
  }
  return parts;
}

function planBatches(text: string, blocks: RootContent[], parts: ArticlePart[], located: ArticlePart[]): DigestBatch[] {
  const indices = new Map(parts.map((part, index) => [part.start, index]));
  const headings = blocks.flatMap(node => {
    if (node.type !== 'heading' || !node.position) return [];
    const index = indices.get(node.position.start.offset!);
    return index === undefined ? [] : [{index, depth:node.depth,
      label:proseText(text.slice(node.position.start.offset, node.position.end.offset)).replace(/\s+/g, ' ').slice(0, 100)}];
  });
  const batches: {start:number; end:number}[] = [];
  const append = (start: number, end: number) => {
    const previous = batches.at(-1);
    if (previous && end - previous.start <= MAX_SECTIONS) previous.end = end;
    else batches.push({start, end});
  };
  // Keep complete chapters together. Only descend into subheadings of a chapter that exceeds the budget.
  const split = (start: number, end: number, inside: typeof headings) => {
    if (end - start <= MAX_SECTIONS) {
      append(start, end);
      return;
    }
    const boundaries = inside.filter(heading => heading.index > start && heading.index < end);
    if (!boundaries.length) {
      for (let cursor = start; cursor < end; cursor += MAX_SECTIONS) append(cursor, Math.min(cursor + MAX_SECTIONS, end));
      return;
    }
    const depth = boundaries.reduce((shallowest, heading) => Math.min(shallowest, heading.depth), 6);
    const cuts = [start, ...boundaries.filter(heading => heading.depth === depth).map(heading => heading.index), end];
    let nextHeading = 0;
    for (let i = 1; i < cuts.length; i++) {
      const first = nextHeading;
      while (nextHeading < boundaries.length && boundaries[nextHeading].index < cuts[i]) nextHeading++;
      split(cuts[i - 1], cuts[i], boundaries.slice(first, nextHeading));
    }
  };
  split(0, parts.length, headings);
  let heading = 0;
  let currentTitle: string | undefined;
  const titleAt = (index: number) => {
    while (heading < headings.length && headings[heading].index <= index) currentTitle = headings[heading++].label;
    return currentTitle;
  };
  return batches.map(({start, end}) => {
    const firstTitle = titleAt(start);
    const lastTitle = titleAt(end - 1);
    const label = firstTitle && lastTitle && firstTitle !== lastTitle ? `${firstTitle} — ${lastTitle}` : lastTitle;
    return {parts:located.slice(start, end), label};
  });
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

/** Keep the display, AI request, and write offsets tied to the same local paragraphs. */
export function articleTranslationParagraphs(article: ArticleSummary, part: ArticlePart) {
  const {text, sourceOffset} = sectionSource(article, part);
  const blocks = parseMarkdown(text).children;
  const ranges: ArticlePart[] = [];
  let block = 0;
  for (const range of paragraphRanges(text)) {
    while (block < blocks.length && blocks[block].position!.end.offset! <= range.start) block++;
    const nextBlock = blocks[block];
    const previous = ranges.at(-1);
    if (previous && nextBlock && nextBlock.position!.start.offset! < range.start) previous.end = range.end;
    else ranges.push(range);
  }
  return ranges.flatMap(({start, end}) => {
    const raw = text.slice(start, end);
    const source = article.selection && ('sidebar' in article.selection || article.selection.readOnly)
      ? raw.trim() : proseText(raw);
    if (!source) return [];
    const contentLength = raw.trimEnd().length;
    const trailingSpaces = raw.slice(contentLength).match(/^[ \t]*/)![0].length;
    return [{source, start: sourceOffset(start, 'start'), end: sourceOffset(end, 'end'),
      insertionOffset: sourceOffset(start + contentLength + trailingSpaces, 'end')}];
  });
}

export function translationChunks(article: ArticleSummary, part: ArticlePart): ArticlePart[] {
  const reading = sectionSource(article, part);
  return reading.text.length <= SECTION_LENGTH ? [part] : boundedParts(reading.text).map(({start, end}) => ({
    start: reading.sourceOffset(start, 'start'), end: reading.sourceOffset(end, 'end'),
  }));
}

export function overviewInsertion(current: string, article: ArticleSummary): InsertionReceipt | undefined {
  if (!article.path || current !== articleFileSource(article)) throw new Error('原文已修改，请重新打开 Digest。');
  if (!article.overview) throw new Error('没有可以添加到文首的概览。');
  const newline = current.match(/\r?\n/)?.[0] ?? '\n';
  const title = article.batch ? `第 ${article.batch.index + 1} 篇摘要` : article.selection ? '选段摘要' : '中文摘要';
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

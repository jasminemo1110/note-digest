import { articleBody, paragraphRanges } from './anchors';

const SECTION_LENGTH = 6000;
const MAX_SECTIONS = 40;

export interface ArticlePart { start: number; end: number }
export interface SectionSummary { title: string; summary: string }
export interface ArticleSummary {
  path: string;
  source: string;
  parts: ArticlePart[];
  sections: SectionSummary[];
  overview?: string;
}

export function planArticleSummary(path: string, source: string): ArticleSummary {
  const body = articleBody(source);
  const frontmatter = body.match(/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  const start = frontmatter?.[0].length ?? 0;
  const text = body.slice(start);
  if (!text.trim()) throw new Error('文章没有可总结的正文。');

  const headings = [0];
  let fence: string | undefined;
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    const marker = line[0].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
    } else if (marker) {
      fence = marker[1];
    } else if (line.index > 0 && /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line[0]) && text.slice(headings.at(-1), line.index).trim()) {
      headings.push(line.index);
    }
  }
  headings.push(text.length);

  const parts: ArticlePart[] = [];
  for (let i = 1; i < headings.length; i++) {
    let cursor = headings[i - 1];
    const sectionEnd = headings[i];
    const breaks = paragraphRanges(text.slice(cursor, sectionEnd)).slice(1).map(range => cursor + range.start);
    let nextBreak = 0;
    while (cursor < sectionEnd) {
      const limit = Math.min(cursor + SECTION_LENGTH, sectionEnd);
      let end = cursor;
      while (nextBreak < breaks.length && breaks[nextBreak] <= limit) end = breaks[nextBreak++];
      if (limit === sectionEnd) end = limit;
      if (end <= cursor) {
        end = limit;
        while (end > cursor + SECTION_LENGTH / 2 && !/\s/.test(text[end - 1])) end--;
        if (end <= cursor + SECTION_LENGTH / 2) end = limit;
        if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
      }
      if (text.slice(cursor, end).trim()) {
        if (parts.length === MAX_SECTIONS) throw new Error(`正文超过目前的 ${MAX_SECTIONS} 节摘要上限，请分篇后再试。`);
        parts.push({start: start + cursor, end: start + end});
      }
      cursor = end;
    }
  }
  return {path, source, parts, sections: []};
}

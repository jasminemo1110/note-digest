/** Generated learning sections never become source material or contextual matches. */
export const LEARNING_BOUNDARY = '\n\n<!-- note-digest:learning -->\n';
export function articleBody(source: string): string {
  const boundary = source.indexOf(LEARNING_BOUNDARY);
  return (boundary < 0 ? source : source.slice(0, boundary)).trimEnd();
}
export function paragraphRanges(text: string): { start: number; end: number }[] {
  const ranges = [];
  let start = 0;
  for (const separator of text.matchAll(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g)) {
    ranges.push({start, end: separator.index});
    start = separator.index + separator[0].length;
  }
  ranges.push({start, end: text.length});
  return ranges;
}
export interface Anchor { block: string; offset: number; text: string }
export function makeAnchor(source: string, start: number, text: string): Anchor {
  const body = articleBody(source);
  if (start < 0 || body.slice(start, start + text.length) !== text) throw new Error('请选择原文章中的内容，不要收藏生成的学习区。');
  const ranges = paragraphRanges(body);
  let blockStart = 0;
  for (const range of ranges) {
    if (range.start > start) break;
    blockStart = range.start;
  }
  const blockEnd = ranges.find(range => range.end >= start + text.length)?.end ?? body.length;
  const block = body.slice(blockStart, blockEnd);
  if (block.length > 24000) throw new Error('所选语境超过 24,000 字符。请选中更短的范围，或在编辑模式拆分原文段落后重试。');
  return {block, offset: start - blockStart, text};
}
/** Match the complete stored context and its boundaries, including older LF-only anchors. */
export function locateAnchor(source: string, anchor: Anchor): number | null {
  if (anchor.block.slice(anchor.offset, anchor.offset + anchor.text.length) !== anchor.text) return null;
  const body = articleBody(source);
  const ranges = paragraphRanges(body);
  const ends = new Set(ranges.map(range => range.end));
  const matches = new Set<number>();
  for (const {start} of ranges) {
    if (ends.has(start + anchor.block.length) && body.startsWith(anchor.block, start)) matches.add(start + anchor.offset);
  }
  let offset = 0;
  for (const block of body.split('\n\n')) {
    if (block === anchor.block) matches.add(offset + anchor.offset);
    offset += block.length + 2;
  }
  return matches.size === 1 ? matches.values().next().value ?? null : null;
}

/** Resolve a reading-view selection against its source section, not a global word search. */
export function renderedSelectionOffset(source: string, lineStart: number, lineEnd: number, paragraph: string, localOffset: number, text: string): number | undefined {
  if (!Number.isInteger(localOffset) || localOffset < 0 || paragraph.slice(localOffset, localOffset + text.length) !== text) return undefined;
  const lines = source.split('\n');
  const sectionStart = lines.slice(0, lineStart).reduce((sum, line) => sum + line.length + 1, 0);
  const section = lines.slice(lineStart, lineEnd + 1).join('\n');
  const start = section.indexOf(paragraph);
  if (!paragraph || start < 0 || section.indexOf(paragraph, start + 1) !== -1) return undefined;
  const offset = sectionStart + start + localOffset;
  return articleBody(source).slice(offset, offset + text.length) === text ? offset : undefined;
}

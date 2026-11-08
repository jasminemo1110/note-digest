/** Generated learning sections never become source material or contextual matches. */
export const LEARNING_BOUNDARY = '\n\n<!-- note-digest:learning -->\n';
export function articleBody(source: string): string {
  const boundary = source.indexOf(LEARNING_BOUNDARY);
  return (boundary < 0 ? source : source.slice(0, boundary)).trimEnd();
}
export interface Anchor { block: string; offset: number; text: string }
export function makeAnchor(source: string, start: number, text: string): Anchor {
  const body = articleBody(source);
  if (start < 0 || body.slice(start, start + text.length) !== text) throw new Error('请选择原文章中的内容，不要收藏生成的学习区。');
  const left = body.lastIndexOf('\n\n', start);
  const end = body.indexOf('\n\n', start + text.length);
  const blockStart = left < 0 ? 0 : left + 2;
  const block = body.slice(blockStart, end < 0 ? body.length : end);
  if (block.length > 24000) throw new Error('语境段落过长，请先分段。');
  return {block, offset: start - blockStart, text};
}
/** Exact paragraph match only. Ambiguous/changed paragraphs must not be guessed. */
export function locateAnchor(source: string, anchor: Anchor): number | null {
  const body = articleBody(source);
  let offset = 0;
  const matches: number[] = [];
  for (const block of body.split('\n\n')) {
    if (block === anchor.block && block.slice(anchor.offset, anchor.offset + anchor.text.length) === anchor.text) matches.push(offset + anchor.offset);
    offset += block.length + 2;
  }
  return matches.length === 1 ? matches[0] : null;
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

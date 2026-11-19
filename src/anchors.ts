/** Generated learning sections never become source material or contextual matches. */
export const LEARNING_BOUNDARY = '\n\n<!-- note-digest:learning -->\n';
export const LEARNING_HEADING = '## Note Digest 学习笔记';
const learningSectionHeading = '\n\n' + LEARNING_HEADING;
export function articleBody(source: string): string {
  const boundary = source.indexOf(LEARNING_BOUNDARY);
  if (boundary < 0) return source.trimEnd();
  const headingStart = boundary - learningSectionHeading.length;
  // A marker below the heading stays inside that section when reordered in Outline.
  if (headingStart >= 0 && source.startsWith(learningSectionHeading, headingStart)) {
    return source.slice(0, headingStart).trimEnd();
  }
  const afterMarker = boundary + LEARNING_BOUNDARY.length;
  // Content can be inserted between the hidden marker and the generated heading in a rendered editor.
  const tail = source.slice(afterMarker);
  const heading = /^## Note Digest 学习笔记[ \t]*\r?\n[ \t\r\n]*(?=<!-- note-digest:(?:group:(?:word|quote)|record:[\w-]+) -->)/m.exec(tail);
  if (heading && tail.slice(0, heading.index).trim()) {
    const hiddenMarker = LEARNING_BOUNDARY.replace(/[^\r\n]/g, ' ');
    return (source.slice(0, boundary) + hiddenMarker + tail.slice(0, heading.index)).trimEnd();
  }
  return source.slice(0, boundary).trimEnd();
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
export interface Anchor { block: string; offset: number; text: string; excerpt?: true; location?: { start: number; digest: string } }

export async function digestText(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeCollectionRange(source: string, offset: number, text: string, kind: 'word' | 'quote') {
  const edges = kind === 'word' ? /[\s.,!?;:()[\]{}"'“”‘’，。！？；：（）【】—–]/u : /\s/u;
  let start = offset;
  let end = offset + text.length;
  while (start < end && edges.test(source[start])) start++;
  while (end > start && edges.test(source[end - 1])) end--;
  if (kind === 'word' && start < end) {
    const word = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;
    const words: {start: number; end: number}[] = [];
    word.lastIndex = start;
    while (word.lastIndex > 0 && !/[\s()[\]{}]/u.test(source[word.lastIndex - 1])) word.lastIndex--;
    for (const match of source.matchAll(word)) {
      if (match.index >= end) break;
      const wordEnd = match.index + match[0].length;
      if (wordEnd > start) words.push({start: match.index, end: wordEnd});
    }
    const hasCompleteWord = words.some(word => word.start >= start && word.end <= end);
    if (hasCompleteWord) {
      const first = words[0];
      const last = words.at(-1)!;
      if (first.start < start && /^[\p{L}]{1,2}$/u.test(source.slice(start, first.end))) start = first.end;
      if (last.end > end && /^[\p{L}]{1,2}$/u.test(source.slice(last.start, end))) end = last.start;
      while (start < end && edges.test(source[start])) start++;
      while (end > start && edges.test(source[end - 1])) end--;
    }
  }
  return start === end ? {offset, text} : {offset: start, text: source.slice(start, end)};
}

export function makeAnchor(source: string, start: number, text: string): Anchor {
  const body = articleBody(source);
  if (start < 0 || body.slice(start, start + text.length) !== text) throw new Error('请选择原文章中的内容，不要收藏生成的学习区。');
  const ranges = paragraphRanges(body);
  let blockStart = 0;
  for (const range of ranges) {
    if (range.start > start) break;
    blockStart = range.start;
  }
  const end = start + text.length;
  const blockEnd = ranges.find(range => range.end >= end)?.end ?? body.length;
  if (blockEnd - blockStart > 24000) {
    if (text.length > 12000) throw new Error('请选择 1–12,000 字符的 Markdown 英文内容。');
    // A large Markdown table is one paragraph for anchor purposes. Keep a bounded exact excerpt.
    const excerptStart = Math.max(blockStart, start - 6000);
    return {block:body.slice(excerptStart, Math.min(blockEnd, end + 6000)), offset:start - excerptStart, text, excerpt:true};
  }
  return {block: body.slice(blockStart, blockEnd), offset: start - blockStart, text};
}
/** Match the complete stored context and its boundaries, including older LF-only anchors. */
export function locateAnchor(source: string, anchor: Anchor): number | null {
  if (anchor.block.slice(anchor.offset, anchor.offset + anchor.text.length) !== anchor.text) return null;
  const body = articleBody(source);
  if (anchor.excerpt) {
    const start = body.indexOf(anchor.block);
    return start >= 0 && body.indexOf(anchor.block, start + 1) < 0 ? start + anchor.offset : null;
  }
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

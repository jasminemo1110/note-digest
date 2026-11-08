import { locateAnchor } from './anchors';
import type { LearningRecord } from './collection';
export interface HighlightRange { start: number; end: number; kind: 'word' | 'quote' }
/** Source offsets constrain highlights to the actual rendered source section, never exports. */
export function highlightRanges(source: string, lineStart: number, lineEnd: number, visible: string, records: LearningRecord[]): HighlightRange[] {
  const lines = source.split('\n');
  const sectionStart = lines.slice(0, lineStart).reduce((sum, line) => sum + line.length + 1, 0);
  const sectionEnd = sectionStart + lines.slice(lineStart, lineEnd + 1).join('\n').length;
  const ranges: HighlightRange[] = [];
  for (const record of records) {
    const position = locateAnchor(source, record.anchor);
    if (position === null || position < sectionStart || position + record.anchor.text.length > sectionEnd) continue;
    // Exact plain-text paragraph matching is deliberately conservative for rich Markdown.
    const block = record.anchor.block.trim();
    if (visible !== block) continue;
    const leading = record.anchor.block.length - record.anchor.block.trimStart().length;
    const start = record.anchor.offset - leading;
    if (start >= 0 && visible.slice(start, start + record.anchor.text.length) === record.anchor.text) ranges.push({start, end:start + record.anchor.text.length, kind:record.kind});
  }
  return ranges;
}
export function clearHighlights(root: HTMLElement): void {
  for (const mark of Array.from(root.querySelectorAll('mark.note-digest-highlight'))) {
    mark.replaceWith(...Array.from(mark.childNodes));
  }
  root.normalize();
}
/** Split only text nodes: links, selection and nested formatting keep their elements/listeners. */
export function applyHighlights(element: HTMLElement, ranges: HighlightRange[]): void {
  if (!ranges.length) return;
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, 4); // SHOW_TEXT, also works across pop-out windows.
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  let offset = 0;
  for (const text of nodes) {
    const value = text.data; const start = offset; offset += value.length;
    const intersections = ranges.filter(range => range.end > start && range.start < offset);
    if (!intersections.length) continue;
    const points = [...new Set([0, value.length, ...intersections.flatMap(range => [Math.max(0, range.start - start), Math.min(value.length, range.end - start)])])].sort((a,b) => a-b);
    const fragment = doc.createDocumentFragment();
    for (let i = 0; i < points.length - 1; i++) {
      const left = points[i]; const right = points[i + 1];
      const covered = intersections.filter(range => range.start < start + right && range.end > start + left);
      const piece = value.slice(left, right);
      if (covered.length) {
        const mark = doc.createElement('mark'); mark.className = 'note-digest-highlight';
        mark.dataset.kind = covered.some(range => range.kind === 'word') ? 'word' : 'quote';
        mark.title = mark.dataset.kind === 'word' ? '已收藏词语' : '已收藏金句'; mark.textContent = piece; fragment.append(mark);
      } else fragment.append(doc.createTextNode(piece));
    }
    text.replaceWith(fragment);
  }
}

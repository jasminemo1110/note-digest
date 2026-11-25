import { articleBody, digestText, locateAnchor } from './anchors';
import { COLLECTION_LABELS, type Kind, type LearningRecord } from './collection';
import { mapTableRanges, type RenderedSection } from './markdown-source';
export interface HighlightRange { start: number; end: number; kind: Kind }
/** Source offsets constrain highlights to the actual rendered source section, never exports. */
export function highlightRanges(source: string, lineStart: number, lineEnd: number, visible: string, records: LearningRecord[]): HighlightRange[] {
  const lines = source.split('\n');
  const sectionStart = lines.slice(0, lineStart).reduce((sum, line) => sum + line.length + 1, 0);
  const sectionEnd = sectionStart + lines.slice(lineStart, lineEnd + 1).join('\n').length;
  const ranges: HighlightRange[] = [];
  for (const record of records) {
    if (record.unlocated) continue;
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

export async function tableHighlightRanges(source: string, section: RenderedSection, table: HTMLTableElement,
  records: LearningRecord[]): Promise<Map<HTMLTableCellElement, HighlightRange[]>> {
  const highlights = new Map<HTMLTableCellElement, HighlightRange[]>();
  const cells = Array.from(table.rows, row => Array.from(row.cells));
  if (table.closest('.internal-embed, .markdown-embed, .markdown-source-view') || table.querySelector('table') ||
      cells.some(row => row.some(cell => cell.rowSpan !== 1 || cell.colSpan !== 1))) return highlights;
  const body = articleBody(source);
  const active = records.filter(record => record.active && !record.unlocated);
  const digest = active.some(record => record.anchor.location) ? await digestText(body) : undefined;
  const ranges: HighlightRange[] = [];
  for (const {anchor, kind} of active) {
    const position = anchor.location ? (anchor.location.digest === digest ? anchor.location.start : null) : locateAnchor(source, anchor);
    if (position === null || body.slice(position, position + anchor.text.length) !== anchor.text) continue;
    ranges.push({start:position, end:position + anchor.text.length, kind});
  }
  for (const {row, column, range, selection} of mapTableRanges(source, section, cells.map(row => row.map(cell => cell.textContent ?? '')), ranges)) {
    const cell = cells[row][column];
    const highlight = {...range, kind:selection.kind};
    const existing = highlights.get(cell);
    if (existing) existing.push(highlight);
    else highlights.set(cell, [highlight]);
  }
  return highlights;
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
        const kind = covered.some(range => range.kind === 'word') ? 'word' :
          covered.some(range => range.kind === 'expression') ? 'expression' : 'quote';
        mark.dataset.kind = kind;
        mark.title = `已收藏${kind === 'word' ? '词语' : COLLECTION_LABELS[kind]}`;
        mark.textContent = piece; fragment.append(mark);
      } else fragment.append(doc.createTextNode(piece));
    }
    text.replaceWith(fragment);
  }
}

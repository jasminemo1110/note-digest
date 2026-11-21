import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTable } from 'micromark-extension-gfm-table';
import type { Nodes, Paragraph, PhrasingContent, Root, Table, Text } from 'mdast';
import { articleBody } from './anchors';

export interface SourceRange { start: number; end: number }
export interface RenderedSection { lineStart: number; lineEnd: number; text: string }
export interface TableCellPosition { row: number; column: number; rows: number; columns: number; widgetStart?: number }
type ReadingBlock = Extract<Nodes, {type: 'paragraph' | 'heading' | 'tableCell'}>;

const tableExtensions = {extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()]};

export function markdownBody(source: string): Root {
  const body = articleBody(source).replace(
    /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
    properties => properties.replace(/[^\r\n]/g, ' '),
  );
  return fromMarkdown(body, tableExtensions);
}

/** Readable text from a local Markdown span, keeping labels and excluding media markup. */
export function proseText(source: string): string {
  function read(node: Nodes): string {
    if (node.type === 'break') return '\n';
    if (node.type === 'html') return '';
    if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
    if ('value' in node) return typeof node.value === 'string' ? node.value : '';
    if ('children' in node) {
      const separator = ['root', 'list', 'listItem', 'blockquote', 'table', 'tableRow'].includes(node.type) ? '\n' : '';
      return node.children.map(read).filter(Boolean).join(separator);
    }
    return '';
  }
  return read(fromMarkdown(source, tableExtensions)).trim();
}

function range(node: Nodes): SourceRange {
  return {start: node.position!.start.offset!, end: node.position!.end.offset!};
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

export function tableCellSourceRange(source: string, selection: SourceRange): SourceRange | undefined {
  const lineStart = source.lastIndexOf('\n', selection.start - 1) + 1;
  const lineEnd = source.indexOf('\n', selection.end);
  if (!source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).includes('|')) return;
  for (const node of markdownBody(source).children) {
    if (node.type !== 'table' || !contains(range(node), selection)) continue;
    const row = node.children.find(row => contains(range(row), selection));
    const cell = row?.children.find(cell => contains(range(cell), selection));
    if (cell) return range(cell);
  }
}

function visible(node: PhrasingContent): string | undefined {
  switch (node.type) {
    case 'text': return node.value;
    case 'break': return '\n';
    case 'emphasis': case 'strong': case 'link': return visibleChildren(node.children);
  }
}

function visibleChildren(children: PhrasingContent[]): string | undefined {
  const parts = children.map(visible);
  return parts.includes(undefined) ? undefined : parts.join('');
}

function normalized(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ');
}

/** Map a visible text offset back to a source offset, including a collapsed newline/indent. */
function rawPoint(source: string, node: Text, point: number): number | undefined {
  const {start, end} = range(node);
  if (point === 0) return start;
  if (point === node.value.length) return end;
  const raw = source.slice(start, end);
  if (raw === node.value) return start + point;
  if (normalized(raw) !== normalized(node.value)) return;
  const length = normalized(node.value.slice(0, point)).length;
  let count = 0;
  for (const match of raw.matchAll(/[ \t\r\n]+|[^ \t\r\n]/g)) {
    if (++count === length) return start + match.index + match[0].length;
  }
}

function visiblePoint(source: string, children: PhrasingContent[], point: number, edge: 'start'|'end'): number | undefined {
  let cursor = 0;
  for (const node of children) {
    const value = visible(node)!;
    const end = cursor + value.length;
    if ((edge === 'start' ? point >= cursor && point < end : point > cursor && point <= end)) {
      if (node.type === 'text') return rawPoint(source, node, point - cursor);
      if (node.type === 'emphasis' || node.type === 'strong' || node.type === 'link') {
        return visiblePoint(source, node.children, point - cursor, edge);
      }
      return edge === 'start' ? range(node).start : range(node).end;
    }
    cursor = end;
  }
}

function isSupported(source: string, block: ReadingBlock): boolean {
  const {start, end} = range(block);
  // Obsidian syntax outside CommonMark can change how this text is rendered.
  const raw = source.slice(start, end);
  return (block.type === 'tableCell' || !raw.includes('|')) &&
    !/\[\[|%%|\$|==|~~|(?:^|\s)\^[\w-]+\s*$|(?:^|\s)#[\w/-]+/m.test(raw) &&
    ((source.slice(0, start).match(/%%/g)?.length ?? 0) % 2 === 0) &&
    ((source.slice(0, start).match(/^ {0,3}\$\$[ \t]*\r?$/gm)?.length ?? 0) % 2 === 0) &&
    visibleChildren(block.children) !== undefined;
}

function sectionRange(source: string, section: RenderedSection): SourceRange | undefined {
  const lines = source.split('\n');
  const sectionStart = lines.slice(0, section.lineStart).reduce((offset, line) => offset + line.length + 1, 0);
  const sectionSource = lines.slice(section.lineStart, section.lineEnd + 1).join('\n');
  const sameText = (left: string, right: string) => left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n');
  if (!sameText(section.text, source) && !sameText(section.text, sectionSource) && !sameText(section.text, sectionSource + '\n')) return;

  return {start: sectionStart, end: sectionStart + sectionSource.length};
}

function readingBlocks(node: Nodes): ReadingBlock[] {
  if (node.type === 'paragraph' || node.type === 'heading') return [node];
  if (node.type === 'blockquote' || node.type === 'list' || node.type === 'listItem') return node.children.flatMap(readingBlocks);
  return [];
}

function readingTable(nodes: Root['children'], bounds?: SourceRange, widgetStart?: number): Table | undefined {
  const tables = nodes.filter((node): node is Table => node.type === 'table' && (widgetStart !== undefined
    ? range(node).start === widgetStart
    : !!bounds && contains(bounds, range(node))));
  if (tables.length === 1) return tables[0];
}

export function mapReadingRange(source: string, section: RenderedSection | undefined,
  blockText: string, localOffset: number, text: string, cell?: TableCellPosition, tag?: string): SourceRange | undefined {
  if (!text.trim() || blockText.slice(localOffset, localOffset + text.length) !== text) return;
  const bounds = section && sectionRange(source, section);
  if (!bounds && cell?.widgetStart === undefined) return;
  const nodes = markdownBody(source).children;
  let candidates: ReadingBlock[];
  if (cell) {
    const table = readingTable(nodes, bounds, cell.widgetStart);
    if (!table) return;
    if (table.children.length !== cell.rows || table.children[0].children.length !== cell.columns) return;
    const tableCell = table.children[cell.row]?.children[cell.column];
    if (!tableCell) return;
    const raw = range(tableCell);
    if (cell.widgetStart !== undefined && source.slice(raw.start, raw.end) === blockText) {
      return {start: raw.start + localOffset, end: raw.start + localOffset + text.length};
    }
    candidates = [tableCell];
  } else {
    candidates = nodes.filter(node => contains(bounds!, range(node))).flatMap(readingBlocks)
      .filter(node => !tag || (node.type === 'heading' ? tag === `h${node.depth}` : !/^h[1-6]$/.test(tag)));
  }
  candidates = candidates.filter(node => isSupported(source, node) && normalized(visibleChildren(node.children)!) === normalized(blockText));
  if (candidates.length !== 1) return;
  return readingRangeMapper(source, candidates[0], blockText)(localOffset, text.length);
}

function readingRangeMapper(source: string, {children}: ReadingBlock, blockText: string) {
  const rendered = visibleChildren(children)!;
  const coordinates = (point: number) => normalized(blockText.slice(0, point)).length;
  const offsets = [...rendered.matchAll(/[ \t\r\n]+|[^ \t\r\n]/g)].map(match => ({
    start: match.index, end: match.index + match[0].length,
  }));
  return (localOffset: number, length: number): SourceRange | undefined => {
    const first = offsets[coordinates(localOffset)];
    const last = offsets[coordinates(localOffset + length) - 1];
    if (!first || !last) return;
    const start = visiblePoint(source, children, first.start, 'start');
    const end = visiblePoint(source, children, last.end, 'end');
    if (start !== undefined && end !== undefined && end > start) return {start, end};
  };
}

/** Project verified source ranges onto a rendered table, round-tripping each visible match. */
export function mapTableRanges<T extends SourceRange>(source: string, section: RenderedSection, rows: string[][], ranges: T[]) {
  const mapped: {row: number; column: number; range: SourceRange; selection: T}[] = [];
  const bounds = sectionRange(source, section);
  if (!bounds) return mapped;
  const selections = ranges.filter(selection => contains(bounds, selection));
  if (!selections.length) return mapped;
  const table = readingTable(markdownBody(source).children, bounds);
  if (!table || table.children.length !== rows.length || rows.some(row => row.length !== table.children[0].children.length)) return mapped;

  for (const [row, cells] of rows.entries()) {
    for (const [column, text] of cells.entries()) {
      const cell = table.children[row].children[column];
      if (!cell) continue;
      const bounds = range(cell);
      const matches = selections.filter(selection => contains(bounds, selection));
      if (!matches.length || !isSupported(source, cell) || normalized(visibleChildren(cell.children)!) !== normalized(text)) continue;
      const map = readingRangeMapper(source, cell, text);
      for (const selection of matches) {
        const selected = source.slice(selection.start, selection.end);
        if (!selected) continue;
        const offsets: number[] = [];
        for (let offset = text.indexOf(selected); offset >= 0; offset = text.indexOf(selected, offset + 1)) {
          const result = map(offset, selected.length);
          if (result?.start === selection.start && result.end === selection.end) offsets.push(offset);
        }
        if (offsets.length === 1) mapped.push({row, column, range:{start:offsets[0],end:offsets[0] + selected.length}, selection});
      }
    }
  }
  return mapped;
}

interface InlineTarget {
  offset: number;
  apply: (value: string) => void;
}

function inlineTarget(source: string, children: PhrasingContent[], selection: SourceRange): InlineTarget | undefined {
  for (const [index, node] of children.entries()) {
    if (!contains(range(node), selection)) continue;
    if (node.type === 'emphasis' || node.type === 'strong') return inlineTarget(source, node.children, selection);
    if (node.type === 'link' && source[range(node).start] === '[') {
      const first = node.children[0];
      const last = node.children.at(-1);
      if (first && last && selection.start === range(first).start && selection.end === range(last).end) {
        return {offset: range(node).end, apply: value => { children.splice(index + 1, 0, {type:'text', value}); }};
      }
    }
    if (node.type === 'text') {
      const bounds = range(node);
      const raw = source.slice(bounds.start, bounds.end);
      const offset = selection.end - bounds.start;
      if (/https?:\/\/|www\./i.test(raw)) return;
      let textOffset: number | undefined;
      if (raw === node.value) textOffset = offset;
      else if (selection.end === bounds.end) textOffset = node.value.length;
      else if (normalized(raw) === normalized(node.value) && !/[ \t\r\n]/.test(raw[offset - 1] ?? '')) {
        const match = [...node.value.matchAll(/[ \t\r\n]+|[^ \t\r\n]/g)][normalized(raw.slice(0, offset)).length - 1];
        if (match) textOffset = match.index + match[0].length;
      }
      if (textOffset !== undefined) {
        return {offset: selection.end, apply: value => { node.value = node.value.slice(0, textOffset) + value + node.value.slice(textOffset); }};
      }
    }
  }
}

function endsInLinkSyntax(children: PhrasingContent[], selection: SourceRange): boolean {
  return children.some(node => {
    if (node.type === 'strong' || node.type === 'emphasis') return endsInLinkSyntax(node.children, selection);
    if (node.type !== 'link') return false;
    const link = range(node);
    const first = node.children[0];
    const last = node.children.at(-1);
    return !first || !last || [selection.start, selection.end].some(point =>
      point > link.start && point < link.end && (point < range(first).start || point > range(last).end));
  });
}

export function insertionTarget(source: string, selection: SourceRange, mode: 'inline'|'below') {
  const tree = markdownBody(source);
  const index = tree.children.findIndex(node => node.type === 'paragraph' && contains(range(node), selection));
  const paragraph = tree.children[index] as Paragraph | undefined;
  if (!paragraph || !isSupported(source, paragraph) || endsInLinkSyntax(paragraph.children, selection)) return;
  if (mode === 'inline') {
    const target = inlineTarget(source, paragraph.children, selection);
    if (target) return {...target, tree, index};
  } else {
    const offset = range(paragraph).end;
    return {offset, tree, index};
  }
}

/** Omit offsets and merge neighboring text nodes for semantic comparisons. */
export function markdownStructure(tree: Root): string {
  return JSON.stringify(tree, (key, value: unknown) => {
    if (key === 'position') return undefined;
    if (key !== 'children' || !Array.isArray(value)) return value;
    const combined: Nodes[] = [];
    for (const node of value as Nodes[]) {
      const previous = combined.at(-1);
      if (node.type === 'text' && previous?.type === 'text') previous.value += node.value;
      else combined.push({...node});
    }
    return combined;
  });
}

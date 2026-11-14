import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, Paragraph, PhrasingContent, Root, Text } from 'mdast';
import { LEARNING_BOUNDARY } from './anchors';

export interface SourceRange { start: number; end: number }

export function markdownBody(source: string): Root {
  const boundary = source.indexOf(LEARNING_BOUNDARY);
  const body = source.slice(0, boundary < 0 ? source.length : boundary).replace(
    /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
    properties => properties.replace(/[^\r\n]/g, ' '),
  );
  return fromMarkdown(body);
}

function range(node: Nodes): SourceRange {
  return {start: node.position!.start.offset!, end: node.position!.end.offset!};
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
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

function isSupported(source: string, paragraph: Paragraph): boolean {
  const {start, end} = range(paragraph);
  // Obsidian syntax outside CommonMark can change how this text is rendered.
  return !/\[\[|%%|\$|==|~~|\||(?:^|\s)\^[\w-]+\s*$|(?:^|\s)#[\w/-]+/m.test(source.slice(start, end)) &&
    ((source.slice(0, start).match(/%%/g)?.length ?? 0) % 2 === 0) &&
    ((source.slice(0, start).match(/^ {0,3}\$\$[ \t]*\r?$/gm)?.length ?? 0) % 2 === 0) &&
    visibleChildren(paragraph.children) !== undefined;
}

export function mapReadingRange(source: string, section: {lineStart: number; lineEnd: number; text: string},
  paragraphText: string, localOffset: number, text: string): SourceRange | undefined {
  if (!text.trim() || paragraphText.slice(localOffset, localOffset + text.length) !== text) return;
  const lines = source.split('\n');
  const sectionStart = lines.slice(0, section.lineStart).reduce((offset, line) => offset + line.length + 1, 0);
  const sectionSource = lines.slice(section.lineStart, section.lineEnd + 1).join('\n');
  const sameText = (left: string, right: string) => left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n');
  if (!sameText(section.text, source) && !sameText(section.text, sectionSource) && !sameText(section.text, sectionSource + '\n')) return;

  const sectionRange = {start: sectionStart, end: sectionStart + sectionSource.length};
  const sectionNodes = markdownBody(source).children.filter(node =>
    range(node).start < sectionRange.end && range(node).end > sectionRange.start);
  const paragraphs = sectionNodes.filter((node): node is Paragraph => node.type === 'paragraph');
  if (paragraphs.length !== sectionNodes.length ||
      paragraphs.some(node => !contains(sectionRange, range(node)) || !isSupported(source, node))) return;
  const candidates = paragraphs.filter(node => normalized(visibleChildren(node.children)!) === normalized(paragraphText));
  if (candidates.length !== 1) return;
  const paragraph = candidates[0];
  const rendered = visibleChildren(paragraph.children)!;
  const coordinates = (point: number) => normalized(paragraphText.slice(0, point)).length;
  const offsets = [...rendered.matchAll(/[ \t\r\n]+|[^ \t\r\n]/g)].map(match => ({
    start: match.index, end: match.index + match[0].length,
  }));
  const first = offsets[coordinates(localOffset)];
  const last = offsets[coordinates(localOffset + text.length) - 1];
  if (!first || !last) return;
  const start = visiblePoint(source, paragraph.children, first.start, 'start');
  const end = visiblePoint(source, paragraph.children, last.end, 'end');
  if (start !== undefined && end !== undefined && end > start) return {start, end};
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

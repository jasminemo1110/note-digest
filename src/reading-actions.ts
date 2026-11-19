import type { Anchor } from './anchors';
import type { SidebarSelection } from './core';

const editableControl = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-editor';
const proseBlock = 'p, div, li, td, th, blockquote, dd, dt, figcaption, h1, h2, h3, h4, h5, h6, [role="paragraph"]';
const contextLimit = 1200;

export function isSelectionControl(element: Element | null): boolean {
  return !!element?.closest(`${editableControl}, button, .modal-container`);
}

function selectionElement(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

/** Read context before changing focus. A selection in one cell stays within that cell. */
export function articleRange(range: Range, content: HTMLElement, text: string) {
  const blockAt = (node: Node) => {
    const element = selectionElement(node);
    return element?.closest<HTMLElement>('td, th') ?? element?.closest<HTMLElement>(
      'p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, .cm-line',
    );
  };
  const start = blockAt(range.startContainer);
  const end = blockAt(range.endContainer);
  const readEdge = (block: Node, before: boolean) => {
    if (!block || !content.contains(block)) return '';
    const edge = range.cloneRange();
    edge.selectNodeContents(block);
    if (before) edge.setEnd(range.startContainer, range.startOffset);
    else edge.setStart(range.endContainer, range.endOffset);
    return edge.toString();
  };
  const prefix = readEdge(start ?? range.startContainer, true);
  const suffix = readEdge(end ?? range.endContainer, false);
  const limited = prefix.slice(-contextLimit);
  return {
    block: start === end && start && content.contains(start) ? start : undefined,
    text: prefix + text + suffix,
    offset: prefix.length,
    context: {text: limited + text + suffix.slice(0, contextLimit), offset: limited.length},
  };
}

/** Sidebar context comes from the same visible prose block or text node. */
export function sidebarSelection(selection: Selection, content: HTMLElement, includeContext = true): SidebarSelection | undefined {
  if (selection.rangeCount !== 1 || selection.isCollapsed || !content.isConnected) return;
  const range = selection.getRangeAt(0);
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return;
  const start = selectionElement(range.startContainer);
  if (isSelectionControl(start) || isSelectionControl(selectionElement(range.endContainer))) return;
  const controls = selectionElement(range.commonAncestorContainer)?.querySelectorAll(editableControl) ?? [];
  if (Array.from(controls).some(control => range.intersectsNode(control))) return;
  const text = selection.toString();
  if (!text.trim()) return;
  const captured: SidebarSelection = {sidebar: true, text, context: '', contextOffset: 0};
  if (!includeContext) return captured;

  let prefix = '';
  let suffix = '';
  const block = start?.closest<HTMLElement>(proseBlock);
  if (block && block !== content && content.contains(block) && block.contains(range.endContainer) &&
      !block.querySelector(`${proseBlock}, ${editableControl}, button, [hidden], [aria-hidden="true"]`) &&
      hasVisibleText(block)) {
    const before = range.cloneRange();
    before.selectNodeContents(block);
    before.setEnd(range.startContainer, range.startOffset);
    const after = range.cloneRange();
    after.selectNodeContents(block);
    after.setStart(range.endContainer, range.endOffset);
    prefix = before.toString().slice(-contextLimit);
    suffix = after.toString().slice(0, contextLimit);
  } else if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
    const line = range.startContainer.textContent ?? '';
    prefix = line.slice(Math.max(0, range.startOffset - contextLimit), range.startOffset);
    suffix = line.slice(range.endOffset, range.endOffset + contextLimit);
  }
  if (prefix.trim() || suffix.trim()) return {...captured, context: prefix + text + suffix, contextOffset: prefix.length};
  return captured;
}

function hasVisibleText(block: HTMLElement): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  return typeof block.innerText !== 'string' || normalize(block.innerText) === normalize(block.textContent ?? '');
}

/** Presentation context is shorter than the context supplied to the model. */
export function shortContext(anchor: Pick<Anchor, 'block' | 'offset' | 'text'>): string {
  const sentences = [...new Intl.Segmenter('en', {granularity: 'sentence'}).segment(anchor.block)];
  const selectedEnd = anchor.offset + anchor.text.length;
  let first = sentences.findIndex(sentence => sentence.index + sentence.segment.length > anchor.offset);
  if (first < 0) return anchor.text;
  let last = first;
  while (last + 1 < sentences.length && sentences[last + 1].index < selectedEnd) last++;
  if (last === first) {
    if (first > 0) first--;
    else if (last + 1 < sentences.length) last++;
  }
  let start = sentences[first].index;
  let end = sentences[last].index + sentences[last].segment.length;
  if (end - start > 500) {
    start = Math.max(start, anchor.offset - 150);
    end = Math.min(end, start + 500);
  }
  return (start > sentences[first].index ? '…' : '') + anchor.block.slice(start, end).trim() +
    (end < sentences[last].index + sentences[last].segment.length ? '…' : '');
}
export function readingShortcut(
  event: Pick<KeyboardEvent, 'key'|'altKey'|'ctrlKey'|'metaKey'|'shiftKey'|'repeat'|'isComposing'|'defaultPrevented'>,
  state: {reading: boolean; selectionInside: boolean; editable: boolean},
): 'digest' | 'quote' | null {
  if (!state.reading || !state.selectionInside || state.editable || event.defaultPrevented || event.repeat || event.isComposing ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  return event.key.toLowerCase() === 'd' ? 'digest' : event.key.toLowerCase() === 'n' ? 'quote' : null;
}

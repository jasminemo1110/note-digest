import type { Anchor } from './anchors';
import type { SidebarSelection } from './core';

const editableControl = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-editor';

export function isSelectionControl(element: Element | null): boolean {
  return !!element?.closest(`${editableControl}, button, .modal-container`);
}

function selectionElement(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

/** A sidebar selection is limited to explicitly selected text in one view. */
export function sidebarSelection(selection: Selection, content: HTMLElement): SidebarSelection | undefined {
  if (selection.rangeCount !== 1 || selection.isCollapsed || !content.isConnected) return;
  const range = selection.getRangeAt(0);
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return;
  if (isSelectionControl(selectionElement(range.startContainer)) || isSelectionControl(selectionElement(range.endContainer))) return;
  const controls = selectionElement(range.commonAncestorContainer)?.querySelectorAll(editableControl) ?? [];
  if (Array.from(controls).some(control => range.intersectsNode(control))) return;
  const text = selection.toString();
  if (text.trim()) return {sidebar: true, text, context: ''};
}

/** Presentation context is shorter than the context supplied to the model. */
export function shortContext(anchor: Anchor): string {
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

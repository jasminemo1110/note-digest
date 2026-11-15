import type { Anchor } from './anchors';
import type { SidebarSelection } from './core';

/** Capture one rendered answer block without including other turns or tool output. */
export function claudianSelection(selection: Selection | null): SidebarSelection | undefined {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const start = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
  const block = start?.closest('.claudian-message-assistant .claudian-text-block');
  if (!block?.contains(range.endContainer)) return;

  const text = selection.toString();
  if (!text.trim()) return;
  const paragraph = start?.closest('p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6');
  if (!paragraph || !block.contains(paragraph) || !paragraph.contains(range.endContainer)) {
    return {sidebar: 'Claudian', text, context: text, contextOffset: 0};
  }
  const before = range.cloneRange();
  before.selectNodeContents(paragraph);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(paragraph);
  after.setStart(range.endContainer, range.endOffset);
  const prefix = before.toString().slice(-1200);
  return {sidebar: 'Claudian', text, context: prefix + text + after.toString().slice(0, 1200), contextOffset: prefix.length};
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

import type { Anchor } from './anchors';

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

import type { DigestResult, ExpressionAssessment, SelectionSnapshot } from './core';
import { paragraphRanges } from './anchors';
export interface ParagraphTranslation { source: string; start: number; end: number; translation: string }
export function selectionParagraphs(selection: SelectionSnapshot): {source: string; start: number; end: number}[] {
  return paragraphRanges(selection.text)
    .map(({start, end}) => ({source: selection.text.slice(start, end), start: selection.start + start, end: selection.start + end}))
    .filter(part => part.source.trim());
}
export function isLongSelection(text: string): boolean { return text.trim().length > 400 || /\r?\n\s*\r?\n/.test(text.trim()); }
export function showAssessment(assessment?: ExpressionAssessment): boolean {
  return !!assessment && ['incorrect', 'unnatural', 'uncertain'].includes(assessment.status);
}
export function resultMode(result?: DigestResult): 'translate' | 'explain' | 'summarize' {
  return result?.summary ? 'summarize' : result?.assessment ? 'explain' : 'translate';
}

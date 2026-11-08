import type { DigestResult, ExpressionAssessment, SelectionSnapshot } from './core';
export interface ParagraphTranslation { source: string; start: number; end: number; translation: string }
export function selectionParagraphs(selection: SelectionSnapshot): {source: string; start: number; end: number}[] {
  const result: {source: string; start: number; end: number}[] = [];
  let start = 0;
  const add = (end: number) => {
    const source = selection.text.slice(start, end);
    if (source.trim()) result.push({source, start: selection.start + start, end: selection.start + end});
  };
  for (const separator of selection.text.matchAll(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g)) {
    add(separator.index!); start = separator.index! + separator[0].length;
  }
  add(selection.text.length);
  return result;
}
export function isLongSelection(text: string): boolean { return text.trim().length > 400 || /\r?\n\s*\r?\n/.test(text.trim()); }
export function showAssessment(assessment?: ExpressionAssessment): boolean {
  return !!assessment && ['incorrect', 'unnatural', 'uncertain'].includes(assessment.status);
}
export function resultMode(result?: DigestResult): 'translate' | 'explain' | 'summarize' {
  return result?.summary ? 'summarize' : result?.assessment ? 'explain' : 'translate';
}

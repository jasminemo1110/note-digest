import { articleBody } from './anchors';
export type SourceLanguage = 'en' | 'ja';
export type Action = 'translate' | 'explain' | 'summarize';
export interface SelectionSnapshot {
  path: string; source: string; text: string; start: number; end: number; context: string;
}
export const ASSESSMENT_LABELS = {
  natural: '自然、规范', informal: '口语或非正式表达', unnatural: '可以理解，但不够自然',
  incorrect: '用词或语法有误', uncertain: '语境不足，无法确定',
} as const;
export interface ExpressionAssessment {
  status: keyof typeof ASSESSMENT_LABELS;
  explanation: string;
  correction: string | null;
}
export interface DigestResult {
  translation: string; meaning?: string; usage?: string; example?: string;
  pronunciation?: string | null; assessment?: ExpressionAssessment;
  summary?: string; paragraphs?: import('./reading-layout').ParagraphTranslation[];
}
export function snapshot(path: string, source: string, text: string, offset?: number): SelectionSnapshot {
  if (!path.endsWith('.md') || !text.trim() || text.length > 12000) throw new Error('请选择 1–12,000 字符的 Markdown 英文内容。');
  const body = articleBody(source);
  const start = offset ?? body.indexOf(text);
  if (!Number.isInteger(start) || start < 0 || body.slice(start, start + text.length) !== text) throw new Error('无法对应原文，请改用编辑模式重新选择。');
  if (offset === undefined && body.indexOf(text, start + 1) !== -1) throw new Error('原文有多处相同文本，请改用编辑模式精确选择。');
  return { path, source, text, start, end: start + text.length,
    context: body.slice(Math.max(0, start - 1200), Math.min(body.length, start + text.length + 1200)) };
}
export function validateResult(value: unknown, action: Action): DigestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 返回格式异常，请重试。');
  if (action === 'summarize') {
    const summary = (value as Record<string, unknown>).summary;
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 6000) throw new Error('AI 摘要字段异常。');
    return {translation: '', summary: summary.trim()};
  }
  const fields = action === 'explain' ? ['translation', 'meaning', 'usage', 'example'] as const : ['translation'] as const;
  const result: Record<string, string> = {};
  for (const key of fields) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field !== 'string' || !field.trim() || field.length > (key === 'translation' ? 24000 : 6000)) throw new Error('AI 返回字段缺失或过长，请重试。');
    result[key] = field.trim();
  }
  const validated: DigestResult = { translation: result.translation, ...result };
  if (action === 'explain') {
    const input = value as Record<string, unknown>;
    const pronunciation = input.pronunciation;
    if (pronunciation !== null && (typeof pronunciation !== 'string' || !pronunciation.trim() || pronunciation.length > 500)) throw new Error('AI 音标字段异常。');
    const assessment = input.assessment;
    if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) throw new Error('AI 表达判断字段异常。');
    const {status, explanation, correction} = assessment as Record<string, unknown>;
    if (typeof status !== 'string' || !Object.hasOwn(ASSESSMENT_LABELS, status) ||
        typeof explanation !== 'string' || !explanation.trim() || explanation.length > 6000 ||
        (correction !== null && (typeof correction !== 'string' || !correction.trim() || correction.length > 6000))) throw new Error('AI 表达判断字段异常。');
    if ((status === 'incorrect' || status === 'unnatural') && correction === null) throw new Error('AI 未提供建议改法。');
    if ((status === 'natural' || status === 'uncertain') && correction !== null) throw new Error('AI 表达判断与改法冲突。');
    validated.pronunciation = typeof pronunciation === 'string' ? pronunciation.trim() : null;
    validated.assessment = { status: status as ExpressionAssessment['status'], explanation: explanation.trim(),
      correction: typeof correction === 'string' ? correction.trim() : null };
  }
  return validated;
}
export function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~=-])/g, '\\$1');
}

/** Accept one unescaped emphasis span, with no other emphasis markers or selection across a delimiter. */
function allowsSimpleEmphasis(line: string, start: number, end: number): boolean {
  if (line.includes('\\')) return false;
  const span = /(?<![^\s\p{P}])([*_])([^*_\s](?:[^*_]*[^*_\s])?)\1(?=$|[\s\p{P}])/u.exec(line);
  if (!span) return false;
  const open = span.index;
  const close = open + span[0].length - 1;
  return !/[*_]/.test(line.slice(0, open) + line.slice(close + 1)) &&
    (end <= open || (start > open && end <= close) || start > close);
}

export function insertTranslation(current: string, selection: SelectionSnapshot, translation: string, mode: 'below' | 'inline'): string {
  return translationInsertion(current, selection, translation, mode).after;
}

export interface InsertionReceipt { path: string; before: string; after: string; offset: number; length: number }
/** A receipt describes only the exact insertion that passed the atomic source check. */
export function translationInsertion(current: string, selection: SelectionSnapshot, translation: string, mode: 'below'|'inline'): InsertionReceipt {
  if (current !== selection.source) throw new Error('原文已修改，请重新选择并生成，避免插错位置。');
  if (selection.end !== selection.start + selection.text.length || current.slice(selection.start, selection.end) !== selection.text) {
    throw new Error('选区与原文不一致，请重新选择。');
  }
  if (!translation.trim() || translation.length > 24000) throw new Error('译文为空或过长。');
  const prefix = current.slice(0, selection.start);
  const lineStart = prefix.lastIndexOf('\n') + 1;
  const lineEndIndex = current.indexOf('\n', selection.end);
  const hasCRLF = lineEndIndex < 0 ? current.includes('\r\n') : current[lineEndIndex - 1] === '\r';
  const newline = hasCRLF ? '\r\n' : '\n';
  const lineEnd = lineEndIndex < 0 ? current.length : lineEndIndex - (hasCRLF ? 1 : 0);
  const line = current.slice(lineStart, lineEnd);
  const previousLine = current.slice(0, lineStart).split('\n').slice(-2, -1)[0] ?? '';
  const nextLine = lineEndIndex < 0 ? '' : current.slice(lineEndIndex + 1).split('\n')[0];
  const isStandalone = !previousLine.trim() && !nextLine.trim();
  if (/[\r\n]/.test(selection.text) || /^[ \t]*\t|^ {4}|^\s*(?:[#>|`~]|[-+*]\s|\d+[.)]\s)/.test(line) ||
      /[\[\]`<>|]/.test(line) || (/[*_]/.test(line) && (!isStandalone || !allowsSimpleEmphasis(line, selection.start - lineStart, selection.end - lineStart))) ||
      (prefix.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 || (current.startsWith('---') && prefix.split(/^---\s*$/m).length < 3)) {
    throw new Error('此处含复杂 Markdown 或选区跨行。目前支持单行正文与简单斜体内的选区。');
  }
  if (mode === 'below' && !isStandalone) throw new Error('下方插入需要由空行或文档边界分隔的单行段落。');
  const safe = escapeMarkdown(translation.trim()).replace(/\r\n|\r|\n/g, newline);
  const offset = mode === 'inline' ? selection.end : lineEnd;
  let insertion: string;
  if (mode === 'inline') {
    if (/\r|\n/.test(translation)) throw new Error('多行译文请使用下方插入。');
    insertion = '（' + safe + '）';
    if (current.startsWith(insertion, offset)) throw new Error('原文已包含这段括号译文。');
  } else {
    insertion = newline + newline + safe;
    const following = current[offset + insertion.length];
    if (current.startsWith(insertion, offset) && (!following || /[\r\n]/.test(following))) throw new Error('原文下方已包含这段译文。');
  }
  const after = current.slice(0, offset) + insertion + current.slice(offset);
  return {path: selection.path, before: current, after, offset, length: insertion.length};
}
/** Keep English and AI context immutable; update only the confirmed source and offsets. */
export function rebaseSelectionAfterInsertion(selection: SelectionSnapshot, receipt: InsertionReceipt): SelectionSnapshot | null {
  if (receipt.path!==selection.path || receipt.before!==selection.source || receipt.length<=0 ||
      receipt.after.length!==receipt.before.length+receipt.length ||
      receipt.after.slice(0,receipt.offset)!==receipt.before.slice(0,receipt.offset) ||
      receipt.after.slice(receipt.offset+receipt.length)!==receipt.before.slice(receipt.offset)) return null;
  if (receipt.offset>selection.start && receipt.offset<selection.end) return null;
  const shift=receipt.offset<=selection.start?receipt.length:0;
  const start=selection.start+shift,end=selection.end+shift;
  if (receipt.after.slice(start,end)!==selection.text) return null;
  return {...selection,source:receipt.after,start,end};
}

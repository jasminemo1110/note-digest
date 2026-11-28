import { articleBody, articleStart } from './anchors';
import { insertionTarget, markdownBody, markdownStructure, mapReadingRange, tableCellSourceRange, type RenderedSection, type TableCellPosition } from './markdown-source';
import { fromMarkdown } from 'mdast-util-from-markdown';
export type SourceLanguage = 'en' | 'ja';
export type Action = 'translate' | 'explain' | 'summarize';
export interface SelectionSnapshot {
  path: string; source: string; text: string; start: number; end: number; context: string; readOnly?: true;
  contextOffset?: number;
  originalSelection?: SelectionSnapshot;
}
export interface SidebarSelection {
  sidebar: true; text: string; context: string; contextOffset: number;
  originalSelection?: SidebarSelection;
}
export type DigestSelection = SelectionSnapshot | SidebarSelection;
export type ContextSelection = Pick<DigestSelection, 'text' | 'context' | 'contextOffset'>;
export const ASSESSMENT_LABELS = {
  natural: '自然、规范', informal: '口语或非正式表达', unnatural: '可以理解，但不够自然',
  incorrect: '用词或语法有误', uncertain: '语境不足，无法确定',
} as const;
export interface ExpressionAssessment {
  status: keyof typeof ASSESSMENT_LABELS;
  explanation: string;
  correction: string | null;
}
export const MAX_COMMON_USAGES = 3;
export const MAX_WORD_FAMILY = 4;
export const MAX_DICTIONARY_SENSES = 4;
export interface CommonUsage {
  partOfSpeech: string;
  meaning: string;
  example: string;
}
export interface WordFamilyEntry { word: string; partOfSpeech: string; meaning: string; pronunciation?: string | null }
export interface DictionarySense { partOfSpeech: string; meaning: string; pronunciation: string | null }
export interface ContextExpression { title: string; meaning: string; sourceText: string }
export interface DigestResult {
  translation: string; meaning?: string; usage?: string; example?: string;
  headword?: string | null;
  commonUsages?: CommonUsage[];
  wordFamily?: WordFamilyEntry[];
  dictionarySenses?: DictionarySense[];
  contextExpression?: ContextExpression;
  pronunciation?: string | null; assessment?: ExpressionAssessment;
  wordPronunciation?: {uk: string; us: string} | null;
  summary?: string; paragraphs?: import('./reading-layout').ParagraphTranslation[];
}

export function isEnglishWord(text: string): boolean {
  return /^\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*$/u.test(text.trim().normalize('NFC'));
}

export function isExpressionTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 &&
    !/[\p{C}\p{Zl}\p{Zp}]/u.test(value) && /\p{Script=Latin}.*\s.*\p{Script=Latin}/u.test(value.trim());
}

export function isWordFamilyPronunciation(value: string): boolean {
  return value.length <= 140 && /^(?:(?:英 |美 )?\/[^/\s\p{C}]+\/)(?:；美 \/[^/\s\p{C}]+\/)?$/u.test(value);
}

function validateUsageText(value: unknown, maxLength: number, label = '常见用法'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\r\n\0]/.test(value)) {
    throw new Error(`AI ${label}字段异常。`);
  }
  return value.trim();
}
export function snapshot(path: string, source: string, text: string, offset?: number): SelectionSnapshot {
  if (!path.endsWith('.md') || !text.trim() || text.length > 12000) throw new Error('请选择 1–12,000 字符的 Markdown 英文内容。');
  const body = articleBody(source);
  const start = offset ?? body.indexOf(text);
  if (!Number.isInteger(start) || start < 0 || body.slice(start, start + text.length) !== text) throw new Error('无法对应原文，请改用编辑模式重新选择。');
  if (offset === undefined && body.indexOf(text, start + 1) !== -1) throw new Error('原文有多处相同文本，请改用编辑模式精确选择。');
  const end = start + text.length;
  const cell = tableCellSourceRange(source, {start, end});
  const proseStart = articleStart(source);
  const contextStart = Math.max(cell?.start ?? (start >= proseStart ? proseStart : 0), start - 1200);
  const context = body.slice(contextStart, Math.min(cell?.end ?? body.length, end + 1200));
  const offsetInContext = start - contextStart;
  const repeated = context.indexOf(text) !== offsetInContext || context.indexOf(text, offsetInContext + 1) >= 0;
  return {path, source, text, start, end, context, contextOffset: cell || repeated ? offsetInContext : undefined};
}
export function readingSnapshot(path: string, source: string, text: string,
  rendered?: {section?: RenderedSection; paragraph: string; offset: number; cell?: TableCellPosition; tag?: string},
  visibleContext?: {text: string; offset: number}, forLookup = false): SelectionSnapshot {
  if (!path.endsWith('.md') || !text.trim() || text.length > 12000) throw new Error('请选择 1–12,000 字符的 Markdown 英文内容。');
  const mapped = rendered && mapReadingRange(source, rendered.section, rendered.paragraph, rendered.offset, text, rendered.cell, rendered.tag);
  const body = articleBody(source);
  const selection: SelectionSnapshot = mapped && mapped.end <= body.length
    ? {path, source, text, ...mapped, context: visibleContext?.text ?? body.slice(Math.max(0, mapped.start - 1200), mapped.end + 1200),
      contextOffset: visibleContext?.offset}
    : {path, source, text, start: -1, end: -1, context: visibleContext?.text ?? text,
      contextOffset: visibleContext?.offset ?? 0, readOnly: true};
  if (!forLookup) return selection;
  return normalizeWordLookup(selection, rendered && ((shift, word) =>
    mapReadingRange(source, rendered.section, rendered.paragraph, rendered.offset + shift, word, rendered.cell, rendered.tag)));
}

export function canCollectSelection(selection: SelectionSnapshot): boolean {
  return !selection.readOnly && selection.start >= 0 && selection.end === selection.start + selection.text.length &&
    articleBody(selection.source).slice(selection.start, selection.end) === selection.text;
}

export function selectedContext({text, context, contextOffset}: ContextSelection, singleSentence = false) {
  const offset = contextOffset ?? context.indexOf(text);
  if (offset < 0 || context.slice(offset, offset + text.length) !== text ||
      (contextOffset === undefined && offset !== context.lastIndexOf(text))) return;
  const sentences = new Intl.Segmenter('en', {granularity:'sentence'}).segment(context);
  const first = sentences.containing(offset);
  const last = sentences.containing(offset + text.length - 1);
  if (!first || !last || (singleSentence && first.index !== last.index) ||
      last.index + last.segment.length - first.index > 500) return;
  return {
    before: context.slice(first.index, offset).trimStart(),
    after: context.slice(offset + text.length, last.index + last.segment.length).trimEnd(),
  };
}

/** Locate the unique quoted span that contains the selected occurrence. */
export function locateContextExpression(selection: ContextSelection, sourceText: string) {
  const focus = selectedContext(selection, true);
  if (!focus || sourceText.length < selection.text.length) return;
  const sentence = focus.before + selection.text + focus.after;
  const offset = focus.before.length;
  const start = sentence.indexOf(sourceText, Math.max(0, offset + selection.text.length - sourceText.length));
  if (start < 0 || start > offset) return;
  const next = sentence.indexOf(sourceText, start + 1);
  if (next >= 0 && next <= offset) return;
  const end = start + sourceText.length;
  const wordCharacter = /[\p{L}\p{M}\p{N}]/u;
  if ((wordCharacter.test(sentence[start - 1] ?? '') && wordCharacter.test(sentence[start])) ||
      (wordCharacter.test(sentence[end] ?? '') && wordCharacter.test(sentence[end - 1]))) return;
  return {context:sentence, offset:start, shift:start - offset};
}

export function contextExpressionSelection(selection: SelectionSnapshot, sourceText: string): SelectionSnapshot | undefined {
  if (!canCollectSelection(selection)) return;
  const match = locateContextExpression(selection, sourceText);
  if (!match) return;
  const start = selection.start + match.shift;
  const end = start + sourceText.length;
  const expanded = {...selection, start, end, text:sourceText, context:match.context,
    contextOffset:match.offset, originalSelection:undefined};
  if (canCollectSelection(expanded)) return expanded;
}

type LocateWord = (shift: number, word: string) => {start: number; end: number} | undefined;

export function normalizeWordLookup(selection: SelectionSnapshot, locate?: LocateWord): SelectionSnapshot;
export function normalizeWordLookup(selection: DigestSelection): DigestSelection;
export function normalizeWordLookup(selection: DigestSelection, locate?: LocateWord): DigestSelection {
  const {text, contextOffset} = selection;
  if (selection.originalSelection || !/\p{Script=Latin}/u.test(text) || /[\r\n]/.test(text)) return selection;
  const context = selection.context || text;
  const offset = contextOffset ?? context.indexOf(text);
  const endOffset = offset + text.length;
  if (offset < 0 || context.slice(offset, endOffset) !== text ||
      (contextOffset === undefined && context.lastIndexOf(text) !== offset)) return selection;

  const words = [...context.matchAll(/\p{Script=Latin}\p{M}*(?:['’-]?\p{Script=Latin}\p{M}*)*/gu)]
    .filter(word => word.index < endOffset && word.index + word[0].length > offset);
  const [first, second] = words;
  if (!first || words.length > 2) return selection;
  const firstEnd = first.index + first[0].length;
  const from = Math.max(first.index, offset);
  const to = Math.min(firstEnd, endOffset);
  // A hyphen or apostrophe outside the selection does not pull in another part of the word.
  const wordStart = from - (/[^'’-]*$/.exec(context.slice(first.index, from))?.[0].length ?? 0);
  const wordEnd = to + (/^[^'’-]*/.exec(context.slice(to, firstEnd))?.[0].length ?? 0);
  const word = context.slice(wordStart, wordEnd);
  const edge = /^[\p{Zs}\t\p{P}]*$/u;
  if (word === text || word.length > 12000 || !isEnglishWord(word) || !edge.test(context.slice(offset, wordStart))) return selection;
  if (second) {
    const separator = context.slice(wordEnd, second.index);
    const clipped = context.slice(second.index, endOffset);
    if (!edge.test(separator) || clipped === second[0]) return selection;
    if (/\p{P}/u.test(separator)) {
      if (!/^\p{Script=Latin}$/u.test(clipped)) return selection;
    } else if (offset > first.index || !/^\p{Script=Latin}{1,2}$/u.test(clipped) ||
        !/^\p{Script=Latin}{4}/u.test(second[0])) {
      // Across spaces, require a whole first word and leave short particles such as “off” alone.
      return selection;
    }
  } else if (!edge.test(context.slice(wordEnd, endOffset))) return selection;

  if ('sidebar' in selection) return {...selection, text: word, context, contextOffset: wordStart, originalSelection: selection};

  const shift = wordStart - offset;
  const start = selection.start + shift;
  const end = start + word.length;
  const body = articleBody(selection.source);
  const range = canCollectSelection(selection) && start >= 0 && body.slice(start, end) === word
    ? {start, end} : locate?.(shift, word);
  const corrected = {...selection, text: word, context, originalSelection: selection,
    contextOffset: contextOffset !== undefined || context.indexOf(word) !== context.lastIndexOf(word) ? wordStart : undefined};
  if (range && body.slice(range.start, range.end) === word) return {...corrected, ...range, readOnly: undefined};
  return {...corrected, start: -1, end: -1, readOnly: true};
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
    // Optional for collections generated before normalized headwords were introduced.
    if (input.headword !== undefined) {
      if (input.headword !== null && (typeof input.headword !== 'string' || !input.headword.trim() ||
          input.headword.length > 200 || /[\r\n\0]/.test(input.headword))) throw new Error('AI 词头字段异常。');
      validated.headword = typeof input.headword === 'string' ? input.headword.trim() : null;
    }
    // Older saved cards do not have supplementary usages.
    if (input.commonUsages !== undefined) {
      if (!Array.isArray(input.commonUsages) || input.commonUsages.length > MAX_COMMON_USAGES) {
        throw new Error('AI 常见用法列表异常。');
      }
      validated.commonUsages = input.commonUsages.map((usage: unknown) => {
        if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('AI 常见用法字段异常。');
        const {partOfSpeech, meaning, example} = usage as Record<string, unknown>;
        return {
          partOfSpeech: validateUsageText(partOfSpeech, 30),
          meaning: validateUsageText(meaning, 160),
          example: validateUsageText(example, 300),
        };
      });
    }
    if (input.wordFamily !== undefined) {
      if (!Array.isArray(input.wordFamily) || input.wordFamily.length > MAX_WORD_FAMILY) throw new Error('AI 同族词列表异常。');
      const seen = new Set([validated.headword?.toLowerCase()]);
      validated.wordFamily = [];
      for (const entry of input.wordFamily) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('AI 同族词字段异常。');
        const word = validateUsageText(entry.word, 80, '同族词');
        if (!isEnglishWord(word)) throw new Error('AI 同族词拼写字段异常。');
        const partOfSpeech = validateUsageText(entry.partOfSpeech, 30, '同族词');
        const meaning = validateUsageText(entry.meaning, 100, '同族词');
        const pronunciation = entry.pronunciation === undefined || entry.pronunciation === null
          ? entry.pronunciation : validateUsageText(entry.pronunciation, 140, '同族词音标');
        if (pronunciation && !isWordFamilyPronunciation(pronunciation)) throw new Error('AI 同族词音标字段异常。');
        const key = word.toLowerCase();
        if (!seen.has(key) && validated.headword !== null) {
          validated.wordFamily.push({word, partOfSpeech, meaning, ...(pronunciation !== undefined && {pronunciation})});
        }
        seen.add(key);
      }
    }
    if (input.dictionarySenses !== undefined) {
      if (!Array.isArray(input.dictionarySenses) || input.dictionarySenses.length > MAX_DICTIONARY_SENSES) {
        throw new Error('AI 词汇表常用义列表异常。');
      }
      const senses = input.dictionarySenses.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('AI 词汇表字段异常。');
        const pronunciation = entry.pronunciation === null ? null : validateUsageText(entry.pronunciation, 140, '词汇表音标');
        if (pronunciation && !/\/[^/\s][^/]*\//.test(pronunciation)) throw new Error('AI 词汇表音标字段异常。');
        return {partOfSpeech:validateUsageText(entry.partOfSpeech, 24, '词汇表词性'),
          meaning:validateUsageText(entry.meaning, 90, '词汇表常用义'), pronunciation};
      });
      validated.dictionarySenses = validated.headword === null ? [] : senses;
    }
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
/** Display metadata must never replace the original selection or its anchor. */
export function explanationHeadword(text: string, result: DigestResult): string {
  return result.headword ?? text;
}
export function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~=-])/g, '\\$1');
}

export function insertTranslation(current: string, selection: SelectionSnapshot, translation: string, mode: 'below' | 'inline'): string {
  return translationInsertion(current, selection, translation, mode).after;
}

export interface InsertionReceipt { path: string; before: string; after: string; offset: number; length: number }

function hasInlineAnnotation(source: string, offset: number, annotation: string): boolean {
  let depth = 0;
  for (let cursor = offset; source[cursor] && !/[\r\n]/.test(source[cursor]); cursor++) {
    if (depth === 0) {
      if (source[cursor] !== '（') break;
      if (source.startsWith(annotation, cursor)) return true;
    }
    if (source[cursor] === '（') depth++;
    if (source[cursor] === '）') depth--;
  }
  return false;
}

/** A receipt describes only the exact insertion that passed the atomic source check. */
export function translationInsertion(current: string, selection: SelectionSnapshot, translation: string, mode: 'below'|'inline'): InsertionReceipt {
  if (current !== selection.source) throw new Error('原文已修改，请重新选择并生成，避免插错位置。');
  if (selection.readOnly || !Number.isInteger(selection.start) || !Number.isInteger(selection.end) ||
      selection.start < 0 || selection.end <= selection.start || selection.end > articleBody(current).length) {
    throw new Error('无法确认选区在原文中的位置。');
  }
  if (!translation.trim() || translation.length > 24000) throw new Error('译文为空或过长。');
  const target = insertionTarget(current, selection, mode);
  if (!target) throw new Error('此选区含复杂 Markdown 或跨越了格式边界，无法安全插入。');
  const {offset, tree, index} = target;
  const newline = /\r\n|\n/.exec(current.slice(offset))?.[0] ?? /\r\n|\n/.exec(current)?.[0] ?? '\n';
  const plain = translation.trim().replace(/\r\n|\r|\n/g, newline);
  const safe = escapeMarkdown(plain).replace(/[%$^:]/g, char => '&#' + char.charCodeAt(0) + ';');
  let insertion: string;
  if (mode === 'inline') {
    if (/[\r\n]/.test(plain)) throw new Error('多行内容无法加到同一对括号里。');
    insertion = '（' + safe.replace(/\\\|/g, '&#124;') + '）';
    if (hasInlineAnnotation(current, offset, insertion)) throw new Error('原文已包含这条括号标注。');
    if (!('apply' in target)) throw new Error('无法安全插入括号译文。');
    target.apply('（' + plain + '）');
  } else {
    const prefix = newline + newline + safe;
    const following = current[offset + prefix.length];
    if (current.startsWith(prefix, offset) && (!following || /[\r\n]/.test(following))) throw new Error('原文下方已包含这段译文。');
    const tail = current.slice(offset);
    const needsBoundary = /^\r?\n(?=[^\r\n]*\S)/.test(tail) && !/^\r?\n[ \t]*\r?\n/.test(tail);
    insertion = prefix + (needsBoundary ? newline : '');
    const translated = fromMarkdown(safe).children;
    if (!translated.every(node => node.type === 'paragraph' && node.children.every(child => child.type === 'text' || child.type === 'break'))) {
      throw new Error('译文无法作为普通段落插入。');
    }
    tree.children.splice(index + 1, 0, ...translated);
  }
  const after = current.slice(0, offset) + insertion + current.slice(offset);
  if (markdownStructure(markdownBody(after)) !== markdownStructure(tree)) throw new Error('插入会改变原文的 Markdown 结构。');
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
  if (receipt.after.slice(start,end)!==selection.source.slice(selection.start,selection.end)) return null;
  const original = selection.originalSelection;
  return {...selection,source:receipt.after,start,end,
    ...(original && {originalSelection: rebaseSelectionAfterInsertion(original, receipt) ?? original})};
}

export function wordAnnotationRemoval(current: string, original: SelectionSnapshot, removed: InsertionReceipt,
  kept?: {text: string; receipt: InsertionReceipt}) {
  const following = kept?.receipt.before === removed.after ? kept.receipt : undefined;
  if (current !== (following ?? removed).after) throw new Error('原文已修改，请重新选择。');

  // If the later annotation stays, validate its Markdown on its own.
  const remaining = following && kept ? translationInsertion(original.source, original, kept.text, 'inline') : kept?.receipt;
  const selection = remaining ? rebaseSelectionAfterInsertion(original, remaining) : original;
  // A second annotation is inserted at the same boundary, before the first one.
  const offset = removed.offset + (following?.length ?? 0);
  const end = offset + removed.length;
  if (!selection || current.slice(offset, end) !== removed.after.slice(removed.offset, removed.offset + removed.length) ||
      current.slice(0, offset) + current.slice(end) !== selection.source) {
    throw new Error('无法确认括号标注的位置，撤销未执行。');
  }
  return {after: selection.source, selection, remaining};
}

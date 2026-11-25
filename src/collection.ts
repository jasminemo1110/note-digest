import { explanationHeadword, canCollectSelection, ASSESSMENT_LABELS, escapeMarkdown, isEnglishWord, isExpressionTitle, validateResult, type DigestResult, type SelectionSnapshot, type SidebarSelection } from './core';
import { showAssessment } from './reading-layout';
import { mergeCardBody } from './card-update';
import { shortContext } from './reading-actions';
import { articleBody, digestText, LEARNING_BOUNDARY, LEARNING_HEADING, locateAnchor, makeAnchor, normalizeCollectionRange, type Anchor } from './anchors';
import { addWordVocabulary, EXPRESSION_NOTE_FOLDER, indexWordFamily, markWordNoteCards, WORD_NOTE_FOLDER, wordNoteBody } from './word-vocabulary';

export const COLLECTION_LABELS = {word: '单词', expression: '表达', quote: '金句'} as const;
export type Kind = keyof typeof COLLECTION_LABELS;
export type SaveTarget = 'source' | 'note' | 'both';
export const SIDEBAR_NOTE_PATH = 'Digest/侧栏学习笔记.md';
const SIDEBAR_NOTE_HEADER = '<!-- note-digest:sidebar-words -->';
const WORD_SOURCES_START = '<!-- note-digest:word-sources -->';
const WORD_SOURCES_END = '<!-- note-digest:word-sources-end -->';
export interface SourceDocument { id: string; path: string | null; notePath: string }
export interface SaveUndo { readonly recordId: string; readonly id: string }
interface WordNote { id: string; path: string }
interface SidebarWord { id: string; note: WordNote }
export interface LearningRecord {
  id: string; documentId: string; kind: Kind; anchor: Anchor; context: string;
  originalContext?: string; unlocated?: true;
  result: DigestResult; createdAt: string; active: boolean; savedTo: string[]; deletionPending?: boolean; pendingExplanation?: {result: DigestResult; copies: {path: string; before: string; after: string}[]};
  pendingUndo?: {id: string; paths: string[]};
  wordNote?: WordNote;
}
type LearningCard = Pick<LearningRecord, 'id' | 'kind' | 'anchor' | 'result' | 'originalContext'>;
export interface CollectionData { version: 1; secretName: string; documents: SourceDocument[]; records: LearningRecord[]; sidebarWords?: SidebarWord[] }
export interface StoragePort {
  read(path: string): Promise<string | null>;
  /** Must synchronously transform current content, or exclusively create when absent. */
  update(path: string, transform: (current: string | null) => string): Promise<void>;
  persist(data: CollectionData): Promise<void>;
}
export interface SaveReport { record: LearningRecord; targets: { path: string; ok: boolean; message: string }[]; undo?: SaveUndo }
interface RemovalReport { targets: SaveReport['targets']; complete: boolean }
export function collectionFeedback(report: SaveReport): {text: string; duplicate: boolean} {
  const failed = report.targets.filter(target => !target.ok);
  const saved = report.targets.some(target => target.ok && target.message === '已保存');
  if (failed.length) {
    const details = failed.map(target => `未完成 ${target.path}：${target.message}`);
    if (failed.length < report.targets.length) details.unshift(saved ? '已保存到部分位置' : '部分位置已有收藏');
    return {text: details.join('\n'), duplicate: false};
  }
  if (report.record.unlocated && saved) return {text: '已保存到独立学习笔记', duplicate: false};
  if (saved) return {text: '已保存', duplicate: false};
  const kind = report.record.kind;
  return {text: kind === 'word' ? '本词已收藏' : `此${COLLECTION_LABELS[kind]}已收藏`, duplicate: true};
}
const ID = /^[a-zA-Z0-9-]{1,80}$/;
const HASH = /^[0-9a-f]{64}$/;
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\r\n\0\\]/.test(value) &&
    !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.' || !part) && value.endsWith('.md');
}
function validateCardResult(result: DigestResult, kind: Kind): DigestResult {
  const expressionExplanation = kind === 'expression' &&
    (result?.meaning !== undefined || result?.usage !== undefined || result?.example !== undefined);
  const card = validateResult(result, kind === 'word' || expressionExplanation ? 'explain' : 'translate');
  if (kind === 'expression' && !expressionExplanation && isExpressionTitle(result.headword)) {
    card.headword = result.headword.trim();
  }
  return card;
}
/** Fail closed rather than silently replacing damaged or future collections. */
export function loadCollection(input: unknown): CollectionData {
  if (input == null) return { version: 1, secretName: '', documents: [], records: [] };
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('收藏数据损坏，已停止写入。');
  const data = input as Record<string, unknown>;
  if (data.version === undefined && Object.keys(data).every(key => key === 'secretName')) {
    return { version: 1, secretName: typeof data.secretName === 'string' ? data.secretName : '', documents: [], records: [] };
  }
  if (data.version !== 1 || typeof data.secretName !== 'string' || !Array.isArray(data.documents) || !Array.isArray(data.records)) throw new Error('收藏数据版本不支持或结构损坏。');
  const documents = data.documents as SourceDocument[];
  const records = data.records as LearningRecord[];
  const ids = new Set<string>(); const paths = new Set<string>(); const notes = new Set<string>();
  for (const doc of documents) {
    if (!doc || typeof doc.id !== 'string' || !ID.test(doc.id) || ids.has(doc.id) ||
        (doc.path !== null && (!validPath(doc.path) || paths.has(doc.path))) || !validPath(doc.notePath) || notes.has(doc.notePath)) throw new Error('收藏来源数据损坏。');
    ids.add(doc.id); if (doc.path) paths.add(doc.path); notes.add(doc.notePath);
  }
  if (documents.some(doc => doc.path && notes.has(doc.path))) throw new Error('学习笔记与原文路径冲突。');
  const recordIds = new Set<string>();
  const validWordNote = (word: WordNote | undefined) => word && typeof word.id === 'string' && HASH.test(word.id) &&
    validPath(word.path) && !paths.has(word.path) && !notes.has(word.path) && word.path !== SIDEBAR_NOTE_PATH;
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !ID.test(record.id) || recordIds.has(record.id) || !ids.has(record.documentId) ||
        typeof record.kind !== 'string' || !Object.hasOwn(COLLECTION_LABELS, record.kind) || typeof record.active !== 'boolean' || (record.deletionPending !== undefined && typeof record.deletionPending !== 'boolean') || !Array.isArray(record.savedTo) || !record.savedTo.every(validPath) || typeof record.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(record.createdAt) ||
        !record.anchor || typeof record.anchor.block !== 'string' || record.anchor.block.length > 24000 ||
        typeof record.anchor.text !== 'string' || !record.anchor.text.trim() || record.anchor.text.length > 12000 ||
        !Number.isInteger(record.anchor.offset) || record.anchor.offset < 0 ||
        record.anchor.block.slice(record.anchor.offset, record.anchor.offset + record.anchor.text.length) !== record.anchor.text ||
        (record.anchor.excerpt !== undefined && record.anchor.excerpt !== true) ||
        (record.anchor.location !== undefined && (!record.anchor.location || !Number.isSafeInteger(record.anchor.location.start) ||
          record.anchor.location.start < record.anchor.offset || !/^[0-9a-f]{64}$/.test(record.anchor.location.digest))) ||
        (record.originalContext !== undefined && (typeof record.originalContext !== 'string' || record.originalContext.length > 12000)) ||
        (record.unlocated !== undefined && record.unlocated !== true) ||
        typeof record.context !== 'string' || record.context.length > 14400) throw new Error('收藏条目数据损坏。');
    if (record.pendingExplanation !== undefined) {
      const pending = record.pendingExplanation;
      if (record.kind !== 'word' || !pending || !Array.isArray(pending.copies) || !pending.copies.length ||
          pending.copies.some(copy => !copy || !validPath(copy.path) ||
            !/^[0-9a-f]{64}$/.test(copy.before) || !/^[0-9a-f]{64}$/.test(copy.after))) {
        throw new Error('收藏更新数据损坏。');
      }
      pending.result = validateResult(pending.result, 'explain');
    }
    if (record.pendingUndo !== undefined) {
      const pending = record.pendingUndo;
      if (!pending || typeof pending.id !== 'string' || !ID.test(pending.id) || !Array.isArray(pending.paths) ||
          !pending.paths.length || !pending.paths.every(validPath)) throw new Error('收藏撤销数据损坏。');
    }
    if (record.wordNote !== undefined && (record.kind === 'quote' || !validWordNote(record.wordNote))) throw new Error('词条笔记数据损坏。');
    recordIds.add(record.id);
    record.result = validateCardResult(record.result, record.kind);
  }
  const sidebarWords = data.sidebarWords as SidebarWord[] | undefined;
  if (sidebarWords !== undefined && (!Array.isArray(sidebarWords) || sidebarWords.some(card => !card || typeof card.id !== 'string' ||
      !HASH.test(card.id) || recordIds.has(card.id) || !validWordNote(card.note)) || new Set(sidebarWords.map(card => card.id)).size !== sidebarWords.length)) {
    throw new Error('侧栏收藏数据损坏。');
  }
  return structuredClone({version: 1 as const, secretName: data.secretName, documents, records, ...(sidebarWords && {sidebarWords})});
}
const quoted = (value: string) => escapeMarkdown(value).split(/\r?\n/).map(line => '> ' + line).join('\n');
function commonUsagesMarkdown(result: DigestResult): string {
  if (!result.commonUsages?.length) return '';
  const safe = (value: string) => escapeMarkdown(value).replace(/[%$^:]/g, char => `&#${char.charCodeAt(0)};`);
  const items = result.commonUsages.map(({partOfSpeech, meaning, example}) =>
    `- **${safe(partOfSpeech)} · ${safe(meaning)}** — ${safe(example)}`);
  return '\n\n**其他常见用法**\n\n' + items.join('\n');
}
function wordFamilyMarkdown(result: DigestResult): string {
  if (!result.wordFamily?.length) return '';
  const safe = (value: string) => escapeMarkdown(value).replace(/[%$^:]/g, char => `&#${char.charCodeAt(0)};`);
  const words = result.wordFamily.map(({word, pronunciation, partOfSpeech, meaning}) =>
    '- ' + [`**${safe(word)}**`, pronunciation && safe(pronunciation), safe(partOfSpeech), safe(meaning)].filter(Boolean).join(' · '));
  return '\n\n**同族词**\n\n' + words.join('\n');
}
function sourceLink(path: string | null): string {
  return path ? `[返回原文](/${path.split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16))).join('/')})` : '原文已删除或无法定位';
}
function wordNoteHeader(word: WordNote): string { return `<!-- note-digest:word-note:${word.id} -->`; }
function ownedWordNote(content: string, word: WordNote): boolean {
  return wordNoteBody(content).startsWith(wordNoteHeader(word) + '\n');
}
function wordTitle(headword: string): string {
  const title = headword.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return title.replace(/^[\s.,!?;:()“”]+|[\s.,!?;:()“”]+$/g, '') || title;
}
function wordSourceLine(doc: SourceDocument): string {
  const label = doc.path?.split('/').at(-1)?.replace(/\.md$/, '');
  const title = label ? ` · ${escapeMarkdown(label)}` : '';
  return `- ${sourceLink(doc.path)}${title} <!-- note-digest:word-source:${doc.id} -->\n\n`;
}
function addWordSource(current: string, doc: SourceDocument): string {
  const start = current.indexOf(WORD_SOURCES_START);
  const end = current.indexOf(WORD_SOURCES_END);
  if (start < 0 || end < start || current.indexOf(WORD_SOURCES_START, start + 1) >= 0 || current.indexOf(WORD_SOURCES_END, end + 1) >= 0) {
    throw new Error('单词笔记的原文链接区标记已改动。');
  }
  const marker = `<!-- note-digest:word-source:${doc.id} -->`;
  return current.slice(start, end).includes(marker) ? current : current.slice(0, end) + wordSourceLine(doc) + current.slice(end);
}
function ownedIndependentNote(current: string, path: string, record: LearningRecord, doc: SourceDocument): boolean {
  return path === record.wordNote?.path ? ownedWordNote(current, record.wordNote) :
    path === doc.notePath && current.includes(`<!-- note-digest:document:${doc.id} -->`);
}
function legacyRecordMarkdown(record: LearningRecord, doc: SourceDocument): string {
  const result = record.result;
  const headword = record.kind === 'word' ? explanationHeadword(record.anchor.text, result) : record.anchor.text;
  let text = `\n\n<!-- note-digest:record:${record.id} -->\n### ${record.kind === 'word' ? '词语' : '金句'}：${escapeMarkdown(headword).replace(/\r?\n/g, ' ')}\n\n${sourceLink(doc.path)} · ${record.createdAt.slice(0, 10)}\n\n${quoted(record.anchor.text)}\n\n**中文翻译**\n\n${quoted(result.translation)}`;
  if (record.kind === 'word') {
    text += `\n\n**原始语境**\n\n${quoted(record.context)}`;
    for (const [label, value] of [['音标', result.pronunciation ?? '不适用或无法可靠确定'], ['语境含义', result.meaning], ['用法', result.usage], ['例句', result.example]]) {
      if (value) text += `\n\n**${label}**\n\n${quoted(value)}`;
    }
    if (result.assessment) {
      text += `\n\n**表达判断（AI 建议）：${ASSESSMENT_LABELS[result.assessment.status]}**\n\n${quoted(result.assessment.explanation)}`;
      if (result.assessment.correction) text += `\n\n**${result.assessment.status === 'informal' ? '更正式的表达（可选）' : '建议改法'}**\n\n${quoted(result.assessment.correction)}`;
    }
  }
  return text + commonUsagesMarkdown(result) + '\n';
}
function previousRecordMarkdown(record: LearningRecord, _doc: SourceDocument): string {
  const result = record.result;
  const headword = record.kind === 'word' ? explanationHeadword(record.anchor.text, result) : record.anchor.text;
  let text = `\n\n<!-- note-digest:record:${record.id} -->\n### ${record.kind === 'word' ? '词语' : '金句'}：${escapeMarkdown(headword).replace(/\r?\n/g, ' ')}`;
  if (record.kind === 'word') text += `\n\n**音标** ${escapeMarkdown(result.pronunciation ?? '不适用或无法可靠确定')}`;
  text += `\n\n${quoted(result.translation)}`;
  if (record.kind === 'word') {
    if (headword !== record.anchor.text) text += `\n\n**原文词形** ${escapeMarkdown(record.anchor.text)}`;
    text += `\n\n**原始语境**\n\n${quoted(shortContext(record.anchor))}`;
    for (const [label, value] of [['语境含义', result.meaning], ['用法', result.usage], ['例句', result.example]]) {
      if (value) text += `\n\n**${label}**\n\n${quoted(value)}`;
    }
    if (result.assessment) {
      text += `\n\n**表达判断（AI 建议）：${ASSESSMENT_LABELS[result.assessment.status]}**\n\n${quoted(result.assessment.explanation)}`;
      if (result.assessment.correction) text += `\n\n**${result.assessment.status === 'informal' ? '更正式的表达（可选）' : '建议改法'}**\n\n${quoted(result.assessment.correction)}`;
    }
  }
  return text + commonUsagesMarkdown(result) + '\n';
}
export function learningCardTitle(record: Pick<LearningCard, 'kind' | 'anchor' | 'result'>): string {
  const {kind, anchor, result} = record;
  if (kind === 'word') return explanationHeadword(anchor.text, result);
  if (kind === 'expression' && result.headword && !isEnglishWord(result.headword)) return result.headword;
  return anchor.text;
}
function groupedRecordMarkdown(record: LearningCard, historicalWordPrefix = false, context?: string): string {
  const result = record.result;
  const prefix = record.kind === 'quote' ? '金句：' : historicalWordPrefix && record.kind === 'word' ? '词语：' : '';
  const headword = learningCardTitle(record);
  let text = `\n\n<!-- note-digest:record:${record.id} -->\n#### ${prefix}${escapeMarkdown(headword).replace(/\r?\n/g, ' ')}`;
  if (record.kind === 'word' || (record.kind === 'expression' && result.pronunciation)) {
    text += `\n\n**音标** ${escapeMarkdown(result.pronunciation ?? '不适用或无法可靠确定')}`;
  }
  text += `\n\n${quoted(result.translation)}`;
  if (record.kind !== 'quote') {
    if (headword !== record.anchor.text) text += `\n\n**原文词形** ${escapeMarkdown(record.anchor.text)}`;
    text += `\n\n**原始语境**\n\n${quoted(context ?? record.originalContext ?? shortContext(record.anchor))}`;
    for (const [label, value] of [['语境含义', result.meaning], ['用法', result.usage], ['例句', result.example]]) {
      if (value) text += `\n\n**${label}**\n\n${quoted(value)}`;
    }
    if (result.assessment && showAssessment(result.assessment)) {
      text += `\n\n**表达判断（AI 建议）：${ASSESSMENT_LABELS[result.assessment.status]}**\n\n${quoted(result.assessment.explanation)}`;
      if (result.assessment.correction) text += `\n\n**${result.assessment.status === 'informal' ? '更正式的表达（可选）' : '建议改法'}**\n\n${quoted(result.assessment.correction)}`;
    }
  }
  return text + commonUsagesMarkdown(result) + wordFamilyMarkdown(result) + '\n';
}
export function recordMarkdown(record: LearningRecord, _doc: SourceDocument): string {
  return markedCardMarkdown(record);
}
function markedCardMarkdown(record: LearningCard, context?: string): string {
  return groupedRecordMarkdown(record, false, context) + `<!-- note-digest:record-end:${record.id} -->\n`;
}
function savedCardRange(current: string, record: LearningRecord, doc: SourceDocument, unchanged = false): {start: number; end: number} | undefined {
  const marker = `<!-- note-digest:record:${record.id} -->`;
  const endMarker = `<!-- note-digest:record-end:${record.id} -->`;
  const start = current.indexOf(marker);
  if (start < 0 && unchanged && current.includes(endMarker)) throw new Error('卡片边界已改动，已保留内容。');
  if (start < 0) return;
  if (current.indexOf(marker, start + marker.length) >= 0) throw new Error('记录标记重复，无法安全确定要删除的卡片。');
  const boundary = current.indexOf(LEARNING_BOUNDARY);
  const ownedNote = current.includes(`<!-- note-digest:document:${doc.id} -->`) ||
    (record.wordNote && ownedWordNote(current, record.wordNote));
  if (!ownedNote && (boundary < 0 || start < boundary + LEARNING_BOUNDARY.length)) throw new Error('卡片不在可确认的学习笔记区域，已保留原文。');
  const end = current.indexOf(endMarker);
  if (end >= 0) {
    if (end < start || current.indexOf(endMarker, end + endMarker.length) >= 0 ||
        /<!-- note-digest:(?:record:|group:|end:)/.test(current.slice(start + marker.length, end))) throw new Error('卡片边界损坏，已保留内容。');
    const finish = end + endMarker.length + (current[end + endMarker.length] === '\n' ? 1 : 0);
    if (unchanged && current.slice(start, finish) !== markedCardMarkdown(record).trimStart()) {
      throw new Error('卡片保存后有改动，已保留内容。');
    }
    return {start, end: finish};
  }
  if (unchanged || record.kind === 'expression') throw new Error('卡片缺少结束标记，已保留内容。');
  // Historical cards have no closing marker. Delete only exact known output, leaving manual additions untouched.
  const candidates = [groupedRecordMarkdown(record,true), groupedRecordMarkdown(record), previousRecordMarkdown(record,doc), legacyRecordMarkdown(record,doc)];
  const oldLink = /^\n### [^\r\n]+\n\n\[返回原文\]\(\/([^\r\n)]+)\) · \d{4}-\d{2}-\d{2}\n/.exec(current.slice(start + marker.length))?.[1];
  if (oldLink) {
    // A renamed or deleted source can leave its original URL in a byte-identical legacy card.
    try {
      const path = decodeURIComponent(oldLink);
      if (validPath(path) && path !== doc.path) candidates.push(legacyRecordMarkdown(record, {...doc, path}));
    } catch { /* A malformed URL cannot identify a generated legacy card. */ }
  }
  for (const candidate of candidates) {
    const index = current.indexOf(candidate);
    if (index >= 0 && index + candidate.indexOf(marker) === start) return {start: index, end: index + candidate.length};
  }
  throw new Error('旧卡片已手工修改且缺少结束标记，无法安全确定删除范围，请手动删除该卡片。');
}
export function removeSavedRecord(current: string, record: LearningRecord, doc: SourceDocument, unchanged = false): {text: string; removed: boolean} {
  const card = savedCardRange(current, record, doc, unchanged);
  return card ? {text: current.slice(0, card.start) + current.slice(card.end), removed: true} : {text: current, removed: false};
}
function updateCard(current: string, record: LearningRecord, doc: SourceDocument, next: LearningRecord): string {
  const marker = `<!-- note-digest:record:${record.id} -->`;
  const endMarker = `<!-- note-digest:record-end:${record.id} -->`;
  const start = current.indexOf(marker);
  const end = current.indexOf(endMarker);
  const boundary = current.indexOf(LEARNING_BOUNDARY);
  const owned = current.includes(`<!-- note-digest:document:${doc.id} -->`) ||
    (record.wordNote && ownedWordNote(current, record.wordNote));
  if (start < 0 || (!owned && (boundary < 0 || start < boundary + LEARNING_BOUNDARY.length))) {
    throw new Error('找不到对应学习卡片。');
  }
  if (current.indexOf(marker, start + marker.length) >= 0 || (end >= 0 &&
      (end < start || current.indexOf(endMarker, end + endMarker.length) >= 0 ||
       /<!-- note-digest:(?:record:|group:|end:)/.test(current.slice(start + marker.length, end))))) {
    throw new Error('卡片标记有歧义，已保留原卡。');
  }
  const variants = (value: LearningRecord) => [
    groupedRecordMarkdown(value), groupedRecordMarkdown(value,true),
    previousRecordMarkdown(value,doc), legacyRecordMarkdown(value,doc),
  ].map(card => card.slice(card.indexOf(marker) + marker.length));
  const replacement = variants(next);
  if (end < 0) {
    const old = variants(record).findIndex(card => current.startsWith(card, start + marker.length));
    if (old >= 0) {
      const offset = start + marker.length;
      return current.slice(0,offset) + replacement[old] + current.slice(offset + variants(record)[old].length);
    }
  } else {
    const offset = start + marker.length;
    const body = current.slice(offset,end);
    const expected = variants(record);
    for (let index = 0; index < expected.length; index++) {
      const merged = mergeCardBody(body,expected[index],replacement[index]);
      if (merged !== undefined) return current.slice(0,offset) + merged + current.slice(end);
    }
  }
  throw new Error('生成内容曾被手工修改，或无法确认备注位置，已保留原卡。');
}

function contextualAnchor(selection: {text: string; context: string; contextOffset?: number}): Anchor {
  const text = selection.text.trim();
  if (!text || selection.text.length > 12000) throw new Error('请选择 1–12,000 字符的英文内容。');
  const offset = selection.contextOffset;
  if (offset === undefined || !Number.isInteger(offset) || offset < 0 || selection.context.length > 14400 ||
      selection.context.slice(offset, offset + selection.text.length) !== selection.text) {
    return {text, block:text, offset:0};
  }
  const start = offset + selection.text.indexOf(text);
  const end = start + text.length;
  const sentences = [...new Intl.Segmenter('en', {granularity:'sentence'}).segment(selection.context)]
    .filter(sentence => sentence.index < end && sentence.index + sentence.segment.length > start);
  if (!sentences.length) return {text, block:text, offset:0};
  const raw = sentences.map(sentence => sentence.segment).join('');
  return {text, block:raw.trim(), offset:start - sentences[0].index - (raw.length - raw.trimStart().length)};
}

async function matchingRecords(data: CollectionData, selection: SelectionSnapshot, kind: Kind, doc: SourceDocument) {
  const body = articleBody(selection.source);
  const range = normalizeCollectionRange(body, selection.start, selection.text, kind === 'word');
  const anchor = makeAnchor(body, range.offset, range.text);
  if (locateAnchor(body, anchor) === null) {
    anchor.location = {start: range.offset, digest: await digestText(body)};
  }
  const matches = data.records.filter(record => {
    if (record.documentId !== doc.id || record.kind !== kind || record.unlocated) return false;
    const previous = record.anchor;
    const position = anchor.location && previous.location?.digest === anchor.location.digest
      ? previous.location.start : locateAnchor(body, previous);
    if (position === null) return false;
    const normalized = normalizeCollectionRange(body, position, previous.text, kind === 'word');
    return normalized.offset === range.offset && normalized.text === range.text;
  });
  return {anchor,matches};
}

function groupTokens(kind: Kind) {
  return {start: `<!-- note-digest:group:${kind} -->`, end: `<!-- note-digest:end:${kind} -->`};
}
function appendGrouped(current: string, record: LearningCard, context?: string): string {
  return appendGroupedCard(current, record.kind, markedCardMarkdown(record, context));
}
function appendGroupedCard(current: string, kind: Kind, card: string): string {
  const {start, end} = groupTokens(kind);
  const startIndex = current.indexOf(start); const endIndex = current.indexOf(end);
  if (startIndex < 0 && endIndex < 0) {
    return current + `\n\n${start}\n### ${COLLECTION_LABELS[kind]}\n` + card + `\n${end}\n`;
  }
  if (startIndex < 0 || endIndex < startIndex || current.indexOf(start, startIndex + 1) >= 0 || current.indexOf(end, endIndex + 1) >= 0) throw new Error('学习分组标记已改动，请先恢复标记或选择另一个保存位置。');
  return current.slice(0, endIndex) + card + '\n' + current.slice(endIndex);
}
function prepareWordNote(current: string | null, word: WordNote, title: string, result?: DigestResult, kind: Kind = 'word'): string {
  const heading = escapeMarkdown(Array.from(title).slice(0, 120).join('')).replace(/[%$^]/g, char => `&#${char.charCodeAt(0)};`);
  const base = current ?? `${wordNoteHeader(word)}\n# ${heading}\n\n${WORD_SOURCES_START}\n\n${WORD_SOURCES_END}\n`;
  if (!ownedWordNote(base, word)) throw new Error('目标笔记已有其他内容，已保留该文件。');
  return markWordNoteCards(addWordVocabulary(base, title, result?.dictionarySenses, result?.pronunciation,
    kind === 'expression' ? result?.translation : undefined), true);
}
function prepareArticleWordNote(current: string | null, record: LearningRecord, doc: SourceDocument): string {
  const title = wordTitle(learningCardTitle(record));
  return addWordSource(prepareWordNote(current, record.wordNote!, title, record.result, record.kind), doc);
}
/** Explicit migration moves only byte-identical generated cards into typed groups. */
export function compactLegacyCards(current: string, records: LearningRecord[], doc: SourceDocument): {text: string; count: number} {
  let text = current; let count = 0;
  for (const record of records) {
    if (record.kind === 'expression') continue;
    if (text.includes(recordMarkdown(record, doc))) continue;
    const closing = `<!-- note-digest:record-end:${record.id} -->\n`;
    const grouped = groupedRecordMarkdown(record, true);
    if (text.includes(closing.trimEnd())) {
      if (text.includes(grouped + closing)) { text = text.replace(grouped + closing, recordMarkdown(record,doc)); count++; }
      continue;
    }
    if (text.includes(grouped)) { text = text.replace(grouped,recordMarkdown(record,doc)); count++; continue; }
    const candidates = [legacyRecordMarkdown(record, doc), previousRecordMarkdown(record, doc)];
    const old = candidates.find(candidate => text.includes(candidate));
    if (old) { text = appendGrouped(text.replace(old, ''), record); count++; }
  }
  return {text, count};
}
function appendRecord(current: string, record: LearningRecord, isSource: boolean): string {
  if (current.includes(`<!-- note-digest:record:${record.id} -->`)) return current;
  if (isSource && !current.includes(LEARNING_BOUNDARY)) current += '\n\n' + LEARNING_HEADING + LEARNING_BOUNDARY;
  return appendGrouped(current, record);
}

/** Serializes collection metadata and writes, including settings and rename events. */
export class CollectionStore {
  private tail: Promise<unknown> = Promise.resolve();
  private recentSave?: {receipt: SaveUndo; paths: string[]; wasActive: boolean};
  constructor(private data: CollectionData, private port: StoragePort, private uuid: () => string = () => crypto.randomUUID()) {}
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.catch(() => undefined); return result;
  }
  private async commit(next: CollectionData): Promise<void> { await this.port.persist(structuredClone(next)); this.data = structuredClone(next); }
  get secretName(): string { return this.data.secretName; }
  recordsFor(path: string, includeInactive = false): LearningRecord[] {
    const doc = this.data.documents.find(doc => doc.path === path);
    return doc ? structuredClone(this.data.records.filter(record => record.documentId === doc.id && (includeInactive
      ? record.savedTo.length > 0 || record.deletionPending || !!record.pendingUndo
      : record.active && record.savedTo.length > 0))) : [];
  }
  notePathFor(path: string): string | undefined { return this.data.documents.find(doc => doc.path === path)?.notePath; }
  isLearningNote(path: string): boolean {
    return path === SIDEBAR_NOTE_PATH || path.startsWith(WORD_NOTE_FOLDER) || path.startsWith(EXPRESSION_NOTE_FOLDER) || this.data.documents.some(doc => doc.notePath === path) ||
      this.data.records.some(record => record.wordNote?.path === path) || !!this.data.sidebarWords?.some(card => card.note.path === path);
  }
  private async planWordNote(data: CollectionData, record: LearningRecord): Promise<WordNote> {
    const kind = record.kind === 'expression' ? 'expression' : 'word';
    return record.wordNote ??= await this.findWordNote(data, wordTitle(learningCardTitle(record)), kind);
  }
  private async findWordNote(data: CollectionData, title: string, kind: Exclude<Kind, 'quote'> = 'word'): Promise<WordNote> {
    const key = title.toLowerCase();
    const id = await digestText(key);
    const known = data.records.find(other => other.kind === kind && other.wordNote?.id === id)?.wordNote ??
      (kind === 'word' ? data.sidebarWords?.find(card => card.note.id === id)?.note : undefined);
    const name = Array.from(key.replace(/[<>:"/\\|?*\[\]#^\x00-\x1f]/g, '-').replace(/^[. ]+|[. ]+$/g, '')).slice(0, 40).join('') || 'word';
    const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
    const fileName = name === key && !reserved ? name : `${name.replaceAll('.', '-')}--${id.slice(0, 16)}`;
    const folder = kind === 'word' ? WORD_NOTE_FOLDER : EXPRESSION_NOTE_FOLDER;
    return known ?? {id, path: `${folder}${fileName}.md`};
  }
  private indexFamily(note: string, previous: string | null): Promise<string> {
    return indexWordFamily(note, previous, async word => (await this.findWordNote(this.data, wordTitle(word))).path);
  }
  private async updateWordNote(path: string, transform: (current: string | null) => string): Promise<void> {
    const before = await this.port.read(path);
    const after = await this.indexFamily(transform(before), before);
    await this.port.update(path, current => {
      if (current !== before) throw new Error('单词笔记刚刚有改动，请重试。');
      return after;
    });
  }
  indexExistingWordFamilies(paths: string[]): Promise<{updated: number; failed: string[]}> {
    return this.queue(async () => {
      let updated = 0;
      const failed: string[] = [];
      for (const path of new Set(paths.filter(path => path.startsWith(WORD_NOTE_FOLDER)))) {
        try {
          if (this.data.records.some(record => record.pendingExplanation?.copies.some(copy => copy.path === path))) {
            failed.push(path);
            continue;
          }
          const before = await this.port.read(path);
          if (before === null) continue;
          const after = await this.indexFamily(before, before);
          if (after === before) continue;
          await this.port.update(path, current => {
            if (current !== before) throw new Error('单词笔记刚刚有改动，请重试。');
            return after;
          });
          updated++;
        } catch { failed.push(path); }
      }
      return {updated, failed};
    });
  }
  private async writeSidebarCard(id: string, title: string, card: string, result?: DigestResult): Promise<{path: string; duplicate: boolean}> {
    const next = structuredClone(this.data);
    const existing = next.sidebarWords?.find(entry => entry.id === id);
    const note = existing?.note ?? await this.findWordNote(next, title);
    if (!existing) {
      (next.sidebarWords ??= []).push({id, note});
      await this.commit(next);
    }
    const marker = `<!-- note-digest:record:${id} -->`;
    let duplicate = false;
    await this.updateWordNote(note.path, current => {
      const base = prepareWordNote(current, note, title, result);
      duplicate = base.includes(marker);
      if (!duplicate) return appendGroupedCard(base, 'word', '\n\n' + card);
      if (!result && (!base.includes(card) || base.indexOf(marker) !== base.lastIndexOf(marker))) {
        throw new Error('新笔记中已有不同版本的卡片，已保留旧笔记。');
      }
      return base;
    });
    return {path:note.path, duplicate};
  }
  saveSidebarWord(selection: SidebarSelection, input: DigestResult): Promise<{text: string; duplicate: boolean; path: string}> {
    return this.queue(async () => {
      const result = validateResult(input, 'explain');
      const anchor = contextualAnchor(selection);
      const key = JSON.stringify([anchor.text, anchor.block].map(value => value.replace(/\s+/g, ' ')));
      const id = await digestText(key);
      const title = wordTitle(explanationHeadword(anchor.text, result));
      const card = markedCardMarkdown({id, kind:'word', anchor, result}, anchor.block).trimStart();
      const saved = await this.writeSidebarCard(id, title, card, result);
      return {...saved, text:saved.duplicate ? '本词已收藏' : '已收藏到单词笔记'};
    });
  }
  copyLegacySidebarWords(): Promise<{paths: string[]; sourceDigest: string; cards: number; onlyCards: boolean} | undefined> {
    return this.queue(async () => {
      const current = await this.port.read(SIDEBAR_NOTE_PATH);
      if (current === null) return;
      if (!current.startsWith(SIDEBAR_NOTE_HEADER + '\n') && !current.startsWith(SIDEBAR_NOTE_HEADER + '\r\n')) {
        throw new Error('无法确认旧侧栏学习笔记的归属。');
      }
      const pattern = /^<!-- note-digest:record:([0-9a-f]{64}) -->\r?\n#### ([^\r\n]+)\r?\n[\s\S]*?^<!-- note-digest:record-end:\1 -->(?:\r?\n|$)/gm;
      const cards = [...current.matchAll(pattern)];
      const remainder = current.replace(pattern, '');
      if (/<!-- note-digest:record(?:-end)?:/.test(remainder) || new Set(cards.map(card => card[1])).size !== cards.length ||
          cards.some(([card]) => (card.match(/<!-- note-digest:record(?:-end)?:/g) ?? []).length !== 2)) {
        throw new Error('旧侧栏卡片边界不完整，已保留旧笔记。');
      }
      const paths = [];
      for (const [card, id, headword] of cards) {
        const title = wordTitle(headword.replace(/\\([!-/:-@\[-`{-~])/g, '$1'));
        if (!title) throw new Error('旧侧栏卡片缺少可用词头，已保留旧笔记。');
        const saved = await this.writeSidebarCard(id, title, card.endsWith('\n') ? card : card + '\n');
        paths.push(saved.path);
      }
      const group = groupTokens('word');
      const shell = remainder.split(/\r?\n/).filter(line => line.trim()).join('\n');
      const header = `${SIDEBAR_NOTE_HEADER}\n# 侧栏学习笔记`;
      return {paths:[...new Set(paths)], sourceDigest:await digestText(current), cards:cards.length,
        onlyCards:shell === header || shell === `${header}\n${group.start}\n### 单词\n${group.end}`};
    });
  }
  setSecretName(name: string): Promise<void> { return this.queue(() => this.commit({...this.data, secretName: name})); }
  rename(oldPath: string, newPath: string | null): Promise<void> {
    return this.queue(async () => {
      const next = structuredClone(this.data);
      const movePath = (path: string) => newPath !== null && (path === oldPath || path.startsWith(oldPath + '/'))
        ? newPath + path.slice(oldPath.length) : path;
      for (const doc of next.documents) {
        if (doc.path === oldPath || doc.path?.startsWith(oldPath + '/')) doc.path = newPath === null ? null : newPath + doc.path.slice(oldPath.length);
        if (newPath !== null && (doc.notePath === oldPath || doc.notePath.startsWith(oldPath + '/'))) doc.notePath = newPath + doc.notePath.slice(oldPath.length);
      }
      for (const record of next.records) {
        record.savedTo = record.savedTo.map(movePath);
        if (record.pendingUndo) record.pendingUndo.paths = record.pendingUndo.paths.map(movePath);
        if (record.wordNote) record.wordNote = {...record.wordNote, path: movePath(record.wordNote.path)};
      }
      for (const card of next.sidebarWords ?? []) card.note = {...card.note, path:movePath(card.note.path)};
      if (newPath !== null) for (const record of next.records) {
        for (const copy of record.pendingExplanation?.copies ?? []) {
          if (copy.path === oldPath || copy.path.startsWith(oldPath + '/')) copy.path = newPath + copy.path.slice(oldPath.length);
        }
      }
      await this.commit(next);
      if (this.recentSave) this.recentSave.paths = this.recentSave.paths.map(movePath);
    });
  }
  deactivate(id: string): Promise<void> {
    return this.queue(async () => {
      const next = structuredClone(this.data); const record = next.records.find(record => record.id === id);
      if (record) record.active = false;
      await this.commit(next);
    });
  }
  private async removeCopy(path: string, record: LearningRecord, doc: SourceDocument, unchanged = false): Promise<boolean> {
    if (await this.port.read(path) === null) return false;
    let removed = false;
    const transform = (current: string | null) => {
      if (current === null) throw new Error('文件已移动或删除，请重试。');
      const result = removeSavedRecord(current, record, doc, unchanged);
      removed = result.removed;
      if (removed && path === record.wordNote?.path && ownedIndependentNote(current, path, record, doc)) {
        const hasCards = /^<!-- note-digest:record:[a-zA-Z0-9-]+ -->\r?$/m.test(result.text);
        const sameSource = this.data.records.some(other => other.id !== record.id && other.documentId === doc.id &&
          result.text.includes(`<!-- note-digest:record:${other.id} -->`));
        const link = wordSourceLine(doc);
        const start = result.text.indexOf(WORD_SOURCES_START);
        const end = result.text.indexOf(WORD_SOURCES_END);
        const offset = result.text.indexOf(link, start);
        if (!sameSource && start >= 0 && offset > start && offset + link.length <= end) {
          return markWordNoteCards(result.text.slice(0, offset) + result.text.slice(offset + link.length), hasCards);
        }
        return markWordNoteCards(result.text, hasCards);
      }
      return result.text;
    };
    if (path === record.wordNote?.path) await this.updateWordNote(path, transform);
    else await this.port.update(path, transform);
    return removed;
  }
  undoSave(undo: SaveUndo | string): Promise<RemovalReport | undefined> {
    return this.queue(async () => {
      const next = structuredClone(this.data);
      const record = next.records.find(record => record.id === (typeof undo === 'string' ? undo : undo.recordId));
      if (!record || record.deletionPending || record.pendingExplanation) return;
      let pending = record.pendingUndo;
      if (pending) {
        if (typeof undo !== 'string' && pending.id !== undo.id) return;
      } else {
        const saved = this.recentSave;
        if (typeof undo === 'string' || !saved || saved.receipt !== undo) return;
        pending = {id: undo.id, paths: saved.paths};
        record.pendingUndo = pending;
        record.active = record.active && saved.wasActive && record.savedTo.some(path => !saved.paths.includes(path));
        await this.commit(next);
        this.recentSave = undefined;
      }
      const doc = next.documents.find(doc => doc.id === record.documentId)!;
      const targets: SaveReport['targets'] = [];
      const remaining: string[] = [];
      for (const path of new Set(pending.paths)) {
        try {
          await this.removeCopy(path, record, doc, true);
          record.savedTo = record.savedTo.filter(saved => saved !== path);
          targets.push({path, ok: true, message: '已撤销'});
        } catch (error) {
          remaining.push(path);
          targets.push({path, ok: false, message: error instanceof Error ? error.message : '撤销失败，请重试。'});
        }
      }
      if (remaining.length) record.pendingUndo = {...pending, paths: remaining};
      else delete record.pendingUndo;
      await this.commit(next);
      return {targets, complete: remaining.length === 0};
    });
  }
  removeNotes(id: string): Promise<RemovalReport> {
    return this.queue(async () => {
      const next=structuredClone(this.data);
      const record=next.records.find(record=>record.id===id);
      if (!record) throw new Error('收藏记录不存在。');
      const doc=next.documents.find(doc=>doc.id===record.documentId)!;
      const paths=[...new Set([doc.path,doc.notePath,record.wordNote?.path,...record.savedTo,...(record.pendingUndo?.paths ?? [])].filter((path): path is string=>!!path))];
      record.active=false;record.deletionPending=true;
      delete record.pendingUndo;
      // Durable cancellation and retry identity before modifying either note.
      await this.commit(next);
      if (this.recentSave?.receipt.recordId === id) this.recentSave = undefined;
      const targets: SaveReport['targets']=[];
      for (const path of paths) {
        try {
          const removed = await this.removeCopy(path, record, doc);
          record.savedTo=record.savedTo.filter(saved=>saved!==path);
          await this.commit(next);
          targets.push({path,ok:true,message:removed?'已删除对应学习卡片':'没有对应卡片，无需删除'});
        } catch(error) {
          targets.push({path,ok:false,message:error instanceof Error?error.message:'删除失败，请重试'});
        }
      }
      const complete=targets.every(target=>target.ok);
      record.deletionPending=!complete;
      if (complete) delete record.pendingExplanation;
      await this.commit(next);
      return {targets,complete};
    });
  }
  splitWordNotes(): Promise<{moved: number; notes: number; failures: {id: string; message: string}[]}> {
    return this.queue(async () => {
      const documents = new Map(this.data.documents.map(doc => [doc.id, doc]));
      const candidates = this.data.records.filter(record => record.kind === 'word' && record.savedTo.includes(documents.get(record.documentId)!.notePath));
      const failures: {id: string; message: string}[] = [];
      const destinations = new Set<string>();
      let moved = 0;
      for (const candidate of candidates) {
        const next = structuredClone(this.data);
        const record = next.records.find(record => record.id === candidate.id)!;
        const doc = documents.get(record.documentId)!;
        try {
          if (record.deletionPending || record.pendingUndo || record.pendingExplanation) throw new Error('请先完成这张卡片的待处理操作。');
          const legacy = await this.port.read(doc.notePath);
          if (legacy !== null && !ownedIndependentNote(legacy, doc.notePath, record, doc)) throw new Error('无法确认旧学习笔记的归属。');
          const range = legacy === null ? undefined : savedCardRange(legacy, record, doc);
          const word = await this.planWordNote(next, record);
          if (legacy !== null && range) {
            const raw = legacy.slice(range.start, range.end).trimStart();
            const endMarker = `<!-- note-digest:record-end:${record.id} -->`;
            const card = raw.includes(endMarker) ? raw : `${raw.trimEnd()}\n${endMarker}\n`;
            // Persist the destination before copying so an interrupted migration can resume.
            await this.commit(next);
            await this.updateWordNote(word.path, current => {
              const base = prepareArticleWordNote(current, record, doc);
              const existing = savedCardRange(base, record, doc);
              if (!existing) return appendGroupedCard(base, 'word', '\n\n' + card);
              if (base.slice(existing.start, existing.end) !== card) throw new Error('新旧卡片内容不同，已保留两处内容。');
              return base;
            });
            if (!record.savedTo.includes(word.path)) record.savedTo.push(word.path);
            await this.commit(next);
            const copy = await this.port.read(word.path);
            const copied = copy === null ? undefined : savedCardRange(copy, record, doc);
            if (!copy || !ownedIndependentNote(copy, word.path, record, doc) || !copied || copy.slice(copied.start, copied.end) !== card) {
              throw new Error('无法核对新卡片，已保留旧笔记。');
            }
            await this.port.update(doc.notePath, current => {
              if (current !== legacy) throw new Error('旧笔记刚刚有改动，已保留其内容。');
              return legacy.slice(0, range.start) + legacy.slice(range.end);
            });
          } else {
            const copy = record.savedTo.includes(word.path) ? await this.port.read(word.path) : null;
            if (!copy || !ownedIndependentNote(copy, word.path, record, doc) || !savedCardRange(copy, record, doc)) {
              throw new Error('找不到可核对的旧卡片和新副本。');
            }
          }
          record.savedTo = record.savedTo.filter(path => path !== doc.notePath);
          await this.commit(next);
          if (this.recentSave?.receipt.recordId === record.id) this.recentSave = undefined;
          moved++;
          destinations.add(word.path);
        } catch (error) {
          failures.push({id: record.id, message: error instanceof Error ? error.message : '拆分失败。'});
        }
      }
      return {moved, notes: destinations.size, failures};
    });
  }
  compact(path: string): Promise<string> {
    return this.queue(async () => {
      const doc = this.data.documents.find(doc => doc.path === path);
      if (!doc) return '本文暂无收藏。';
      const records = this.data.records.filter(record => record.documentId === doc.id && !record.pendingExplanation);
      const reports: string[] = [];
      for (const target of [path, doc.notePath]) {
        if (await this.port.read(target) === null) continue;
        try {
          let count = 0;
          await this.port.update(target, current => {
            if (current === null) throw new Error('笔记已不存在。');
            const result = compactLegacyCards(current, records, doc); count = result.count; return result.text;
          });
          reports.push(`${target}：整理了 ${count} 张旧卡片`);
        } catch { reports.push(`${target}：整理失败，请稍后重试`); }
      }
      return reports.join('\n') + '\n已手工改动或无法确认的旧卡片保持原样。';
    });
  }
  async matchingWords(selection: SelectionSnapshot): Promise<LearningRecord[]> {
    if (!canCollectSelection(selection)) return [];
    const data = this.data;
    const doc = data.documents.find(doc => doc.path === selection.path);
    if (!doc) return [];
    const {matches} = await matchingRecords(data,selection,'word',doc);
    return structuredClone(matches.filter(record => record.savedTo.length && !record.deletionPending && !record.pendingUndo));
  }
  updateExplanation(selection: SelectionSnapshot, id: string, input: DigestResult): Promise<string> {
    return this.queue(async () => {
      const next = structuredClone(this.data);
      const doc = next.documents.find(doc => doc.path === selection.path);
      if (!doc || !canCollectSelection(selection)) throw new Error('无法确认要更新的收藏。');
      const {matches} = await matchingRecords(next,selection,'word',doc);
      const record = matches.find(record => record.id === id && record.savedTo.length && !record.deletionPending && !record.pendingUndo);
      if (!record) throw new Error('找不到此选区对应的单词收藏。');
      const body = articleBody(selection.source);
      const source = await this.port.read(selection.path);
      if (source === null || articleBody(source) !== body) throw new Error('原文已变化，请重新选词并解释。');

      const pending = record.pendingExplanation;
      const result = pending?.result ?? validateResult(input,'explain');
      const updated = {...record,result};
      const plans: {path: string; before: string; after: string; beforeHash: string; afterHash: string}[] = [];
      // Check both copies before persisting intent or touching any note.
      for (const path of new Set(record.savedTo)) {
        try {
          const before = await this.port.read(path);
          if (before === null) throw new Error('学习卡片所在笔记已不存在。');
          if (path === selection.path ? articleBody(before) !== body : !ownedIndependentNote(before, path, record, doc)) {
            throw new Error('原文或学习笔记已变化。');
          }
          const beforeHash = await digestText(before);
          const saved = pending?.copies.find(copy => copy.path === path);
          if (pending && beforeHash !== saved?.before && beforeHash !== saved?.after) {
            throw new Error('笔记在上次更新后有改动，无法安全继续。');
          }
          let after = beforeHash === saved?.after ? before : updateCard(before,record,doc,updated);
          let afterHash = await digestText(after);
          if (path === record.wordNote?.path && (!saved || afterHash !== saved.after)) {
            after = await this.indexFamily(after, before);
            afterHash = await digestText(after);
          }
          if (saved && afterHash !== saved.after) throw new Error('无法确认上次更新的内容。');
          plans.push({path,before,after,beforeHash,afterHash});
        } catch (error) {
          throw new Error(`${path}：${error instanceof Error ? error.message : '无法安全更新'}`);
        }
      }
      if (!pending) {
        record.pendingExplanation = {result,copies:plans.map(plan => ({
          path:plan.path, before:plan.beforeHash, after:plan.afterHash,
        }))};
        await this.commit(next);
      }
      if (this.recentSave?.receipt.recordId === id) this.recentSave = undefined;
      const failed: string[] = [];
      for (const {path,before,after} of plans) {
        try {
          await this.port.update(path,current => {
            if (current !== before) throw new Error('笔记刚刚有改动，已保留其内容。');
            return after;
          });
        } catch (error) { failed.push(`${path}：${error instanceof Error ? error.message : '更新失败'}`); }
      }
      if (failed.length) return ['更新尚未完成，可重试。',...failed].join('\n');
      record.result = result;
      delete record.pendingExplanation;
      await this.commit(next);
      return pending ? '已完成上次更新' : '已更新单词卡';
    });
  }
  save(selection: SelectionSnapshot, input: DigestResult, kind: Kind, target: SaveTarget): Promise<SaveReport> {
    return this.queue(async () => {
      if (!validPath(selection.path) || this.isLearningNote(selection.path)) throw new Error('请选择原文章，不要收藏生成的学习笔记。');
      const current = await this.port.read(selection.path);
      if (current === null || articleBody(current) !== articleBody(selection.source)) throw new Error('原文已修改或移动，请重新选择后收藏。');
      const result = validateCardResult(input, kind);
      const next = structuredClone(this.data);
      let doc = next.documents.find(doc => doc.path === selection.path);
      if (!doc) {
        const id = this.uuid();
        const name = selection.path.split('/').pop()!.replace(/\.md$/, '').replace(/[<>:"/\\|?*\[\]#^]/g, '-').slice(0, 48);
        doc = {id, path: selection.path, notePath: `Digest/文章学习/${name}--${id}.md`}; next.documents.push(doc);
      }
      const located = canCollectSelection(selection);
      const {anchor,matches} = located ? await matchingRecords(next,selection,kind,doc) : {
        anchor: contextualAnchor(selection),
        matches: next.records.filter(record => record.documentId === doc.id && record.kind === kind && record.unlocated &&
          record.anchor.text === selection.text.trim() && record.context === selection.context),
      };
      // A suggested pattern may have a different title from a literal phrase already saved at this span.
      const title = kind === 'expression' && result.meaning === undefined && result.headword;
      const candidates = title ? matches.filter(record =>
        wordTitle(learningCardTitle(record)).toLowerCase() === wordTitle(title).toLowerCase()) : matches;
      let record = candidates.find(record => record.active && record.savedTo.length) ??
        candidates.find(record => record.savedTo.length || record.pendingUndo) ?? candidates[0];
      const wasActive = record?.active ?? false;
      if (!record) {
        const originalContext = selection.contextOffset === undefined ? undefined :
          shortContext({block:selection.context,offset:selection.contextOffset,text:selection.text});
        record = {id: this.uuid(), documentId: doc.id, kind, anchor, context: selection.context,
          originalContext, unlocated: located ? undefined : true,
          result, createdAt: new Date().toISOString(), active: true, savedTo: []}; next.records.push(record);
      }
      if (record.pendingUndo) throw new Error('这条收藏的撤销尚未完成，请在「本文收藏」重试。');
      if (record.pendingExplanation) return {
        record: structuredClone(record),
        targets: [{path: selection.path, ok: true, message: '已收藏'}],
      };
      if (kind === 'expression' || (kind === 'word' && !record.savedTo.includes(doc.notePath))) await this.planWordNote(next, record);
      const independentPath = record.wordNote?.path ?? doc.notePath;
      record.active = true; record.deletionPending = false;
      // Durable intent before external writes: retries retain identity even after a partial failure/crash.
      await this.commit(next);
      const paths = !located || target === 'note' ? [independentPath] : target === 'both' ? [selection.path, independentPath] : [selection.path];
      const targets: SaveReport['targets'] = [];
      const appended: string[] = [];
      for (const path of paths) {
        try {
          if (located && target === 'source' && path === independentPath) {
            const latest = await this.port.read(selection.path);
            if (latest === null || articleBody(latest) !== articleBody(selection.source)) throw new Error('原文已变化，请重新选择后重试。');
          }
          let existed = false;
          if (path === record.wordNote?.path) await this.updateWordNote(path, content => {
            const base = prepareArticleWordNote(content, record!, doc!);
            existed = base.includes(`<!-- note-digest:record:${record!.id} -->`);
            return appendRecord(base, record!, false);
          });
          else await this.port.update(path, content => {
            const isSource = path === selection.path;
            if (isSource && (content === null || articleBody(content) !== articleBody(selection.source))) throw new Error('原文已变化，请重新选择后重试。');
            const header = `<!-- note-digest:document:${doc!.id} -->`;
            if (!isSource && content !== null && !content.includes(header)) throw new Error('目标笔记不是本插件的学习笔记，已避免覆盖。');
            const base = content ?? `${header}\n# Note Digest 学习笔记\n\n${sourceLink(doc!.path)}\n`;
            existed = base.includes(`<!-- note-digest:record:${record!.id} -->`);
            return appendRecord(base, record!, isSource);
          });
          if (!existed) appended.push(path);
          if (!record.savedTo.includes(path)) record.savedTo.push(path);
          try { await this.commit(next); } catch { throw new Error('内容已写入，但收藏状态保存失败；请重试以恢复高亮。'); }
          targets.push({path, ok: true, message: existed ? '已收藏' : '已保存'});
        } catch (error) {
          targets.push({path, ok: false, message: error instanceof Error ? error.message : '保存失败，请重试'});
          if (path === selection.path && !record.savedTo.includes(path) && !paths.includes(independentPath)) paths.push(independentPath);
        }
      }
      const undo = appended.length ? {recordId: record.id, id: this.uuid()} : undefined;
      if (undo) this.recentSave = {receipt: undo, paths: appended, wasActive};
      return {record: structuredClone(record), targets, ...(undo && {undo})};
    });
  }
}

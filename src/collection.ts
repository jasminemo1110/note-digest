import { ASSESSMENT_LABELS, escapeMarkdown, validateResult, type DigestResult, type SelectionSnapshot } from './core';
import { showAssessment } from './reading-layout';
import { shortContext } from './reading-actions';
import { articleBody, LEARNING_BOUNDARY, makeAnchor, type Anchor } from './anchors';

export type Kind = 'word' | 'quote';
export type SaveTarget = 'source' | 'note' | 'both';
export interface SourceDocument { id: string; path: string | null; notePath: string }
export interface LearningRecord {
  id: string; documentId: string; kind: Kind; anchor: Anchor; context: string;
  result: DigestResult; createdAt: string; active: boolean; savedTo: string[]; deletionPending?: boolean;
}
export interface CollectionData { version: 1; secretName: string; documents: SourceDocument[]; records: LearningRecord[] }
export interface StoragePort {
  read(path: string): Promise<string | null>;
  /** Must synchronously transform current content, or exclusively create when absent. */
  update(path: string, transform: (current: string | null) => string): Promise<void>;
  persist(data: CollectionData): Promise<void>;
}
export interface SaveReport { record: LearningRecord; targets: { path: string; ok: boolean; message: string }[] }
const ID = /^[a-zA-Z0-9-]{1,80}$/;
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\r\n\0\\]/.test(value) &&
    !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.' || !part) && value.endsWith('.md');
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
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !ID.test(record.id) || recordIds.has(record.id) || !ids.has(record.documentId) ||
        !['word', 'quote'].includes(record.kind) || typeof record.active !== 'boolean' || (record.deletionPending !== undefined && typeof record.deletionPending !== 'boolean') || !Array.isArray(record.savedTo) || !record.savedTo.every(validPath) || typeof record.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(record.createdAt) ||
        !record.anchor || typeof record.anchor.block !== 'string' || record.anchor.block.length > 24000 ||
        typeof record.anchor.text !== 'string' || !record.anchor.text.trim() || record.anchor.text.length > 12000 ||
        !Number.isInteger(record.anchor.offset) || record.anchor.offset < 0 ||
        record.anchor.block.slice(record.anchor.offset, record.anchor.offset + record.anchor.text.length) !== record.anchor.text ||
        typeof record.context !== 'string' || record.context.length > 14400) throw new Error('收藏条目数据损坏。');
    recordIds.add(record.id);
    record.result = validateResult(record.result, record.kind === 'word' ? 'explain' : 'translate');
  }
  return structuredClone({version: 1 as const, secretName: data.secretName, documents, records});
}
const quoted = (value: string) => escapeMarkdown(value).split(/\r?\n/).map(line => '> ' + line).join('\n');
function sourceLink(path: string | null): string {
  return path ? `[返回原文](/${path.split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16))).join('/')})` : '原文已删除或无法定位';
}
function legacyRecordMarkdown(record: LearningRecord, doc: SourceDocument): string {
  const result = record.result;
  let text = `\n\n<!-- note-digest:record:${record.id} -->\n### ${record.kind === 'word' ? '词语' : '金句'}：${escapeMarkdown(record.anchor.text).replace(/\r?\n/g, ' ')}\n\n${sourceLink(doc.path)} · ${record.createdAt.slice(0, 10)}\n\n${quoted(record.anchor.text)}\n\n**中文翻译**\n\n${quoted(result.translation)}`;
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
  return text + '\n';
}
function previousRecordMarkdown(record: LearningRecord, _doc: SourceDocument): string {
  const result = record.result;
  let text = `\n\n<!-- note-digest:record:${record.id} -->\n### ${record.kind === 'word' ? '词语' : '金句'}：${escapeMarkdown(record.anchor.text).replace(/\r?\n/g, ' ')}`;
  if (record.kind === 'word') text += `\n\n**音标** ${escapeMarkdown(result.pronunciation ?? '不适用或无法可靠确定')}`;
  text += `\n\n${quoted(result.translation)}`;
  if (record.kind === 'word') {
    text += `\n\n**原始语境**\n\n${quoted(shortContext(record.anchor))}`;
    for (const [label, value] of [['语境含义', result.meaning], ['用法', result.usage], ['例句', result.example]]) {
      if (value) text += `\n\n**${label}**\n\n${quoted(value)}`;
    }
    if (result.assessment) {
      text += `\n\n**表达判断（AI 建议）：${ASSESSMENT_LABELS[result.assessment.status]}**\n\n${quoted(result.assessment.explanation)}`;
      if (result.assessment.correction) text += `\n\n**${result.assessment.status === 'informal' ? '更正式的表达（可选）' : '建议改法'}**\n\n${quoted(result.assessment.correction)}`;
    }
  }
  return text + '\n';
}
function groupedRecordMarkdown(record: LearningRecord, _doc: SourceDocument): string {
  const result = record.result;
  let text = `\n\n<!-- note-digest:record:${record.id} -->\n#### ${record.kind === 'word' ? '词语' : '金句'}：${escapeMarkdown(record.anchor.text).replace(/\r?\n/g, ' ')}`;
  if (record.kind === 'word') text += `\n\n**音标** ${escapeMarkdown(result.pronunciation ?? '不适用或无法可靠确定')}`;
  text += `\n\n${quoted(result.translation)}`;
  if (record.kind === 'word') {
    text += `\n\n**原始语境**\n\n${quoted(shortContext(record.anchor))}`;
    for (const [label, value] of [['语境含义', result.meaning], ['用法', result.usage], ['例句', result.example]]) {
      if (value) text += `\n\n**${label}**\n\n${quoted(value)}`;
    }
    if (result.assessment && showAssessment(result.assessment)) {
      text += `\n\n**表达判断（AI 建议）：${ASSESSMENT_LABELS[result.assessment.status]}**\n\n${quoted(result.assessment.explanation)}`;
      if (result.assessment.correction) text += `\n\n**${result.assessment.status === 'informal' ? '更正式的表达（可选）' : '建议改法'}**\n\n${quoted(result.assessment.correction)}`;
    }
  }
  return text + '\n';
}
export function recordMarkdown(record: LearningRecord, doc: SourceDocument): string {
  return groupedRecordMarkdown(record, doc) + `<!-- note-digest:record-end:${record.id} -->\n`;
}
export function removeSavedRecord(current: string, record: LearningRecord, doc: SourceDocument): {text: string; removed: boolean} {
  const marker = `<!-- note-digest:record:${record.id} -->`;
  const start = current.indexOf(marker);
  if (start < 0) return {text: current, removed: false};
  if (current.indexOf(marker, start + marker.length) >= 0) throw new Error('记录标记重复，无法安全确定要删除的卡片。');
  const boundary = current.indexOf(LEARNING_BOUNDARY);
  const ownedNote = current.includes(`<!-- note-digest:document:${doc.id} -->`);
  if (!ownedNote && (boundary < 0 || start < boundary + LEARNING_BOUNDARY.length)) throw new Error('卡片不在可确认的学习笔记区域，已保留原文。');
  const endMarker = `<!-- note-digest:record-end:${record.id} -->`;
  const end = current.indexOf(endMarker);
  if (end >= 0) {
    if (end < start || current.indexOf(endMarker, end + endMarker.length) >= 0 ||
        /<!-- note-digest:(?:record:|group:|end:)/.test(current.slice(start + marker.length, end))) throw new Error('卡片边界损坏，已保留内容。');
    const finish = end + endMarker.length + (current[end + endMarker.length] === '\n' ? 1 : 0);
    return {text: current.slice(0,start) + current.slice(finish), removed: true};
  }
  // Historical cards have no closing marker. Delete only exact known output, leaving manual additions untouched.
  for (const candidate of [groupedRecordMarkdown(record,doc), previousRecordMarkdown(record,doc), legacyRecordMarkdown(record,doc)]) {
    const index = current.indexOf(candidate);
    if (index >= 0 && index + candidate.indexOf(marker) === start) return {text:current.slice(0,index)+current.slice(index+candidate.length),removed:true};
  }
  throw new Error('旧卡片已手工修改且缺少结束标记，无法安全确定删除范围，请手动删除该卡片。');
}
function groupTokens(kind: Kind) {
  return {start: `<!-- note-digest:group:${kind} -->`, end: `<!-- note-digest:end:${kind} -->`};
}
function appendGrouped(current: string, record: LearningRecord, doc: SourceDocument): string {
  const {start, end} = groupTokens(record.kind);
  const startIndex = current.indexOf(start); const endIndex = current.indexOf(end);
  if (startIndex < 0 && endIndex < 0) {
    return current + `\n\n${start}\n### ${record.kind === 'word' ? '单词' : '金句'}\n` + recordMarkdown(record, doc) + `\n${end}\n`;
  }
  if (startIndex < 0 || endIndex < startIndex || current.indexOf(start, startIndex + 1) >= 0 || current.indexOf(end, endIndex + 1) >= 0) throw new Error('学习分组标记已改动，请先恢复标记或选择另一个保存位置。');
  return current.slice(0, endIndex) + recordMarkdown(record, doc) + '\n' + current.slice(endIndex);
}
/** Explicit migration moves only byte-identical generated cards into typed groups. */
export function compactLegacyCards(current: string, records: LearningRecord[], doc: SourceDocument): {text: string; count: number} {
  let text = current; let count = 0;
  for (const record of records) {
    if (text.includes(recordMarkdown(record, doc))) continue;
    const grouped = groupedRecordMarkdown(record, doc);
    if (text.includes(grouped)) { text = text.replace(grouped,recordMarkdown(record,doc)); count++; continue; }
    const candidates = [legacyRecordMarkdown(record, doc), previousRecordMarkdown(record, doc)];
    const old = candidates.find(candidate => text.includes(candidate));
    if (old) { text = appendGrouped(text.replace(old, ''), record, doc); count++; }
  }
  return {text, count};
}
export function appendRecord(current: string, record: LearningRecord, doc: SourceDocument, isSource: boolean): string {
  if (current.includes(`<!-- note-digest:record:${record.id} -->`)) return current;
  if (isSource && !current.includes(LEARNING_BOUNDARY)) current += LEARNING_BOUNDARY + '## Note Digest 学习笔记\n';
  return appendGrouped(current, record, doc);
}

/** Serializes collection metadata and writes, including settings and rename events. */
export class CollectionStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private data: CollectionData, private port: StoragePort, private uuid: () => string = () => crypto.randomUUID()) {}
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.catch(() => undefined); return result;
  }
  private async commit(next: CollectionData): Promise<void> { await this.port.persist(structuredClone(next)); this.data = structuredClone(next); }
  get secretName(): string { return this.data.secretName; }
  recordsFor(path: string, includeInactive = false): LearningRecord[] {
    const doc = this.data.documents.find(doc => doc.path === path);
    return doc ? structuredClone(this.data.records.filter(record => record.documentId === doc.id && (includeInactive ? record.savedTo.length > 0 || record.deletionPending : record.active && record.savedTo.length > 0))) : [];
  }
  notePathFor(path: string): string | undefined { return this.data.documents.find(doc => doc.path === path)?.notePath; }
  isLearningNote(path: string): boolean { return this.data.documents.some(doc => doc.notePath === path); }
  setSecretName(name: string): Promise<void> { return this.queue(() => this.commit({...this.data, secretName: name})); }
  rename(oldPath: string, newPath: string | null): Promise<void> {
    return this.queue(async () => {
      const next = structuredClone(this.data);
      for (const doc of next.documents) {
        if (doc.path === oldPath || doc.path?.startsWith(oldPath + '/')) doc.path = newPath === null ? null : newPath + doc.path.slice(oldPath.length);
        if (newPath !== null && (doc.notePath === oldPath || doc.notePath.startsWith(oldPath + '/'))) doc.notePath = newPath + doc.notePath.slice(oldPath.length);
      }
      for (const record of next.records) record.savedTo = record.savedTo.map(path =>
        newPath !== null && (path === oldPath || path.startsWith(oldPath + '/')) ? newPath + path.slice(oldPath.length) : path);
      await this.commit(next);
    });
  }
  deactivate(id: string): Promise<void> {
    return this.queue(async () => {
      const next = structuredClone(this.data); const record = next.records.find(record => record.id === id);
      if (record) record.active = false;
      await this.commit(next);
    });
  }
  removeNotes(id: string): Promise<{targets: SaveReport['targets']; complete: boolean}> {
    return this.queue(async () => {
      const next=structuredClone(this.data);
      const record=next.records.find(record=>record.id===id);
      if (!record) throw new Error('收藏记录不存在。');
      const doc=next.documents.find(doc=>doc.id===record.documentId)!;
      const paths=[...new Set([doc.path,doc.notePath,...record.savedTo].filter((path): path is string=>path!==null))];
      record.active=false;record.deletionPending=true;
      // Durable cancellation and retry identity before modifying either note.
      await this.commit(next);
      const targets: SaveReport['targets']=[];
      for (const path of paths) {
        try {
          let removed=false;
          if (await this.port.read(path)!==null) {
            await this.port.update(path,current=>{
              if (current===null) throw new Error('文件已移动或删除，请重试。');
              const result=removeSavedRecord(current,record,doc);removed=result.removed;return result.text;
            });
          }
          record.savedTo=record.savedTo.filter(saved=>saved!==path);
          await this.commit(next);
          targets.push({path,ok:true,message:removed?'已删除对应学习卡片':'没有对应卡片，无需删除'});
        } catch(error) {
          targets.push({path,ok:false,message:error instanceof Error?error.message:'删除失败，请重试'});
        }
      }
      const complete=targets.every(target=>target.ok);
      record.deletionPending=!complete;
      await this.commit(next);
      return {targets,complete};
    });
  }
  compact(path: string): Promise<string> {
    return this.queue(async () => {
      const doc = this.data.documents.find(doc => doc.path === path);
      if (!doc) return '本文暂无收藏。';
      const records = this.data.records.filter(record => record.documentId === doc.id);
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
  save(selection: SelectionSnapshot, input: DigestResult, kind: Kind, target: SaveTarget): Promise<SaveReport> {
    return this.queue(async () => {
      if (!validPath(selection.path) || this.isLearningNote(selection.path)) throw new Error('请选择原文章，不要收藏生成的学习笔记。');
      const current = await this.port.read(selection.path);
      if (current === null || articleBody(current) !== articleBody(selection.source)) throw new Error('原文已修改或移动，请重新选择后收藏。');
      const result = validateResult(input, kind === 'word' ? 'explain' : 'translate');
      const anchor = makeAnchor(selection.source, selection.start, selection.text);
      const next = structuredClone(this.data);
      let doc = next.documents.find(doc => doc.path === selection.path);
      if (!doc) {
        const id = this.uuid();
        const name = selection.path.split('/').pop()!.replace(/\.md$/, '').replace(/[<>:"/\\|?*\[\]#^]/g, '-').slice(0, 48);
        doc = {id, path: selection.path, notePath: `Digest/文章学习/${name}--${id}.md`}; next.documents.push(doc);
      }
      let record = next.records.find(record => record.documentId === doc!.id && record.kind === kind &&
        record.anchor.block === anchor.block && record.anchor.offset === anchor.offset && record.anchor.text === anchor.text);
      if (!record) {
        record = {id: this.uuid(), documentId: doc.id, kind, anchor, context: selection.context,
          result, createdAt: new Date().toISOString(), active: true, savedTo: []}; next.records.push(record);
      }
      record.active = true; record.deletionPending = false;
      // Durable intent before external writes: retries retain identity even after a partial failure/crash.
      await this.commit(next);
      const paths = target === 'both' ? [selection.path, doc.notePath] : [target === 'source' ? selection.path : doc.notePath];
      const targets: SaveReport['targets'] = [];
      for (const path of paths) {
        try {
          let existed = false;
          await this.port.update(path, content => {
            const isSource = path === selection.path;
            if (isSource && (content === null || articleBody(content) !== articleBody(selection.source))) throw new Error('原文已变化，请重新选择后重试。');
            const header = `<!-- note-digest:document:${doc!.id} -->`;
            if (!isSource && content !== null && !content.includes(header)) throw new Error('目标笔记不是本插件的学习笔记，已避免覆盖。');
            const base = content ?? `${header}\n# Note Digest 学习笔记\n\n${sourceLink(doc!.path)}\n`;
            existed = base.includes(`<!-- note-digest:record:${record!.id} -->`);
            return appendRecord(base, record!, doc!, isSource);
          });
          if (!record.savedTo.includes(path)) record.savedTo.push(path);
          try { await this.commit(next); } catch { throw new Error('内容已写入，但收藏状态保存失败；请重试以恢复高亮。'); }
          targets.push({path, ok: true, message: existed ? '已存在，保留手工修改' : '已保存'});
        } catch (error) {
          targets.push({path, ok: false, message: error instanceof Error ? error.message : '保存失败，请重试'});
        }
      }
      return {record: structuredClone(record), targets};
    });
  }
}

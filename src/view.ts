import { ItemView, WorkspaceLeaf } from 'obsidian';
import type NoteDigestPlugin from './main';
import type { Kind, SaveTarget } from './collection';
import { shortContext } from './reading-actions';
import { makeAnchor } from './anchors';
import { isLongSelection, resultMode, showAssessment } from './reading-layout';
import { ASSESSMENT_LABELS, type Action, type DigestResult, type SelectionSnapshot } from './core';
export const VIEW_TYPE = 'note-digest-learning';
export class DigestView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: NoteDigestPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Note Digest'; }
  getIcon(): string { return 'book-open-text'; }
  async onOpen(): Promise<void> { this.render(); }
  render(selection?: SelectionSnapshot, result?: DigestResult, status = '', mode: Action | 'idle' = resultMode(result)): void {
    const el = this.contentEl; el.empty(); el.addClass('note-digest-panel');
    el.createEl('h2', { text: 'Note Digest' });
    if (!selection) {
      el.createEl('p', {text: '在文章中选择英文，再点击 Digest 或按 D。'});
      const path = this.app.workspace.getActiveFile()?.path; if (path) this.renderCollection(path); return;
    }
    const actions = el.createDiv({cls:'note-digest-actions note-digest-toolbar', attr:{'aria-label':'阅读操作'}});
    const choices: [string, Action][] = [['翻译','translate'],['语境解释','explain']];
    if (isLongSelection(selection.text)) choices.unshift(['Summarize','summarize']);
    for (const [label, action] of choices) {
      const button = actions.createEl('button', {text:label, attr:{'aria-pressed':String(action===mode)}});
      button.onclick = () => { void this.plugin.run(selection, action); };
    }
    if (mode === 'idle') {
      el.createEl('p', {text:'已选中长段落。请选择 Summarize、翻译或语境解释。',cls:'note-digest-muted'}); return;
    }
    if (status) el.createEl('p',{text:status,cls:'note-digest-result',attr:{role:'status','aria-live':'polite'}});
    if (!result) {
      if (!isLongSelection(selection.text)) el.createEl('p',{text:selection.text,cls:'note-digest-original'});
      return;
    }
    if (mode === 'summarize') {
      el.createEl('h3',{text:'所选内容摘要'});
      el.createEl('p',{text:result.summary ?? '',cls:'note-digest-result'});
      return;
    }
    if (mode === 'translate') {
      const paragraphs = result.paragraphs ?? [{source:selection.text,start:selection.start,end:selection.end,translation:result.translation}];
      for (const paragraph of paragraphs) {
        const pair = el.createDiv({cls:'note-digest-paragraph'});
        pair.createEl('p',{text:paragraph.source,cls:'note-digest-original'});
        pair.createEl('p',{text:paragraph.translation,cls:'note-digest-result'});
        this.renderInsertButtons(pair,{...selection,text:paragraph.source,start:paragraph.start,end:paragraph.end},paragraph.translation);
      }
    } else {
      el.createEl('h3',{text:selection.text,cls:'note-digest-original'});
      el.createEl('p',{text:result.pronunciation ?? '音标：不适用或无法可靠确定',cls:'note-digest-muted'});
      el.createEl('p',{text:result.translation,cls:'note-digest-result'});
      let context = selection.text;
      try { context = shortContext(makeAnchor(selection.source,selection.start,selection.text)); } catch { /* Keep the selected text if the paragraph is too large. */ }
      el.createEl('h3',{text:'原始语境'}); el.createEl('blockquote',{text:context});
      for (const [key,label] of [['meaning','语境含义'],['usage','用法'],['example','例句']] as const) {
        if (result[key]) { el.createEl('h3',{text:label}); el.createEl('p',{text:result[key],cls:'note-digest-result'}); }
      }
      if (result.assessment && showAssessment(result.assessment)) {
        el.createEl('h3',{text:result.assessment.status === 'uncertain' ? '语境提示' : '表达问题 · '+ASSESSMENT_LABELS[result.assessment.status]});
        el.createEl('p',{text:result.assessment.explanation,cls:'note-digest-result'});
        if (result.assessment.correction) {
          el.createEl('h3',{text:'建议改法'}); el.createEl('p',{text:result.assessment.correction,cls:'note-digest-result'});
        }
      }
    }
    this.renderSave(selection,result,mode);
    this.renderCollection(selection.path);
  }
  private renderInsertButtons(parent: HTMLElement, selection: SelectionSnapshot, translation: string): void {
    const writes=parent.createDiv({cls:'note-digest-actions note-digest-insert'});
    for (const [label,mode] of [['添加到原文下方','below'],['添加到句后括号','inline']] as const) {
      const button=writes.createEl('button',{text:label});
      button.onclick=()=>{void this.plugin.insert(selection,translation,mode);};
    }
  }
  private renderSave(selection: SelectionSnapshot, result: DigestResult, mode: Action): void {
    const el=this.contentEl.createDiv({cls:'note-digest-save'});
    el.createEl('h3',{text:'收藏到学习笔记'});
    const targetLabel=el.createEl('label',{text:'保存位置 '});
    const target=targetLabel.createEl('select',{attr:{'aria-label':'收藏保存位置'}});
    for (const [value,text] of [['both','末尾及独立笔记'],['source','只有末尾'],['note','只有独立学习笔记']]) target.createEl('option',{value,text});
    target.value='both';
    let kind: HTMLSelectElement | undefined;
    if (mode==='explain') {
      const label=el.createEl('label',{text:'分类 '});
      kind=label.createEl('select',{attr:{'aria-label':'收藏分类'}});
      kind.createEl('option',{value:'word',text:'单词（完整解释）'});
      kind.createEl('option',{value:'quote',text:'金句与译文'});
    }
    const message=el.createEl('p',{cls:'note-digest-result',attr:{role:'status','aria-live':'polite'}});
    const save=el.createEl('button',{text:'保存',cls:'mod-cta'});
    save.onclick=async()=>{
      save.disabled=true;message.textContent='正在保存…';
      try { message.textContent=await this.plugin.collect(selection,result,(kind?.value ?? 'quote') as Kind,target.value as SaveTarget); }
      catch(error) { message.textContent=error instanceof Error ? error.message : '保存失败，请重试。'; }
      finally { save.disabled=false;if(message.isConnected)this.renderCollection(selection.path); }
    };
  }
  private renderCollection(path: string): void {
    this.contentEl.querySelector('.note-digest-collection')?.remove();
    const records=this.plugin.collection.recordsFor(path);if(!records.length)return;
    const list=this.contentEl.createDiv({cls:'note-digest-collection'});
    list.createEl('h3',{text:`本文收藏（${records.length}）`});
    const compact=list.createEl('button',{text:'整理旧版卡片并分组'});
    const status=list.createEl('p',{cls:'note-digest-result',attr:{role:'status'}});
    compact.onclick=async()=>{
      compact.disabled=true;
      try { status.textContent=await this.plugin.collection.compact(path); }
      catch { status.textContent='整理失败，请稍后重试。'; }
      finally { compact.disabled=false; }
    };
    const notePath=this.plugin.collection.notePathFor(path);
    if(notePath && this.app.vault.getAbstractFileByPath(notePath)) {
      const open=list.createEl('button',{text:'打开独立学习笔记'});
      open.onclick=()=>{void this.app.workspace.openLinkText(notePath,'',false);};
    }
    for(const [kind,title] of [['word','单词'],['quote','金句']] as const) {
      const items=records.filter(record=>record.kind===kind);if(!items.length)continue;
      list.createEl('h4',{text:title});
      for(const record of items) {
        const row=list.createDiv({cls:'note-digest-saved-row'});
        row.createEl('p',{text:record.anchor.text});
        row.createEl('p',{text:record.result.translation,cls:'note-digest-saved-translation'});
        const locate=row.createEl('button',{text:'定位原文'});
        locate.onclick=()=>{void this.plugin.revealRecord(path,record.id);};
        const remove=row.createEl('button',{text:'取消收藏高亮'});
        remove.onclick=async()=>{
          remove.disabled=true;
          try { await this.plugin.removeHighlight(record.id);this.renderCollection(path); }
          catch { remove.disabled=false;remove.textContent='取消失败，点击重试'; }
        };
      }
    }
  }
}

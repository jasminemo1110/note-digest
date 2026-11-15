import { ItemView, WorkspaceLeaf } from 'obsidian';
import type NoteDigestPlugin from './main';
import type { ArticleSummary } from './article-summary';
import type { Kind, SaveTarget } from './collection';
import { shortContext } from './reading-actions';
import { makeAnchor } from './anchors';
import { isLongSelection, resultMode, showAssessment } from './reading-layout';
import { canCollectSelection, translationInsertion, ASSESSMENT_LABELS, rebaseSelectionAfterInsertion, type InsertionReceipt, type Action, type DigestResult, type DigestSelection, type SelectionSnapshot } from './core';
export const VIEW_TYPE = 'note-digest-learning';
export class DigestView extends ItemView {
  private renderRevision = 0;
  constructor(leaf: WorkspaceLeaf, private plugin: NoteDigestPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Note Digest'; }
  getIcon(): string { return 'book-open-text'; }
  async onOpen(): Promise<void> { this.render(); }
  async onClose(): Promise<void> { this.plugin.stopArticleSummary(); }
  private startRender(): HTMLElement {
    this.renderRevision++;
    const el = this.contentEl;
    el.empty(); el.addClass('note-digest-panel');
    el.createEl('h2', {text: 'Note Digest'});
    return el;
  }
  private summaryButton(parent: HTMLElement, text = '总结全文', previous?: ArticleSummary): void {
    const button = parent.createEl('button', {text});
    button.onclick = () => { void this.plugin.summarizeCurrentArticle(previous); };
  }
  render(selection?: DigestSelection, result?: DigestResult, status = '', mode: Action | 'idle' = resultMode(result)): void {
    const el = this.startRender();
    const revision = this.renderRevision;
    const actions = el.createDiv({cls:'note-digest-actions note-digest-toolbar', attr:{'aria-label':'阅读操作'}});
    if (!selection) {
      this.summaryButton(actions);
      el.createEl('p', {text: '在文章或侧栏中选择英文，再点击 Digest 或按 D。'});
      const path = this.app.workspace.getActiveFile()?.path; if (path) this.renderCollection(path); return;
    }
    const choices: [string, Action][] = [['翻译','translate'],['语境解释','explain']];
    if (isLongSelection(selection.text)) choices.unshift(['Summarize','summarize']);
    for (const [label, action] of choices) {
      const button = actions.createEl('button', {text:label, attr:{'aria-pressed':String(action===mode)}});
      button.onclick = () => { void this.plugin.run(selection, action); };
    }
    const article = 'path' in selection ? selection : undefined;
    if (article) this.summaryButton(actions);
    if (!article) el.createEl('p', {text: '侧栏 · 临时选区', cls:'note-digest-muted'});
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
      const paragraphs = result.paragraphs ?? [{source:selection.text,translation:result.translation}];
      for (const paragraph of paragraphs) {
        const pair = el.createDiv({cls:'note-digest-paragraph'});
        pair.createEl('p',{text:paragraph.source,cls:'note-digest-original'});
        pair.createEl('p',{text:paragraph.translation,cls:'note-digest-result'});
        if (!article) continue;
        const insertRange = 'start' in paragraph ? {...article,text:paragraph.source,start:paragraph.start,end:paragraph.end} : article;
        this.renderInsertButtons(pair,insertRange,paragraph.translation,revision,receipt=>{
          const updated=rebaseSelectionAfterInsertion(article,receipt);
          if(updated) this.render(updated,result,'译文已添加，可以直接继续语境解释。',mode);
          else this.render(selection,result,'译文已添加；此多段选区包含新插入内容，请重新选择后继续。',mode);
        });
      }
    } else {
      el.createEl('h3',{text:selection.text,cls:'note-digest-original'});
      el.createEl('p',{text:result.pronunciation ?? '音标：不适用或无法可靠确定',cls:'note-digest-muted'});
      el.createEl('p',{text:result.translation,cls:'note-digest-result'});
      if (article) {
        let context = article.text;
        try { context = shortContext(makeAnchor(article.source,article.start,article.text)); } catch { /* Keep the selected text if the paragraph is too large. */ }
        el.createEl('h3',{text:'原始语境'}); el.createEl('blockquote',{text:context});
      } else if ('sidebar' in selection && selection.context) {
        const context = shortContext({block:selection.context,offset:selection.contextOffset,text:selection.text});
        el.createEl('h3',{text:'原始语境'}); el.createEl('blockquote',{text:context});
      }
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
    if (article) {
      if (canCollectSelection(article)) this.renderSave(article,result,mode);
      this.renderCollection(article.path);
    }
  }
  renderArticleSummary(path: string, article?: ArticleSummary, status = '', running = false): void {
    const el = this.startRender();
    const actions = el.createDiv({cls:'note-digest-actions note-digest-toolbar', attr:{'aria-label':'全文摘要操作'}});
    if (running) {
      const stop = actions.createEl('button', {text:'停止摘要'});
      stop.onclick = () => {
        this.plugin.stopArticleSummary();
        this.renderArticleSummary(path, article, '摘要已停止。');
      };
    } else {
      if (article && !article.overview) this.summaryButton(actions, article.sections.length ? '继续摘要' : '重试摘要', article);
      this.summaryButton(actions, article?.overview ? '重新总结全文' : '总结全文');
    }
    const title = path.split('/').at(-1)?.replace(/\.md$/, '') ?? path;
    el.createEl('h3', {text:title, cls:'note-digest-original'});
    if (status) el.createEl('p', {text:status, cls:'note-digest-result', attr:{role:'status','aria-live':'polite'}});
    if (article?.overview) {
      el.createEl('h4', {text:'全文概览'});
      el.createEl('p', {text:article.overview, cls:'note-digest-result'});
    }
    if (article?.sections.length && article.parts.length > 1) {
      const heading = article.overview ? '分节摘要' : `部分摘要 · 已完成 ${article.sections.length}/${article.parts.length} 节`;
      el.createEl('h4', {text:heading});
      article.sections.forEach((section, index) => {
        const row = el.createDiv({cls:'note-digest-paragraph'});
        row.createEl('h5', {text:section.title, cls:'note-digest-original'});
        row.createEl('p', {text:section.summary, cls:'note-digest-result'});
        const locate = row.createEl('button', {text:'定位原文'});
        locate.onclick = () => { void this.plugin.revealArticlePart(article, article.parts[index]); };
      });
    }
    if (!running) this.renderCollection(path);
  }
  private renderInsertButtons(parent: HTMLElement, selection: SelectionSnapshot, translation: string, revision: number, onInserted: (receipt: InsertionReceipt) => void): void {
    let writes: HTMLElement | undefined;
    for (const [label,mode] of [['添加到原文下方','below'],['在选区后加括号','inline']] as const) {
      try { translationInsertion(selection.source, selection, translation, mode); }
      catch { continue; }
      writes ??= parent.createDiv({cls:'note-digest-actions note-digest-insert'});
      const button=writes.createEl('button',{text:label});
      button.onclick=async()=>{
        const controls=Array.from(this.contentEl.querySelectorAll<HTMLButtonElement|HTMLSelectElement>('button,select'));
        const previous=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);
        try {
          const receipt=await this.plugin.insert(selection,translation,mode);
          if(receipt && revision===this.renderRevision) onInserted(receipt);
        } finally {
          if(revision===this.renderRevision) controls.forEach((control,index)=>control.disabled=previous[index]);
        }
      };
    }
    if (!writes) parent.createEl('p',{text:'无法安全插入，译文保留在侧栏。',cls:'note-digest-muted'});
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
    const save=el.createEl('button',{text:'保存',cls:'mod-cta'});
    const message=el.createEl('p',{cls:'note-digest-result',attr:{role:'status','aria-live':'polite'}});
    let refreshUpdate = () => {};
    save.onclick=async()=>{
      save.disabled=true;message.textContent='正在保存…';
      message.classList.remove('note-digest-save-duplicate');
      try {
        const feedback = await this.plugin.collect(selection,result,(kind?.value ?? 'quote') as Kind,target.value as SaveTarget);
        message.classList.toggle('note-digest-save-duplicate', feedback.duplicate);
        message.textContent = feedback.text;
      }
      catch(error) { message.textContent=error instanceof Error ? error.message : '保存失败，请重试。'; }
      finally {
        save.disabled=false;
        if (message.isConnected) { this.renderCollection(selection.path); refreshUpdate(); }
      }
    };
    if (mode === 'explain' && kind) {
      const updateArea = el.createDiv({cls:'note-digest-actions'});
      const category = kind;
      category.onchange = () => { updateArea.style.display = category.value === 'word' ? '' : 'none'; };
      const showUpdate = async () => {
        const matches = await this.plugin.collection.matchingWords(selection);
        if (!el.isConnected) return;
        updateArea.replaceChildren();
        if (!matches.length) return;
        let choose: HTMLSelectElement | undefined;
        if (matches.length > 1) {
          choose = updateArea.createEl('select', {attr:{'aria-label':'选择要更新的单词卡'}});
          choose.createEl('option', {value:'',text:'选择要更新的单词卡'});
          for (const record of matches) {
            choose.createEl('option', {value:record.id,text:`${record.anchor.text.trim()} · ${record.result.translation}`});
          }
        }
        const update = updateArea.createEl('button',{text:'用本次解释更新'});
        const selectedCard = () => matches.find(record => record.id === (choose ? choose.value : matches[0].id));
        const updateLabel = () => {
          const card = selectedCard();
          update.textContent = card?.pendingExplanation ? '继续上次更新' : '用本次解释更新';
          update.disabled = !card || save.disabled;
        };
        if (choose) choose.onchange = updateLabel;
        updateLabel();
        update.onclick = async () => {
          const card = selectedCard();
          if (!card || save.disabled) return;
          save.disabled = update.disabled = true;
          if (choose) choose.disabled = true;
          message.classList.remove('note-digest-save-duplicate');
          message.textContent = '正在更新…';
          try { message.textContent = await this.plugin.collection.updateExplanation(selection,card.id,result); }
          catch (error) { message.textContent = error instanceof Error ? error.message : '更新失败，请重试。'; }
          finally {
            save.disabled = false;
            if (choose) choose.disabled = false;
            updateLabel();
            if (message.isConnected) {
              this.renderCollection(selection.path);
              refreshUpdate();
            }
          }
        };
      };
      refreshUpdate = () => { void showUpdate().catch(() => {}); };
      refreshUpdate();
    }
  }
  private renderCollection(path: string): void {
    this.contentEl.querySelector('.note-digest-collection')?.remove();
    const records=this.plugin.collection.recordsFor(path,true);if(!records.length)return;
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
        if (!record.active) row.createEl('p',{text:record.deletionPending?'删除尚未完成，可重试':'已取消高亮，学习笔记保留',cls:'note-digest-muted'});
        const remove=row.createEl('button',{text:'取消收藏高亮'});
        remove.disabled=!record.active;
        remove.onclick=async()=>{
          remove.disabled=true;
          try { await this.plugin.removeHighlight(record.id);this.renderCollection(path); }
          catch { remove.disabled=false;remove.textContent='取消失败，点击重试'; }
        };
        const erase=row.createEl('button',{text:'取消高亮并删除笔记'});
        const message=row.createEl('p',{cls:'note-digest-result',attr:{role:'status','aria-live':'polite'}});
        erase.onclick=async()=>{
          erase.disabled=true;remove.disabled=true;message.textContent='正在检查并删除对应卡片…';
          try {
            const report=await this.plugin.removeNotes(record.id);
            this.renderCollection(path);
            // Keep per-target feedback visible even after the record disappears.
            this.contentEl.querySelector('[data-note-digest-deletion]')?.remove();
            const notice=this.contentEl.createEl('p',{text:report,cls:'note-digest-result',attr:{role:'status'}});
            notice.dataset.noteDigestDeletion='true';
          } catch(error) {
            message.textContent=error instanceof Error?error.message:'删除失败，请重试';erase.disabled=false;
          }
        };
      }
    }
  }
}

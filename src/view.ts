import { ItemView, WorkspaceLeaf } from 'obsidian';
import type NoteDigestPlugin from './main';
import { articleFinished, articlePartIsLocated, type ArticleSummary } from './article-summary';
import { SIDEBAR_NOTE_PATH, type Kind, type SaveTarget } from './collection';
import { shortContext, sidebarSelection } from './reading-actions';
import type { ClaudianExcerpt } from './claudian-draft';
import { makeAnchor } from './anchors';
import { isLongSelection, resultMode, showAssessment, type ParagraphTranslation } from './reading-layout';
import { explanationHeadword, canCollectSelection, translationInsertion, ASSESSMENT_LABELS, rebaseSelectionAfterInsertion, type InsertionReceipt, type Action, type DigestResult, type DigestSelection, type SelectionSnapshot, type SidebarSelection } from './core';
export const VIEW_TYPE = 'note-digest-learning';
export class DigestView extends ItemView {
  private renderRevision = 0;
  private selectionView?: DigestSelection;
  private claudianContexts = new WeakMap<HTMLElement, Omit<ClaudianExcerpt, 'text'>>();
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
  claudianExcerpt(selection: Selection): {region: HTMLElement; excerpt: ClaudianExcerpt} | undefined {
    if (selection.rangeCount !== 1 || selection.isCollapsed) return;
    const {startContainer} = selection.getRangeAt(0);
    let region = startContainer.nodeType === 1 ? startContainer as HTMLElement : startContainer.parentElement;
    while (region && region !== this.contentEl) {
      const context = this.claudianContexts.get(region);
      if (context) {
        const selected = sidebarSelection(selection, region, false);
        if (selected) return {region, excerpt: {...context, text: selected.text.trim()}};
        return;
      }
      region = region.parentElement;
    }
  }
  private sourceContext(selection: DigestSelection): string {
    if (selection.contextOffset !== undefined) {
      return shortContext({block:selection.context,offset:selection.contextOffset,text:selection.text});
    }
    if ('path' in selection) {
      try { return shortContext(makeAnchor(selection.source,selection.start,selection.text)); }
      catch { /* The selection itself is available even when the paragraph cannot be located. */ }
    }
    return selection.text;
  }
  private renderToolbar(el: HTMLElement, mode?: Action | 'idle' | 'full'): void {
    const actions = el.createDiv({cls:'note-digest-actions note-digest-toolbar', attr:{'aria-label':'阅读操作'}});
    const choices = [
      ['Digest 全文', 'full', () => this.plugin.summarizeCurrentArticle()],
      ['Digest 选中段落', 'summarize', () => this.plugin.summarizeSelection(this.selectionView)],
      ['翻译', 'translate', () => this.plugin.runSelectionAction('translate', this.selectionView)],
      ['语境解释', 'explain', () => this.plugin.runSelectionAction('explain', this.selectionView)],
    ] as const;
    for (const [label, action, run] of choices) {
      const button = actions.createEl('button', {text:label, attr:{'aria-pressed':String(action === mode)}});
      // Keep the text selection alive until the handler captures its current range.
      button.onmousedown = event => event.preventDefault();
      button.onclick = () => { void run(); };
    }
  }
  render(selection?: DigestSelection, result?: DigestResult, status = '', mode: Action | 'idle' = resultMode(result)): void {
    this.selectionView = selection;
    const el = this.startRender();
    const revision = this.renderRevision;
    this.renderToolbar(el, selection ? mode : undefined);
    if (!selection) {
      el.createEl('p', {text: '在文章或侧栏中选择英文，再点击 Digest 或按 D。'});
      const path = this.app.workspace.getActiveFile()?.path; if (path) this.renderCollection(path); return;
    }
    const article = 'path' in selection ? selection : undefined;
    if (!article) el.createEl('p', {text: '侧栏 · 临时选区', cls:'note-digest-muted'});
    if (mode === 'idle') {
      el.createEl('p', {text:'已选中较长文字。请选择「Digest 选中段落」或「Digest 全文」。',cls:'note-digest-muted'}); return;
    }
    if (status) el.createEl('p',{text:status,cls:'note-digest-result',attr:{role:'status','aria-live':'polite'}});
    if (!result) {
      if (!isLongSelection(selection.text)) el.createEl('p',{text:selection.text,cls:'note-digest-original'});
      if (status && !status.startsWith('正在')) this.regenerateSelection(el, selection, mode, '重试');
      return;
    }
    if (mode === 'summarize') {
      el.createEl('h3',{text:'所选内容摘要'});
      const summary = el.createEl('p',{text:result.summary ?? '',cls:'note-digest-result'});
      this.claudianContexts.set(summary, {source:selection.text});
      return;
    }
    if (mode === 'translate') {
      const paragraphs = result.paragraphs ?? [{source:selection.text,translation:result.translation}];
      for (const paragraph of paragraphs) {
        const pair = el.createDiv({cls:'note-digest-paragraph'});
        const bilingual = pair.createDiv();
        bilingual.createEl('p',{text:paragraph.source,cls:'note-digest-original'});
        bilingual.createEl('p',{text:paragraph.translation,cls:'note-digest-result'});
        this.claudianContexts.set(bilingual, {source:result.paragraphs ? paragraph.source : this.sourceContext(selection)});
        if (!article) continue;
        const insertRange = 'start' in paragraph ? {...article,text:paragraph.source,start:paragraph.start,end:paragraph.end} : article;
        this.renderInsertButtons(pair,insertRange,paragraph.translation,revision,receipt=>{
          const updated=rebaseSelectionAfterInsertion(article,receipt);
          if(updated) this.render(updated,result,'译文已添加，可以直接继续语境解释。',mode);
          else this.render(selection,result,'译文已添加；此多段选区包含新插入内容，请重新选择后继续。',mode);
        });
      }
    } else {
      const explanation = el.createDiv();
      const context = this.sourceContext(selection);
      this.claudianContexts.set(explanation, {source:context});
      const headword = explanationHeadword(selection.text, result);
      explanation.createEl('h3',{text:headword,cls:'note-digest-original'});
      explanation.createEl('p',{text:result.pronunciation ?? '音标：不适用或无法可靠确定',cls:'note-digest-muted'});
      explanation.createEl('p',{text:result.translation,cls:'note-digest-result'});
      if (headword !== selection.text) explanation.createEl('p',{text:'原文词形：' + selection.text,cls:'note-digest-muted'});
      if (article || selection.context) {
        explanation.createEl('h3',{text:'原始语境'}); explanation.createEl('blockquote',{text:context});
      }
      for (const [key,label] of [['meaning','语境含义'],['usage','用法'],['example','例句']] as const) {
        if (result[key]) { explanation.createEl('h3',{text:label}); explanation.createEl('p',{text:result[key],cls:'note-digest-result'}); }
      }
      if (result.assessment && showAssessment(result.assessment)) {
        explanation.createEl('h3',{text:result.assessment.status === 'uncertain' ? '语境提示' : '表达问题 · '+ASSESSMENT_LABELS[result.assessment.status]});
        explanation.createEl('p',{text:result.assessment.explanation,cls:'note-digest-result'});
        if (result.assessment.correction) {
          explanation.createEl('h3',{text:'建议改法'}); explanation.createEl('p',{text:result.assessment.correction,cls:'note-digest-result'});
        }
      }
      if (result.commonUsages?.length) {
        explanation.createEl('h3', {text:'其他常见用法'});
        const usages = explanation.createEl('ul');
        for (const {partOfSpeech, meaning, example} of result.commonUsages) {
          const item = usages.createEl('li', {cls:'note-digest-result'});
          item.createEl('strong', {text:`${partOfSpeech} · ${meaning}`});
          item.createEl('div', {text:example});
        }
      }
    }
    this.regenerateSelection(el, selection, mode);
    if (article) {
      this.renderSave(article,result,mode);
      this.renderCollection(article.path);
    } else if ('sidebar' in selection && mode === 'explain') {
      this.renderSidebarSave(selection, result);
    }
  }
  private renderSidebarSave(selection: SidebarSelection, result: DigestResult): void {
    const section = this.contentEl.createDiv({cls:'note-digest-save'});
    const actions = section.createDiv({cls:'note-digest-actions'});
    const save = actions.createEl('button', {text:'收藏到独立学习笔记', cls:'mod-cta'});
    let open: HTMLButtonElement | undefined;
    const status = section.createEl('p', {cls:'note-digest-result', attr:{role:'status','aria-live':'polite'}});
    save.onclick = async () => {
      save.disabled = true;
      status.textContent = '正在收藏…';
      status.classList.remove('note-digest-save-duplicate');
      try {
        const feedback = await this.plugin.collection.saveSidebarWord(selection, result);
        status.textContent = feedback.text;
        status.classList.toggle('note-digest-save-duplicate', feedback.duplicate);
        if (!open) {
          open = actions.createEl('button', {text:'打开侧栏学习笔记'});
          open.onclick = () => { void this.app.workspace.openLinkText(SIDEBAR_NOTE_PATH, '', false); };
        }
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : '收藏失败，请重试。';
      } finally {
        save.disabled = false;
      }
    };
  }
  private regenerateSelection(el: HTMLElement, selection: DigestSelection, mode: Action, text = '重新生成'): void {
    if (mode === 'summarize') return;
    const actions = el.createDiv({cls:'note-digest-actions'});
    const button = actions.createEl('button', {text});
    button.onclick = () => { void this.plugin.run(selection, mode, text === '重新生成'); };
  }
  renderArticleSummary(path: string, article?: ArticleSummary, status = '', running = false, requestedSelection?: DigestSelection): void {
    const selection = article?.selection ?? requestedSelection;
    if (selection) this.selectionView = selection;
    else if (this.selectionView && (!('path' in this.selectionView) || this.selectionView.path !== path)) this.selectionView = undefined;
    const el = this.startRender();
    this.renderToolbar(el, selection ? 'summarize' : 'full');
    const title = path ? path.split('/').at(-1)!.replace(/\.md$/, '') : '侧栏选区';
    el.createEl('h3', {text:title, cls:'note-digest-original'});
    if (status) el.createEl('p', {text:status, cls:'note-digest-result', attr:{role:'status','aria-live':'polite'}});
    const finished = article && articleFinished(article);
    if (running || !finished) {
      const actions = el.createDiv({cls:'note-digest-actions', attr:{'aria-label':'摘要进度'}});
      if (running) {
        const stop = actions.createEl('button', {text:'停止摘要'});
        stop.onclick = () => {
          this.plugin.stopArticleSummary();
          this.renderArticleSummary(path, article, '摘要已停止。', false, selection);
        };
      } else {
        const retry = actions.createEl('button', {text:article?.sections.length ? '继续摘要' : '重试摘要'});
        retry.onclick = () => {
          if (article) void this.plugin.retryDigest(article);
          else if (selection) void this.plugin.summarizeSelection(selection);
          else void this.plugin.summarizeCurrentArticle();
        };
      }
    }
    if (article?.overview) {
      el.createEl('h4', {text:selection ? '选区概览' : '全文概览'});
      const overview = el.createEl('p', {text:article.overview, cls:'note-digest-result'});
      this.claudianContexts.set(overview, selection ? {title, source:selection.text} : {title});
      if (path) this.renderOverviewSave(el, article);
      if (article.parts.length === 1) this.renderSectionActions(el, article, 0);
    }
    if (article?.sections.length && article.parts.length > 1) {
      const heading = finished ? '分节摘要' : `部分摘要 · 已完成 ${article.sections.length}/${article.parts.length} 节`;
      el.createEl('h4', {text:heading});
      article.sections.forEach((section, index) => {
        const row = el.createDiv({cls:'note-digest-paragraph'});
        row.createEl('h5', {text:section.title, cls:'note-digest-original'});
        const part = article.parts[index];
        const summary = row.createEl('p', {text:section.summary, cls:'note-digest-result'});
        this.claudianContexts.set(summary, {title:`${title} · ${section.title}`, source:article.source.slice(part.start, part.end).trim()});
        this.renderSectionActions(row, article, index);
      });
    }
    if (article && finished) {
      const actions = el.createDiv({cls:'note-digest-actions'});
      const regenerate = actions.createEl('button', {text:'重新生成'});
      regenerate.onclick = () => { void this.plugin.retryDigest(article, true); };
    }
    if (path && !running) this.renderCollection(path);
  }
  private renderSectionActions(parent: HTMLElement, article: ArticleSummary, index: number): void {
    const actions = parent.createDiv({cls:'note-digest-actions'});
    if (articlePartIsLocated(article)) {
      const locate = actions.createEl('button', {text:'定位原文'});
      locate.onclick = () => { void this.plugin.revealArticlePart(article, article.parts[index]); };
    }
    const translate = actions.createEl('button', {text:'翻译本节'});
    translate.onclick = () => { void this.plugin.translateSection(article, index, this.contentEl.scrollTop); };
  }
  renderSectionTranslation(article: ArticleSummary, index: number, scroll: number, paragraphs: ParagraphTranslation[],
    status = '', running = false): void {
    const el = this.startRender();
    el.scrollTop = 0;
      this.renderToolbar(el);
    const actions = el.createDiv({cls:'note-digest-actions'});
    const back = actions.createEl('button', {text:'返回摘要'});
    back.onclick = () => { void this.plugin.returnToDigest(this, article, scroll); };
    if (!running) {
      const regenerate = actions.createEl('button', {text:paragraphs.length ? '重新生成' : '重试翻译'});
      regenerate.onclick = () => { void this.plugin.translateSection(article, index, scroll, !!paragraphs.length); };
    }
    el.createEl('h3', {text:article.sections[index]?.title || '本节翻译'});
    if (status) el.createEl('p', {text:status, cls:'note-digest-result', attr:{role:'status','aria-live':'polite'}});
    for (const {source, translation} of paragraphs) {
      const pair = el.createDiv({cls:'note-digest-paragraph'});
      pair.createEl('p', {text:source, cls:'note-digest-original'});
      pair.createEl('p', {text:translation, cls:'note-digest-result'});
      this.claudianContexts.set(pair, {source});
    }
  }
  private renderOverviewSave(el: HTMLElement, article: ArticleSummary): void {
    const actions = el.createDiv({cls:'note-digest-actions'});
    const button = actions.createEl('button', {text:'添加到文首'});
    const revision = this.renderRevision;
    button.onclick = async () => {
      button.disabled = true;
      try {
        const saved = await this.plugin.saveOverview(article);
        if (revision !== this.renderRevision) return;
        if (saved.receipt && this.selectionView && 'path' in this.selectionView) {
          this.selectionView = rebaseSelectionAfterInsertion(this.selectionView, saved.receipt) ?? this.selectionView;
        }
        this.renderArticleSummary(article.path, saved.article, saved.receipt ? '已添加到文首。' : '文首已有这份摘要。');
      } catch (error) {
        if (revision !== this.renderRevision) return;
        this.renderArticleSummary(article.path, article, error instanceof Error ? error.message : '写入失败。');
      }
    };
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
    const located = canCollectSelection(selection);
    const el=this.contentEl.createDiv({cls:'note-digest-save'});
    el.createEl('h3',{text:'收藏到学习笔记'});
    const targetLabel=el.createEl('label',{text:'保存位置 '});
    const target=targetLabel.createEl('select',{attr:{'aria-label':'收藏保存位置'}});
    if (located) {
      target.createEl('option',{value:'both',text:'末尾及独立笔记'});
      target.createEl('option',{value:'source',text:'只有末尾'});
    } else {
      el.createEl('p',{text:'无法确认选区在原文中的位置，仍可保存到独立学习笔记。',cls:'note-digest-muted'});
    }
    target.createEl('option',{value:'note',text:'只有独立学习笔记'});
    target.value=located ? 'both' : 'note';
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
    if (mode === 'explain' && kind && located) {
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
        row.createEl('p',{text:record.kind === 'word' ? explanationHeadword(record.anchor.text,record.result) : record.anchor.text});
        row.createEl('p',{text:record.result.translation,cls:'note-digest-saved-translation'});
        let remove: HTMLButtonElement | undefined;
        if (!record.unlocated) {
          const locate=row.createEl('button',{text:'定位原文'});
          locate.onclick=()=>{void this.plugin.revealRecord(path,record.id);};
          const cancel=row.createEl('button',{text:'取消收藏高亮'});
          cancel.disabled=!record.active;
          cancel.onclick=async()=>{
            cancel.disabled=true;
            try { await this.plugin.removeHighlight(record.id);this.renderCollection(path); }
            catch { cancel.disabled=false;cancel.textContent='取消失败，点击重试'; }
          };
          remove=cancel;
        }
        if (!record.active) row.createEl('p',{text:record.deletionPending?'删除尚未完成，可重试':'已取消高亮，学习笔记保留',cls:'note-digest-muted'});
        const erase=row.createEl('button',{text:record.unlocated ? '删除学习卡片' : '取消高亮并删除笔记'});
        const message=row.createEl('p',{cls:'note-digest-result',attr:{role:'status','aria-live':'polite'}});
        erase.onclick=async()=>{
          erase.disabled=true;if(remove) remove.disabled=true;message.textContent='正在检查并删除对应卡片…';
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

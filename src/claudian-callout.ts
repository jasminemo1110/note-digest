import { canCollectSelection, type SelectionSnapshot } from './core';
import { insertionTarget, markdownBody, markdownStructure } from './markdown-source';

export const CLAUDIAN_VIEW = 'claudian-view';
const saveButtonClass = 'note-digest-save-claudian';
const responseSelector = '.claudian-message[data-role="assistant"][data-message-id]';
const saveActions = [
  ['exchange', '将问答存为原句批注'],
  ['answer', '仅答案存为原句批注'],
] as const;
export type ClaudianSaveMode = typeof saveActions[number][0];

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  displayContent?: string;
  contentBlocks?: {type: string; content?: string}[];
  turnId?: string;
  isInterrupt?: boolean;
  isRebuiltContext?: boolean;
  isAutomaticResponse?: boolean;
}

interface ClaudianView {
  getActiveTab?(): {dom?: {messagesEl?: HTMLElement}; state?: {messages?: ChatMessage[]}} | null;
}

export interface ClaudianNote { question?: string; answer: string }

function responseActions(message: Element): Element | null {
  const actions = message.querySelector(':scope > .claudian-message-actions');
  return actions?.querySelector(':scope > .claudian-text-copy-btn') ? actions : null;
}

/** Claudian's public API only reads the latest reply. Match the clicked, finished
 * response to the active transcript of its own view using Claudian's message ID. */
export function readClaudianNote(view: object, message: HTMLElement, mode: ClaudianSaveMode): ClaudianNote | undefined {
  const tab = (view as ClaudianView).getActiveTab?.();
  if (!responseActions(message) || message.closest('.claudian-messages') !== tab?.dom?.messagesEl) return;
  const messages = tab?.state?.messages;
  if (!Array.isArray(messages)) return;
  const index = messages.findIndex(entry => entry.id === message.dataset.messageId);
  const response = messages[index];
  if (response?.role !== 'assistant' || response.isInterrupt || response.isAutomaticResponse) return;
  // An interrupted turn can have a response row before its interrupt marker.
  if (messages[index + 1]?.isInterrupt) return;
  const blocks = response.contentBlocks;
  let answer = response.content;
  if (Array.isArray(blocks) && blocks.length) {
    let start = blocks.length;
    while (start > 0 && ['text', 'citations'].includes(blocks[start - 1].type)) start--;
    answer = blocks.slice(start).filter(block => block.type === 'text').map(block => block.content ?? '').join('\n\n');
  }
  if (typeof answer !== 'string' || !answer.trim()) return;
  if (mode === 'answer') return {answer};

  let question: ChatMessage | undefined;
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i].isRebuiltContext) {
      question = messages[i];
      break;
    }
  }
  if (!question || question.isInterrupt || (question.turnId && response.turnId && question.turnId !== response.turnId)) return;
  const questionText = typeof question.displayContent === 'string' ? question.displayContent : visibleQuestion(message, question.id);
  if (questionText?.trim()) return {question: questionText, answer};
}

function visibleQuestion(response: HTMLElement, id: string): string | undefined {
  for (let row = response.previousElementSibling; row; row = row.previousElementSibling) {
    if (!row.matches('.claudian-message[data-role="user"]')) continue;
    if (row.getAttribute('data-message-id') !== id) return;
    return row.querySelector<HTMLElement>(':scope > .claudian-message-content > .claudian-text-block')?.innerText;
  }
}

/** Observe only Claudian's pane. Its own final copy action signals a completed reply. */
export function watchClaudian(root: HTMLElement, save: (message: HTMLElement, mode: ClaudianSaveMode) => void): () => void {
  const addButtons = (message: HTMLElement) => {
    const actions = responseActions(message);
    if (!actions || actions.querySelector('.' + saveButtonClass)) return;
    for (const [mode, label] of saveActions) {
      const button = root.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = saveButtonClass;
      button.textContent = label;
      button.title = '先在原文选中一句，再点击保存';
      button.onmousedown = event => event.preventDefault();
      button.onclick = event => {
        event.stopPropagation();
        save(message, mode);
      };
      actions.append(button);
    }
  };
  root.querySelectorAll<HTMLElement>(responseSelector).forEach(addButtons);
  const Observer = root.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
  const observer = new Observer(records => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1 || !root.contains(node)) continue;
        const element = node as HTMLElement;
        if (element.classList.contains(saveButtonClass)) continue;
        const message = element.closest<HTMLElement>(responseSelector);
        if (message) addButtons(message);
        else element.querySelectorAll<HTMLElement>(responseSelector).forEach(addButtons);
      }
    }
  });
  observer.observe(root, {childList: true, subtree: true});
  return () => {
    observer.disconnect();
    root.querySelectorAll('.' + saveButtonClass).forEach(button => button.remove());
  };
}

function quoteLines(text: string, newline: string): string {
  // Keep ordinary emphasis and lists. Escape HTML, embeds, footnotes, and
  // special Markdown that could activate another plugin in the saved note.
  const escapes: Record<string, string> = {'<': '&lt;', '>': '&gt;', '&': '&amp;'};
  return text.trim().split(/\r\n|\r|\n/).map(line => {
    const safe = line.replace(/[^\S\r\n]+$/g, '')
      .replace(/[^\S\r\n]/g, ' ')
      .replace(/[<>&\[\]`%$~]/g, char => escapes[char] ?? `&#${char.charCodeAt(0)};`);
    return safe ? '> ' + safe : '>';
  }).join(newline);
}

export function insertClaudianCallout(current: string, selection: SelectionSnapshot, note: ClaudianNote): string {
  if (current !== selection.source || !canCollectSelection(selection)) throw new Error('原文选区已变化，请重新选中原句。');
  const target = insertionTarget(current, selection, 'below');
  if (!target) throw new Error('请在正文的普通段落内选中原句。');
  const {question, answer} = note;
  const label = question === undefined ? '答案' : '问答';
  if (question?.trim() === '' || !answer.trim() || (question?.length ?? 0) + answer.length > 40_000) {
    throw new Error(`${label}为空或过长，无法插入。`);
  }
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const block = (question === undefined ? [
    '> [!note]- Claudian 回答',
    quoteLines(answer, newline),
  ] : [
    '> [!question]- Claudian 问答',
    '> **我的提问**',
    '>',
    quoteLines(question, newline),
    '>',
    '> **Claudian 回答**',
    '>',
    quoteLines(answer, newline),
  ]).join(newline);
  const following = current.slice(target.offset);
  if (following.trimStart().startsWith(block + newline) || following.trimStart() === block) {
    throw new Error(`${label}已在原句下方。`);
  }
  // Existing blank lines can supply the paragraph break after the callout.
  const breakAfter = following.trim() && !/^(?:[ \t]*\r?\n){2}/.test(following) ? newline + newline : '';
  const updated = current.slice(0, target.offset) + newline + newline + block + breakAfter + following;
  const parsed = markdownBody(updated);
  const [inserted] = parsed.children.splice(target.index + 1, 1);
  if (inserted?.type !== 'blockquote' || markdownStructure(parsed) !== markdownStructure(target.tree)) {
    throw new Error('选区附近的 Markdown 结构无法安全插入，请换一个普通段落。');
  }
  return updated;
}

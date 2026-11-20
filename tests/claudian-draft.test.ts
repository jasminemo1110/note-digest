import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { App, WorkspaceLeaf } from 'obsidian';
import { appendClaudianDraft } from '../src/claudian-draft';

function chat(shown: boolean) {
  let tab = {};
  let draft = '已有草稿';
  const leaf = {
    view: {
      containerEl: {isShown: () => shown},
      getActiveTab: () => tab,
      appendToActiveInput: (text: string) => {
        draft += text;
        return true;
      },
    },
  } as unknown as WorkspaceLeaf;
  return {leaf, draft: () => draft, switchTab: () => { tab = {}; }};
}

function host(leaves: WorkspaceLeaf[], revealLeaf: (leaf: WorkspaceLeaf) => void, activateView?: () => Promise<void>): App {
  return {
    workspace:{getLeavesOfType: () => leaves, revealLeaf: async (leaf: WorkspaceLeaf) => revealLeaf(leaf)},
    plugins:{getPlugin: (id: string) => id === 'realclaudian' ? {views:{activateView}} : null},
  } as unknown as App;
}

test('reveals the last used Claudian pane and appends to its draft', async () => {
  const visible = chat(true);
  const recent = chat(false);
  const app = host([visible.leaf, recent.leaf], leaf => assert.equal(leaf, recent.leaf));
  await appendClaudianDraft(app, {source:'A compelling argument.', text:'有说服力的'}, recent.leaf);
  assert.equal(recent.draft(), '已有草稿\n\n【英文原文】\nA compelling argument.\n\n【选中的 Note Digest 内容】\n有说服力的\n\n【我的追问】\n');
  assert.equal(visible.draft(), '已有草稿');
});

test('opens a closed Claudian pane and refuses to append when the destination tab changes', async () => {
  const destination = chat(false);
  const leaves: WorkspaceLeaf[] = [];
  const app = host(leaves, () => destination.switchTab(), async () => { leaves.push(destination.leaf); });
  await assert.rejects(appendClaudianDraft(app, {text:'有说服力的'}), /对话已切换/);
  assert.equal(destination.draft(), '已有草稿');
});

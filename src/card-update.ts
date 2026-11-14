/** Match only whole generated paragraphs. Gaps between matches belong to the user. */
export function mergeCardBody(current: string, previous: string, updated: string): string | undefined {
  if (current === previous) return updated;
  // A manual code fence can make a copied paragraph look like a generated field.
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(current)) return;
  const oldParts = previous.trim().split('\n\n');
  const newParts = updated.trim().split('\n\n');
  const blocks = [...current.matchAll(/[^\n](?:(?!\n\n)[\s\S])*?(?=\n\n|\n?$)/g)];
  const positions: number[] = [];
  let cursor = 0;
  for (const part of oldParts) {
    while (cursor < blocks.length && blocks[cursor][0] !== part) cursor++;
    if (cursor === blocks.length) return;
    positions.push(cursor++);
  }
  cursor = blocks.length - 1;
  for (let index = oldParts.length - 1; index >= 0; index--) {
    while (cursor >= 0 && blocks[cursor][0] !== oldParts[index]) cursor--;
    if (cursor !== positions[index]) return;
    cursor--;
  }

  // Keep the unchanged generated paragraphs as anchors so notes stay near their original fields.
  const patches: {start: number; end: number; text: string}[] = [];
  let oldStart = 0;
  let newStart = 0;
  for (let index = 0; index <= oldParts.length; index++) {
    const next = index === oldParts.length ? newParts.length : newParts.indexOf(oldParts[index], newStart);
    if (next < 0) continue;
    const replacements = newParts.slice(newStart, next);
    const oldCount = index - oldStart;
    for (let relative = 0; relative < oldCount; relative++) {
      const block = blocks[positions[oldStart + relative]];
      const text = relative === oldCount - 1 ? replacements.slice(relative).join('\n\n') : replacements[relative] ?? '';
      patches.push({start:block.index, end:block.index + block[0].length, text});
    }
    if (!oldCount && replacements.length) {
      const following = blocks[positions[index]];
      const position = following?.index ?? current.trimEnd().length;
      patches.push({start:position, end:position, text:following ? replacements.join('\n\n') + '\n\n' : '\n\n' + replacements.join('\n\n')});
    }
    oldStart = index + 1;
    newStart = next + 1;
  }
  let merged = current;
  for (const {start,end,text} of patches.reverse()) merged = merged.slice(0,start) + text + merged.slice(end);
  return merged;
}

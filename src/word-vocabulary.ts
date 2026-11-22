import { frontmatterEnd } from './anchors';
import type { DictionarySense } from './core';

export function wordNoteBody(note: string): string {
  return note.slice(frontmatterEnd(note));
}

export function addWordVocabulary(note: string, word: string, senses: DictionarySense[] = [], pronunciation?: string | null): string {
  const labels = senses.map(sense => senses.some(other => other !== sense && other.partOfSpeech === sense.partOfSpeech)
    ? `${sense.partOfSpeech}（${sense.pronunciation ?? '读音待核对'}）` : sense.partOfSpeech);
  const singlePronunciation = senses[0]?.pronunciation ?? pronunciation;
  const properties = {
    digest_word: word,
    digest_pos: [...new Set(senses.map(sense => sense.partOfSpeech))],
    digest_ipa: senses.length > 1
      ? senses.flatMap(sense => sense.pronunciation ? [`${sense.partOfSpeech} · ${sense.pronunciation}`] : [])
      : singlePronunciation ? [singlePronunciation] : [],
    digest_meaning: senses.map((sense, index) => senses.length === 1 ? sense.meaning : `${labels[index]} · ${sense.meaning}`),
    digest_has_cards: true,
  };
  const end = frontmatterEnd(note);
  const metadata = note.slice(0, end);
  const start = note.startsWith('\uFEFF') ? 1 : 0;
  const newline = note.includes('\r\n') ? '\r\n' : '\n';
  const lines = Object.entries(properties)
    .filter(([key]) => !new RegExp(`^(?:${key}|"${key}"|'${key}')[ \\t]*:`, 'm').test(metadata))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}${newline}`).join('');
  if (!lines) return note;
  if (end === start) return note.slice(0, start) + `---${newline}${lines}---${newline}` + note.slice(start);
  const openingEnd = note.indexOf('\n') + 1;
  return note.slice(0, openingEnd) + lines + note.slice(openingEnd);
}

export function markWordNoteCards(note: string, hasCards: boolean): string {
  const end = frontmatterEnd(note);
  const metadata = note.slice(0, end).replace(/^digest_has_cards: (true|false)(?=\r?$)/m, `digest_has_cards: ${hasCards}`);
  return metadata + note.slice(end);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleBody, LEARNING_BOUNDARY } from '../src/anchors';
import { articleFinished, overviewInsertion, planArticleSummary, planSelectedSummary, rebaseAfterOverview, sectionSource, type ArticleSummary } from '../src/article-summary';
import { readingSnapshot, snapshot } from '../src/core';
import { summarizeArticle, translateArticlePart, type Transport } from '../src/provider';
import { ResultCache } from '../src/result-cache';

test('full article ranges follow headings and cover the exact body, excluding frontmatter and generated notes', () => {
  const properties = '\uFEFF---\r\ntitle: Hidden property\r\n---\r\n';
  const body = '# First\r\n\r\n```md\r\n# Heading in code\r\n```\r\n\r\n## Second\r\nSecond paragraph.';
  const source = properties + body + LEARNING_BOUNDARY + 'Generated learning note';
  const article = planArticleSummary('clipping.md', source);
  assert.equal(article.parts[0].start, properties.length);
  assert.deepEqual(article.parts.map(part => source.slice(part.start, part.end)), [
    '# First\r\n\r\n```md\r\n# Heading in code\r\n```\r\n\r\n', '## Second\r\nSecond paragraph.'
  ]);
  assert.throws(() => planArticleSummary('empty.md', properties), /没有可总结/);
});

test('a heading-free long clipping splits at paragraphs and handles a single oversize paragraph without truncation', () => {
  const paragraphs = Array.from({length: 90}, (_, i) => `Paragraph ${i}. ` + 'The article continues. '.repeat(17).trim());
  const body = paragraphs.join('\n \n');
  const ranges = planArticleSummary('clipping.md', body).parts;
  assert.ok(ranges.length > 1 && ranges.length < paragraphs.length);
  for (const {start, end} of ranges) {
    assert.ok(end - start <= 6000);
    assert.match(body.slice(start, end), /^Paragraph /);
  }
  assert.equal(ranges.map(part => body.slice(part.start, part.end)).join(''), body);

  const unbroken = 'x'.repeat(5999) + '🚀' + 'x'.repeat(12001);
  const pieces = planArticleSummary('single.md', unbroken).parts.map(part => unbroken.slice(part.start, part.end));
  assert.equal(pieces.join(''), unbroken);
  assert.ok(pieces.every(piece => piece.length <= 6000));
  assert.ok(pieces[1].startsWith('🚀'));
});

test('failure retains completed sections, retry sends only remaining body and then the ordered summaries', async () => {
  const article = planArticleSummary('source.md', '---\ntitle: Metadata\n---\n# First\n\nOne.\n\n# Second\n\nTwo.' + LEARNING_BOUNDARY + 'Learning record');
  const inputs: object[] = [];
  const first = {title: '第一节', summary: '第一节内容'};
  const second = {title: '第二节', summary: '第二节内容'};
  const overview = {summary: '全文概览'};
  const transport: Transport = async request => {
    inputs.push(JSON.parse(JSON.parse(request.body as string).messages[1].content));
    const output = [first, {title: '', summary: '无效'}, second, overview][inputs.length - 1];
    return {status: 200, json: {choices: [{finish_reason: 'stop', message: {content: JSON.stringify(output)}}]}};
  };
  let latest: ArticleSummary = article;
  const receive = (update: ArticleSummary) => { latest = update; };
  await assert.rejects(summarizeArticle(article, 'test', transport, async () => {}, receive), /格式异常/);
  assert.deepEqual(latest.sections, [first]);
  assert.equal(latest.overview, undefined);
  await summarizeArticle(latest, 'test', transport, async () => {}, receive);
  assert.deepEqual(inputs, [
    {section: '# First\n\nOne.\n\n'}, {section: '# Second\n\nTwo.'}, {section: '# Second\n\nTwo.'}, {sections: [first, second]}
  ]);
  assert.equal(latest.overview, overview.summary);
});

test('a stopped or changed source cannot publish a response or start the next request', async () => {
  const article = planArticleSummary('source.md', '# First\nOne.\n# Second\nTwo.');
  let current = true;
  let requests = 0;
  const transport: Transport = async () => {
    requests++;
    current = false;
    return {status: 200, json: {choices: [{finish_reason: 'stop', message: {content: '{"title":"一","summary":"第一节"}'}}]}};
  };
  await assert.rejects(summarizeArticle(article, 'test', transport, async () => {
    if (!current) throw new Error('原文已变更');
  }, () => assert.fail('stale result was rendered')), /原文已变更/);
  assert.equal(requests, 1);
});

const interview = 'A brief introduction.\n\n**Q&A: What changed?**\n\nR: The first thing changed.\n\nThe second thing followed.\n\n**Q&A: What next?**\n\nR: We wait.';

test('whole article and selected range recognize complete interview exchanges', () => {
  const properties = '---\ntitle: Interview\n---\n';
  const source = properties + interview;
  const whole = planArticleSummary('source.md', source);
  assert.equal(whole.parts.length, 3);
  assert.equal(source.slice(whole.parts[1].start, whole.parts[1].end).trim(),
    '**Q&A: What changed?**\n\nR: The first thing changed.\n\nThe second thing followed.');
  assert.deepEqual(planSelectedSummary(snapshot('source.md', source, source)), whole);
  const rendered = interview.replaceAll('**', '');
  assert.deepEqual(planSelectedSummary(readingSnapshot('source.md', source, rendered)), whole);
  const short = planSelectedSummary(snapshot('source.md', source, 'We wait.'));
  assert.equal(short.parts.length, 1);
  const lastQuestions = interview.slice(interview.indexOf('**Q&A'));
  assert.equal(planSelectedSummary(snapshot('source.md', source, lastQuestions)).parts.length, 2);
});

test('saving the overview is idempotent, keeps frontmatter byte-for-byte and rebases without changing the body', () => {
  for (const eol of ['\n', '\r\n']) {
    const properties = ['---', 'title: Interview', '---', ''].join(eol);
    const source = properties + interview.replaceAll('\n', eol);
    let article = {...planArticleSummary('source.md', source), overview:'概览 <script>\n[!note] 注释'};
    const receipt = overviewInsertion(source, article)!;
    assert.equal(receipt.after.slice(0, properties.length), properties);
    assert.match(receipt.after, /> \[!note-digest-summary\]\+ 中文摘要/);
    assert.doesNotMatch(receipt.after, /<script>/);
    article = rebaseAfterOverview(article, receipt) as typeof article;
    assert.equal(overviewInsertion(receipt.after, article), undefined);
    assert.deepEqual(planArticleSummary('source.md', receipt.after).parts, article.parts);
    assert.equal(article.parts.map(part => receipt.after.slice(part.start, part.end)).join(''), source.slice(properties.length));
    assert.doesNotMatch(articleBody(receipt.after), /概览/);
    assert.throws(() => overviewInsertion(receipt.after + 'another edit', article), /原文已修改/);
    const selected = planSelectedSummary(snapshot('source.md', receipt.after, 'We wait.'));
    const second = overviewInsertion(receipt.after, {...selected, overview:'短选段概览'})!;
    assert.match(second.after, /> \[!note-digest-summary\]\+ 选段摘要/);
    assert.deepEqual(planArticleSummary('source.md', second.after).parts.map(part => second.after.slice(part.start, part.end)),
      article.parts.map(part => receipt.after.slice(part.start, part.end)));
  }
});

test('long selection returns section summaries only and reuses work from the full article', async () => {
  const cache = new ResultCache({load: () => null, save: () => {}});
  const source = '---\ntitle: Interview\n---\n' + interview;
  const full = planArticleSummary('source.md', source);
  const selected = planSelectedSummary(snapshot('source.md', source, interview.slice(interview.indexOf('**Q&A'))));
  let calls = 0;
  const transport: Transport = async request => {
    calls++;
    const input = JSON.parse(JSON.parse(request.body as string).messages[1].content);
    const output = 'section' in input ? {title:'小节',summary:'主旨'} : {summary:'全文概览'};
    return {status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify(output)}}]}};
  };
  await summarizeArticle(full, 'test', transport, async () => {}, () => {}, {cache});
  assert.equal(calls, 4);
  let latest = selected;
  await summarizeArticle(selected, 'test', transport, async () => {}, article => { latest = article; }, {
    cache, onRequest: () => assert.fail('existing sections should be reused'),
  });
  assert.equal(latest.overview, undefined);
  assert.equal(latest.sections.length, 2);
  assert.ok(articleFinished(latest));
  assert.equal(calls, 4);
});

test('translation requests a single section and aligns locally even if the AI reorders paragraphs', async () => {
  const article = planArticleSummary('source.md', interview);
  let calls = 0;
  const cache = new ResultCache({load: () => null, save: () => {}});
  const transport: Transport = async request => {
    calls++;
    const {paragraphs} = JSON.parse(JSON.parse(request.body as string).messages[1].content);
    assert.deepEqual(paragraphs.map(({text}: {text: string}) => text), [
      'Q&A: What changed?', 'R: The first thing changed.', 'The second thing followed.',
    ]);
    const output = {translations: [{id:2,translation:'随后发生。'}, {id:0,translation:'发生了什么？'}, {id:1,translation:'第一件事发生了。'}]};
    return {status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify(output)}}]}};
  };
  const run = () => translateArticlePart(article, article.parts[1], 'test', transport, {cache});
  const [first] = await run();
  assert.equal(first.source, 'Q&A: What changed?');
  assert.equal(first.translation, '发生了什么？');
  assert.equal(article.source.slice(first.start, first.end), '**Q&A: What changed?**');
  await run();
  assert.equal(calls, 1);
});

test('trailing Notes and References are separate reading modules and never sent for the article overview', async () => {
  const body = 'Opening body.\n\n## Next\n\nFinal body.';
  const notes = '**Notes**  \n\n' + Array.from({length:7}, (_, i) =>
    `\\[${i + 1}\\] Supporting material. ` + 'An additional note. '.repeat(20)).join('\n\n');
  const source = body + '\n\n' + notes + '\n\nReferences\n----------\n\nA source.';
  const article = planArticleSummary('source.md', source);
  assert.deepEqual(article.supplements?.map(part => part.label), ['Notes','References']);
  assert.equal(sectionSource(article, article.supplements![0]).text.trim(), notes.trim());
  assert.deepEqual(planArticleSummary('a.md', '# Notes\n\nAn opening thought.\n\n# Next\n\nMain article.').supplements, undefined);
  assert.deepEqual(planArticleSummary('a.md', 'Opening body.\n\n## Notes\n\nAn aside.\n\n## Next\n\nMain article.').supplements, undefined);
  const seen: string[] = [];
  const transport: Transport = async request => {
    seen.push(JSON.parse(request.body as string).messages[1].content);
    const output = {title:'小节', summary:'主旨'};
    return {status:200, json:{choices:[{finish_reason:'stop', message:{content:JSON.stringify(output)}}]}};
  };
  await summarizeArticle(article, 'test', transport, async () => {}, () => {});
  assert.equal(seen.length, 3);
  assert.ok(seen.every(input => !/Supporting material|A source\./.test(input)));
});

test('named Markdown sections stay together up to the request limit', () => {
  const heading = 'An explicit section\n===================\n\n';
  const body = (Array.from({length:6}, () => 'Here is another sentence. '.repeat(22).trim())).join('\n\n');
  const source = heading + body + '\n\n## Next section\n\nAnother thought.';
  const article = planArticleSummary('a.md', source);
  assert.equal(article.parts.length, 2);
  assert.equal(sectionSource(article, article.parts[0]).text.trim(), (heading + body).trim());
});

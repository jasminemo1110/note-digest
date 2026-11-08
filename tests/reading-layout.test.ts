import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectionParagraphs,isLongSelection,showAssessment} from '../src/reading-layout';
import {snapshot,validateResult} from '../src/core';
import {translateParagraphs,digest,type Transport} from '../src/provider';

test('long selection waits for an action; paragraph ranges keep original characters and offsets',()=>{
  assert.equal(isLongSelection('emerge'),false);
  assert.equal(isLongSelection('a'.repeat(401)),true);
  const text='First paragraph.\r\n\r\nSecond paragraph.\ncontinued line.';
  const selected=snapshot('a.md','Heading\n\n'+text,text);
  assert.equal(isLongSelection(text),true);
  const parts=selectionParagraphs(selected);assert.equal(parts.length,2);
  assert.equal(parts[1].source,'Second paragraph.\ncontinued line.');
  for(const part of parts) assert.equal(selected.source.slice(part.start,part.end),part.source);
});
test('only problematic/uncertain usage gets an assessment section',()=>{
  for(const status of ['natural','informal'] as const) assert.equal(showAssessment({status,explanation:'说明',correction:null}),false);
  for(const status of ['incorrect','unnatural','uncertain'] as const) assert.equal(showAssessment({status,explanation:'说明',correction:null}),true);
});
test('paragraph translation aligns source locally and reports progress',async()=>{
  const selected=snapshot('a.md','First.\n\nSecond.','First.\n\nSecond.');let count=0;const progress:number[]=[];
  const transport:Transport=async request=>{
    const text=JSON.parse(JSON.parse(request.body as string).messages[1].content).selected;
    assert.equal(text,count++===0?'First.':'Second.');
    return {status:200,json:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({translation:text==='First.'?'第一。':'第二。'})}}]}};
  };
  const result=await translateParagraphs(selected,'fake',transport,()=>true,done=>progress.push(done));
  assert.deepEqual(result.paragraphs?.map(p=>[p.source,p.translation]),[['First.','第一。'],['Second.','第二。']]);
  assert.equal(result.translation,'第一。\n\n第二。');assert.deepEqual(progress,[0,1,2]);
});
test('superseded paragraph operation stops further requests and cannot return a full result',async()=>{
  let current=true;let count=0;const selected=snapshot('a.md','First.\n\nSecond.','First.\n\nSecond.');
  const transport:Transport=async()=>{count++;current=false;return {status:200,json:{choices:[{finish_reason:'stop',message:{content:'{"translation":"第一"}'}}]}};};
  await assert.rejects(translateParagraphs(selected,'fake',transport,()=>current),/取消/);assert.equal(count,1);
});
test('summary is explicitly selected-text only, validated, and cannot be saved as a translation',async()=>{
  const selected=snapshot('a.md','First.','First.');
  const transport:Transport=async request=>{
    assert.match(JSON.parse(request.body as string).messages[0].content,/Summarize only the selected text/);
    return {status:200,json:{choices:[{finish_reason:'stop',message:{content:'{"summary":"所选内容概述"}'}}]}};
  };
  const result=await digest(selected,'summarize','fake',transport);
  assert.equal(result.summary,'所选内容概述');assert.throws(()=>validateResult(result,'translate'));
  assert.throws(()=>validateResult({summary:'x'.repeat(6001)},'summarize'));
});

test('whitespace-only blank lines are paragraph boundaries without changing source offsets',()=>{
  const text='First.\n \n\nSecond.';const selected=snapshot('a.md',text,text);
  const parts=selectionParagraphs(selected);assert.equal(parts.length,2);
  assert.equal(parts[1].source,'Second.');assert.equal(text.slice(parts[1].start,parts[1].end),'Second.');
});

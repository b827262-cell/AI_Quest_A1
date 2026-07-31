import test from 'node:test';
import assert from 'node:assert/strict';
import {quests,filterQuests,calculateProgress,recommendNext,difficultyLabel} from '../src/quest.js';

test('filters quests by keyword across content',()=>{
  const result=filterQuests(quests,{query:'偏見'});
  assert.equal(result.length,1);
  assert.equal(result[0].id,'ethics');
});

test('filters quests by difficulty',()=>{
  const result=filterQuests(quests,{difficulty:'beginner'});
  assert.ok(result.length>0);
  assert.ok(result.every(item=>item.difficulty==='beginner'));
});

test('calculates rounded completion percentage',()=>{
  assert.equal(calculateProgress(quests,[]),0);
  assert.equal(calculateProgress(quests,[quests[0].id]),17);
  assert.equal(calculateProgress(quests,quests.map(item=>item.id)),100);
});

test('recommends first incomplete quest',()=>{
  assert.equal(recommendNext(quests,[])?.id,quests[0].id);
  assert.equal(recommendNext(quests,[quests[0].id])?.id,quests[1].id);
  assert.equal(recommendNext(quests,quests.map(item=>item.id)),null);
});

test('returns localized difficulty labels',()=>{
  assert.equal(difficultyLabel('beginner'),'入門');
  assert.equal(difficultyLabel('intermediate'),'進階');
});

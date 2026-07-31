import {quests,filterQuests,calculateProgress,recommendNext,difficultyLabel} from './quest.js';

const STORAGE_KEY='ai-quest-a1-state';
const elements={
  list:document.querySelector('#quest-list'),template:document.querySelector('#quest-template'),
  search:document.querySelector('#search'),difficulty:document.querySelector('#difficulty'),
  reset:document.querySelector('#reset'),progress:document.querySelector('#progress'),
  progressValue:document.querySelector('#progress-value'),progressLabel:document.querySelector('#progress-label'),
  recommendation:document.querySelector('#recommendation'),resultCount:document.querySelector('#result-count'),
  empty:document.querySelector('#empty-state')
};

function loadState(){
  try{
    const value=JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {completed:Array.isArray(value?.completed)?value.completed:[],notes:value?.notes&&typeof value.notes==='object'?value.notes:{}};
  }catch{return {completed:[],notes:{}};}
}

let state=loadState();
const saveState=()=>localStorage.setItem(STORAGE_KEY,JSON.stringify(state));

function toggleQuest(id){
  state.completed=state.completed.includes(id)?state.completed.filter(value=>value!==id):[...state.completed,id];
  saveState();render();
}

function updateNote(id,value){state.notes[id]=value;saveState();}

function renderProgress(){
  const progress=calculateProgress(quests,state.completed);
  elements.progress.value=progress;
  elements.progress.textContent=`${progress}%`;
  elements.progressValue.textContent=`${progress}%`;
  elements.progressLabel.textContent=progress===100?'全部完成':progress===0?'尚未開始':`已完成 ${state.completed.length} / ${quests.length}`;
  const next=recommendNext(quests,state.completed);
  elements.recommendation.textContent=next?`${next.title}（約 ${next.duration} 分鐘）`:'恭喜，你已完成所有任務！';
}

function createCard(quest){
  const fragment=elements.template.content.cloneNode(true);
  const card=fragment.querySelector('.quest-card');
  const completed=state.completed.includes(quest.id);
  card.classList.toggle('completed',completed);
  fragment.querySelector('.tag').textContent=`${quest.category} · ${difficultyLabel(quest.difficulty)}`;
  fragment.querySelector('.duration').textContent=`${quest.duration} 分鐘`;
  fragment.querySelector('h3').textContent=quest.title;
  fragment.querySelector('.description').textContent=quest.description;
  const objectives=fragment.querySelector('.objectives');
  quest.objectives.forEach(text=>{const item=document.createElement('li');item.textContent=text;objectives.append(item);});
  const notes=fragment.querySelector('textarea');
  notes.value=state.notes[quest.id]??'';
  notes.addEventListener('input',event=>updateNote(quest.id,event.target.value));
  const button=fragment.querySelector('.complete-button');
  button.textContent=completed?'標記為未完成':'完成任務';
  button.setAttribute('aria-pressed',String(completed));
  button.addEventListener('click',()=>toggleQuest(quest.id));
  return fragment;
}

function render(){
  const visible=filterQuests(quests,{query:elements.search.value,difficulty:elements.difficulty.value});
  elements.list.replaceChildren(...visible.map(createCard));
  elements.resultCount.textContent=`顯示 ${visible.length} / ${quests.length} 個任務`;
  elements.empty.hidden=visible.length!==0;
  renderProgress();
}

elements.search.addEventListener('input',render);
elements.difficulty.addEventListener('change',render);
elements.reset.addEventListener('click',()=>{
  if(window.confirm('確定要清除所有完成狀態與筆記嗎？')){
    state={completed:[],notes:{}};saveState();render();
  }
});

render();

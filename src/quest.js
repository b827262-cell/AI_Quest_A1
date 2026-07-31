export const quests = [
  {id:'ai-basics',title:'認識生成式 AI',category:'AI 基礎',difficulty:'beginner',duration:15,description:'理解生成式 AI、模型與訓練資料之間的基本關係。',objectives:['用自己的話解釋生成式 AI','列出兩個適合與不適合 AI 的情境']},
  {id:'prompt-structure',title:'寫出清楚的提示',category:'提示工程',difficulty:'beginner',duration:20,description:'使用角色、任務、脈絡與輸出格式，讓提示更具體。',objectives:['完成一份四要素提示','比較修改前後的輸出差異']},
  {id:'fact-check',title:'驗證 AI 回答',category:'資訊素養',difficulty:'beginner',duration:20,description:'辨認可能的幻覺，並建立基本的交叉查證流程。',objectives:['標示回答中的可驗證主張','以兩個可靠來源進行核對']},
  {id:'ethics',title:'辨識偏見與風險',category:'AI 倫理',difficulty:'intermediate',duration:25,description:'檢視資料偏見、隱私與自動化決策可能帶來的影響。',objectives:['找出一個偏見風險','提出一項降低風險的措施']},
  {id:'workflow',title:'設計人機協作流程',category:'實作',difficulty:'intermediate',duration:30,description:'把一項日常工作拆成人類判斷與 AI 輔助的步驟。',objectives:['畫出至少四步的流程','標記必須由人類確認的節點']},
  {id:'reflection',title:'完成學習反思',category:'反思',difficulty:'intermediate',duration:15,description:'整理本次學習成果、限制與下一步行動。',objectives:['寫下三項收穫','制定一項可在本週執行的行動']}
];

export function filterQuests(items,{query='',difficulty='all'}={}){
  const normalized=query.trim().toLocaleLowerCase('zh-Hant');
  return items.filter(item=>{
    const matchesDifficulty=difficulty==='all'||item.difficulty===difficulty;
    const haystack=[item.title,item.category,item.description,...item.objectives].join(' ').toLocaleLowerCase('zh-Hant');
    return matchesDifficulty&&(!normalized||haystack.includes(normalized));
  });
}

export function calculateProgress(items,completedIds){
  if(items.length===0)return 0;
  const completed=new Set(completedIds);
  return Math.round(items.filter(item=>completed.has(item.id)).length/items.length*100);
}

export function recommendNext(items,completedIds){
  const completed=new Set(completedIds);
  return items.find(item=>!completed.has(item.id))??null;
}

export function difficultyLabel(value){
  return value==='beginner'?'入門':'進階';
}

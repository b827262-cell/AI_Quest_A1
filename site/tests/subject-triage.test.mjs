import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySubject,
  canUseLocalModel,
  subjectCategoryLabel,
} from "../app/subject-triage.ts";

test("classifySubject: IT — programming keywords", () => {
  assert.equal(classifySubject("請用 Python 寫一個排序演算法"), "IT");
  assert.equal(classifySubject("什麼是 SQL injection？"), "IT");
  assert.equal(classifySubject("請解釋資料結構與演算法"), "IT");
  assert.equal(classifySubject("前端 React 和 Vue 哪個好？"), "IT");
});

test("classifySubject: IT — information security", () => {
  assert.equal(classifySubject("資訊安全怎麼入門？"), "IT");
});

test("classifySubject: ACCOUNTING — core terms", () => {
  assert.equal(classifySubject("什麼是借貸法則？"), "ACCOUNTING");
  assert.equal(classifySubject("請問分錄怎麼寫"), "ACCOUNTING");
  assert.equal(classifySubject("資產負債表怎麼看"), "ACCOUNTING");
  assert.equal(classifySubject("什麼是複式簿記"), "ACCOUNTING");
});

test("classifySubject: OTHER — history/science/language", () => {
  assert.equal(classifySubject("三國志的故事"), "OTHER");
  assert.equal(classifySubject("唐朝的歷史"), "OTHER");
  assert.equal(classifySubject("英文文法練習"), "OTHER");
  assert.equal(classifySubject("于右任是誰？"), "OTHER");
});

test("classifySubject: UNKNOWN — ambiguous / no signal", () => {
  assert.equal(classifySubject("你好嗎？"), "UNKNOWN");
  assert.equal(classifySubject("這是什麼"), "UNKNOWN");
  assert.equal(classifySubject("哈囉"), "UNKNOWN");
});

test("classifySubject: UNKNOWN — mixed IT+ACCOUNTING", () => {
  assert.equal(classifySubject("會計資訊系統如何實作資料庫"), "UNKNOWN");
  assert.equal(classifySubject("SQL 成本分錄"), "UNKNOWN");
});

test("canUseLocalModel: only IT and ACCOUNTING", () => {
  assert.equal(canUseLocalModel("IT"), true);
  assert.equal(canUseLocalModel("ACCOUNTING"), true);
  assert.equal(canUseLocalModel("OTHER"), false);
  assert.equal(canUseLocalModel("UNKNOWN"), false);
});

test("subjectCategoryLabel: Traditional Chinese labels", () => {
  assert.equal(subjectCategoryLabel("IT"), "資訊");
  assert.equal(subjectCategoryLabel("ACCOUNTING"), "會計");
  assert.equal(subjectCategoryLabel("OTHER"), "其他科目");
  assert.equal(subjectCategoryLabel("UNKNOWN"), "未分類");
});

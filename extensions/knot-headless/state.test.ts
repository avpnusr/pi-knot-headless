import test from "node:test";
import assert from "node:assert/strict";
import { newState, askQuestion, answerQuestion, expireQuestions, logDecision } from "./core.ts";

const H2 = 2 * 3_600_000;
const s0 = () => newState(1000, "proj · demo", "claude-opus-5-5");

test("minor: logged immediately as model decision, no question, no wait", () => {
	const r = askQuestion(s0(), { question: "tabs or spaces?", recommended: "spaces", severity: "minor" }, 5000, H2);
	assert.equal(r.qid, undefined);
	assert.equal(r.state.questions.length, 0);
	assert.equal(r.state.decisions.at(-1)?.by, "model");
	assert.ok(r.state.decisions.at(-1)?.text.includes("spaces"));
	assert.equal(r.state.decidedThisRun, 1);
});

test("normal without recommended is rejected and leaves state unchanged", () => {
	const s = s0();
	const r = askQuestion(s, { question: "db?", severity: "normal" }, 5000, H2);
	assert.ok(r.error);
	assert.deepEqual(r.state, s);
});

test("normal gets a deadline now+timeout; critical has none", () => {
	let r = askQuestion(s0(), { question: "db?", options: ["a", "b"], recommended: "a", severity: "normal", why: "w" }, 5000, H2);
	assert.equal(r.qid, "Q1");
	assert.equal(r.state.questions[0].deadline, 5000 + H2);
	r = askQuestion(r.state, { question: "drop prod?", severity: "critical" }, 6000, H2);
	assert.equal(r.qid, "Q2");
	assert.equal(r.state.questions[1].deadline, undefined);
	assert.equal(r.state.nextQ, 3);
});

test("expireQuestions: not before the deadline, once at it, with default in the log; critical never", () => {
	let st = askQuestion(s0(), { question: "db?", options: ["a", "b"], recommended: "a", severity: "normal" }, 0, H2).state;
	st = askQuestion(st, { question: "deploy?", severity: "critical" }, 0, H2).state;
	let r = expireQuestions(st, H2 - 1);
	assert.equal(r.expired.length, 0);
	r = expireQuestions(st, H2);
	assert.equal(r.expired.length, 1);
	assert.equal(r.expired[0].id, "Q1");
	assert.equal(r.state.questions.length, 1);
	assert.equal(r.state.decisions.at(-1)?.by, "timeout");
	assert.ok(r.state.decisions.at(-1)?.text.includes("a"));
	r = expireQuestions(r.state, 1000 * 3_600_000);
	assert.equal(r.expired.length, 0);
	assert.equal(r.state.questions.length, 1);
});

test("answerQuestion removes the question and logs a user decision; unknown id is a no-op", () => {
	const st = askQuestion(s0(), { question: "db?", options: ["a"], recommended: "a", severity: "normal" }, 0, H2).state;
	assert.deepEqual(answerQuestion(st, "Q9", "x", "user", 1), st);
	const r = answerQuestion(st, "Q1", "postgres", "user", 10);
	assert.equal(r.questions.length, 0);
	assert.equal(r.decisions.at(-1)?.by, "user");
	assert.ok(r.decisions.at(-1)?.text.includes("postgres"));
});

test("decisions are capped at 50, newest kept", () => {
	let st = s0();
	for (let i = 0; i < 60; i++) st = logDecision(st, { ts: i, by: "system", text: `d${i}` });
	assert.equal(st.decisions.length, 50);
	assert.equal(st.decisions.at(-1)?.text, "d59");
	assert.equal(st.decisions[0].text, "d10");
});

test("reducers do not mutate their input", () => {
	const s = s0();
	const snap = JSON.stringify(s);
	askQuestion(s, { question: "q", recommended: "r", severity: "normal" }, 0, H2);
	logDecision(s, { ts: 1, by: "system", text: "x" });
	assert.equal(JSON.stringify(s), snap);
});

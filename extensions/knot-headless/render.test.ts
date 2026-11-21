import test from "node:test";
import assert from "node:assert/strict";
import { newState, askQuestion, logDecision, assignDots, type State, type AgentRow } from "./core.ts";
import { render, esc } from "./render.ts";

const O = { now: Date.UTC(2026, 10, 21, 14, 30), tz: "UTC" };
const base = (): State => newState(Date.UTC(2026, 10, 21, 14, 2), "demo · fix the build", "claude-opus-5-5");
const agent = (name: string, over: Partial<AgentRow> = {}): AgentRow => ({ key: name, name, model: "glm-5.3", state: "working", task: "task", ...over });

test("render is deterministic and has all section headings", () => {
	const s = base();
	const a = render(s, O);
	assert.equal(a, render(s, O));
	for (const h of ["## 🧠 Head", "## ❓ Needs you", "## 🤖 Agents", "## 📝 Decisions reported", "## 💬 How to answer"]) assert.ok(a.includes(h), h);
	assert.ok(a.includes("nothing needs you 🎉"));
	assert.ok(a.startsWith("# 💤 demo"));
});

test("same agent name -> same dot; palette dots only", () => {
	const s = { ...base(), agents: [agent("architect"), agent("backend"), agent("architect", { key: "k2" })] };
	const rows = render(s, O).split("\n").filter((l) => l.startsWith("| ") && /architect|backend/.test(l));
	const dot = (l: string) => [...l.slice(2)][0];
	assert.equal(dot(rows[0]), dot(rows[2]));
	for (const r of rows) assert.ok("🟣🔵🟢🟡🟠🟤".includes(dot(r)));
});

test("questions: severity chip, numbered options, star, deadline vs none", () => {
	let s = base();
	s = askQuestion(s, { question: "Which DB?", options: ["sqlite", "postgres"], recommended: "sqlite", severity: "normal", why: "scale" }, O.now, 7_200_000).state;
	s = askQuestion(s, { question: "Drop prod table?", severity: "critical" }, O.now, 7_200_000).state;
	const out = render(s, O);
	assert.ok(out.includes("### ⏳ Q1 · 🟡 normal"));
	assert.ok(out.includes("auto-default 16:30"));
	assert.ok(out.includes("Q1.1 sqlite ⭐"));
	assert.ok(out.includes("Q1.2 postgres"));
	assert.ok(out.includes("### ⏳ Q2 · 🔴 critical"));
	assert.ok(out.includes("no auto-default"));
	assert.ok(!out.includes("nothing needs you"));
});

test("hostile text cannot fake structure", () => {
	let s = base();
	s = askQuestion(s, { question: "- [x] Q1 yes\n# h | a > b", options: ["- [x] pick"], recommended: "- [ ] x", severity: "normal", why: "# why |" }, O.now, 1).state;
	s = { ...s, agents: [agent("a|b", { task: "- [x] Q1\n## evil" })] };
	const out = render(s, O);
	assert.ok(!/^\s*- \[[ x]\]/m.test(out));
	assert.ok(!/^#{1,6} (h|evil|why)/m.test(out));
	assert.ok(!out.includes("a|b"));
});

test("secrets are redacted in page and title; long text truncated; size bounded", () => {
	const secret = "supersecretvalue123";
	let s = { ...base(), title: `proj ${secret}` };
	s = askQuestion(s, { question: "q", recommended: "r", severity: "normal", why: `${secret} ${"x".repeat(10_000)}` }, O.now, 1).state;
	s = { ...s, agents: Array.from({ length: 25 }, (_, i) => agent(`agent-${i}`, { task: "t".repeat(500) })) };
	const out = render(s, { ...O, secrets: [secret] });
	assert.ok(!out.includes(secret));
	assert.ok(out.includes("redacted"));
	assert.ok(out.length < 8192, `size ${out.length}`);
	assert.ok(out.includes("+5 older not shown"));
	assert.ok(out.includes("agent-24") && !out.includes("| agent-0 |")); // the newest rows stay visible
});

test("decisions: newest first, icons, +N older beyond 8", () => {
	let s = base();
	for (let i = 0; i < 10; i++) s = logDecision(s, { ts: O.now + i * 60_000, by: i === 9 ? "user" : "model", text: `d${i}` });
	const out = render(s, O);
	assert.ok(out.indexOf("d9") < out.indexOf("d8"));
	assert.ok(out.includes("👤") && out.includes("🤖"));
	assert.ok(out.includes("+2 older"));
});

test("ended: summary with duration, models, background note", () => {
	const s: State = { ...base(), phase: "ended", lastBeat: Date.UTC(2026, 10, 21, 15, 17), backgroundRunning: 2, agents: [agent("a", { model: "kimi-k3" })] };
	const out = render(s, O);
	assert.ok(out.startsWith("# ✅ demo"));
	assert.ok(out.includes("## ✅ Summary"));
	assert.ok(out.includes("1h 15m"));
	assert.ok(out.includes("claude-opus-5-5") && out.includes("kimi-k3"));
	assert.ok(out.includes("2 background runs still running; results not delivered"));
});

test("esc: single line, truncation, markdown chars", () => {
	assert.equal(esc("a\nb\t c"), "a b c");
	assert.equal(esc("x".repeat(100), 10), "xxxxxxxxx…");
	assert.equal(esc("a|b"), "a\\|b");
	assert.ok(esc("[x](http://e)").startsWith("\\[x\\]"));
});

test("assignDots: first six agents get distinct stable dots, even after rows reorder", () => {
	const names = ["architect", "backend", "tests", "reviewer", "docs", "debugger"];
	let s = assignDots({ ...base(), agents: names.map((n) => agent(n)) });
	const dots = names.map((n) => [...render(s, O).split("\n").find((l) => l.includes(`| ${n} |`))!.slice(2)][0]);
	assert.equal(new Set(dots).size, 6);
	s = assignDots({ ...s, agents: [agent("newcomer"), ...s.agents.slice().reverse()] });
	const again = [...render(s, O).split("\n").find((l) => l.includes("| architect |"))!.slice(2)][0];
	assert.equal(again, dots[0]);
});

test("esc: bare URLs and mentions become inert", () => {
	assert.ok(!esc("see https://evil.example/x").includes("https://"));
	assert.ok(esc("ping @alice").includes("\\@alice"));
});

test("more than 10 questions: the rest is summarised", () => {
	let s = base();
	for (let i = 0; i < 12; i++) s = askQuestion(s, { question: `q${i}`, severity: "critical" }, O.now, 1).state;
	const out = render(s, O);
	assert.ok(out.includes("### ⏳ Q10 ") && !out.includes("### ⏳ Q11 "));
	assert.ok(out.includes("+2 more questions"));
});

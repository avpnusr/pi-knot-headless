import test from "node:test";
import assert from "node:assert/strict";
import { newState, askQuestion, logDecision, assignDots, type State, type AgentRow, type Orchestrator } from "./core.ts";
import { render, esc, defang } from "./render.ts";

const O = { now: Date.UTC(2026, 10, 21, 14, 30), tz: "UTC" };
const base = (): State => newState(Date.UTC(2026, 10, 21, 14, 2), "demo · fix the build", "claude-opus-5-5");
const agent = (name: string, over: Partial<AgentRow> = {}): AgentRow => ({ key: name, name, model: "glm-5.3", state: "working", task: "task", ...over });

test("render is deterministic and has all section headings", () => {
	const s = base();
	const a = render(s, O);
	assert.equal(a, render(s, O));
	for (const h of ["## 🧠 Head", "## ❓ Needs you", "## 🤖 Agents", "## 📝 Decisions reported", "## 💬 How to answer"]) assert.ok(a.includes(h), h);
	assert.ok(a.includes("no open question as of 14:02"));
	assert.ok(a.includes("an older heartbeat means this page is stale"));
	assert.ok(!a.includes("nothing needs you"));
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

test("defang: bare hosts, protocol-relative refs, raw HTML, images and mentions become inert", () => {
	assert.ok(!defang("see www.evil.example/x").includes("www."));
	assert.ok(!defang("[t][r]\n[r]: //evil.example").includes("//"));
	assert.ok(!defang("<img src=//evil.example/p.gif> a <b>tag</b>").includes("<img") && !defang("<img src=//evil.example/p.gif> a <b>tag</b>").includes("<b"));
	assert.ok(!defang("a https://evil.example b //evil.example c").includes("//"));
	const md = defang("![x](https://evil.example/p.png) ping @alice");
	assert.ok(!md.includes("![") && !md.includes("](") && !/@[a-z]/.test(md));
	assert.equal(defang("plain 3 > 2 text"), "plain 3 > 2 text"); // no backslashes everywhere
});

test("more than 10 questions: the rest is summarised", () => {
	let s = base();
	for (let i = 0; i < 12; i++) s = askQuestion(s, { question: `q${i}`, severity: "critical" }, O.now, 1).state;
	const out = render(s, O);
	assert.ok(out.includes("### ⏳ Q10 ") && !out.includes("### ⏳ Q11 "));
	assert.ok(out.includes("+2 more questions"));
});

const orch = (id: string, n: number, over: Partial<Orchestrator> = {}): Orchestrator => ({ id, n, state: "done", workers: 2, startedAt: O.now - 5 * 60_000, endedAt: O.now - 60_000, ...over });

test("no orchestrators → no group headings", () => {
	const s = { ...base(), agents: [agent("a"), agent("b")] };
	const out = render(s, O);
	assert.ok(!out.includes("### 🎛"));
	assert.ok(!out.includes("### Direct subagents"));
	assert.ok(out.includes("| | Agent | Model | State | Task |"));
});

test("one running orchestrator + one direct row", () => {
	const s = {
		...base(),
		agents: [agent("w1", { orch: "o1" }), agent("w2", { orch: "o1" }), agent("lonely")],
		orchestrators: [orch("o1", 1, { state: "running", workers: 2, endedAt: undefined })],
	};
	const out = render(s, O);
	assert.ok(out.includes("### 🎛 Orchestrator 1 · ▶ running · 2 workers"));
	assert.ok(out.includes("| | Worker | Model | State | Task |"));
	assert.ok(out.includes("### Direct subagents"));
	assert.ok(out.includes("| | Agent | Model | State | Task |"));
	assert.ok(out.indexOf("| w1 |") < out.indexOf("### Direct subagents")); // workers above the direct table
	assert.ok(out.indexOf("| lonely |") > out.indexOf("### Direct subagents"));
});

test("collapse rule: running + highest-n done expanded, older collapsed", () => {
	const s = {
		...base(),
		agents: [agent("o1w", { orch: "o1" }), agent("o2w", { orch: "o2" }), agent("o3w", { orch: "o3" }), agent("o4w", { orch: "o4" })],
		orchestrators: [orch("o1", 1, { workers: 3 }), orch("o2", 2, { workers: 2 }), orch("o3", 3, { state: "running", workers: 1, endedAt: undefined }), orch("o4", 4, { workers: 2 })],
	};
	const out = render(s, O);
	assert.ok(out.includes("### 🎛 Orchestrator 3 · ▶ running"));
	assert.ok(out.includes("### 🎛 Orchestrator 4 · ✅ done"));
	assert.ok(out.includes("- ✅ Orchestrator 1 · 3 workers · 4 min"));
	assert.ok(out.includes("- ✅ Orchestrator 2"));
	assert.ok(out.indexOf("- ✅ Orchestrator 1") < out.indexOf("### 🎛 Orchestrator 3")); // bullets first
	assert.ok(!out.includes("### 🎛 Orchestrator 1"));
	assert.ok(!out.includes("| o1w |"));
	assert.ok(!out.includes("| o2w |"));
	assert.ok(out.includes("| o3w |") && out.includes("| o4w |"));
});

test("failed + truncated orchestrator", () => {
	const s = {
		...base(),
		agents: [agent("w", { orch: "o1" })],
		orchestrators: [orch("o1", 1, { state: "failed", workers: 8, truncated: true })],
	};
	const out = render(s, O);
	assert.ok(out.includes("### 🎛 Orchestrator 1 · ❌ failed · 8+ workers")); // capped worker count + truncation marker
	assert.ok(out.indexOf("_+ more workers not shown_") > out.indexOf("| w |"));
});

test("hostile text in the new tables is escaped and redacted", () => {
	const secret = "supersecretvalue123";
	const s = {
		...base(),
		agents: [agent("a|b", { orch: "o1", task: "- [x] Q1\n## evil | pipe" }), agent("keeper", { task: `${secret} done` })],
		orchestrators: [orch("o1", 1, { state: "running", endedAt: undefined })],
	};
	const out = render(s, { ...O, secrets: [secret] });
	assert.ok(!/^\s*- \[[ x]\]/m.test(out));
	assert.ok(!/^#{1,6} evil/m.test(out));
	assert.ok(!out.includes(secret));
	assert.ok(out.includes("redacted"));
	assert.ok(!out.includes("a|b"));
});

test("bounded: 12 orchestrators and 30 rows stay under 8 KB", () => {
	const orchs: Orchestrator[] = [];
	const agents: AgentRow[] = [];
	for (let i = 1; i <= 12; i++) {
		const running = i === 7;
		orchs.push(orch(`o${i}`, i, { state: running ? "running" : "done", workers: 2 + (i % 2), endedAt: running ? undefined : O.now - (i - 1) * 60_000 }));
		for (let j = 0; j < 2 + (i % 2); j++) agents.push(agent(`w${i}-${j}`, { orch: `o${i}`, task: "t".repeat(500) }));
	}
	assert.equal(agents.length, 30);
	const out = render({ ...base(), agents, orchestrators: orchs }, O);
	assert.ok(out.length < 8192, `size ${out.length}`);
});

test("collapse rule: done orchestrators below a running one — the highest-n done stays expanded", () => {
	const s = {
		...base(),
		agents: [agent("o1w", { orch: "o1" }), agent("o2w", { orch: "o2" }), agent("o3w", { orch: "o3" })],
		orchestrators: [orch("o1", 1), orch("o2", 2), orch("o3", 3, { state: "running", workers: 1, endedAt: undefined })],
	};
	const out = render(s, O);
	assert.ok(out.includes("### 🎛 Orchestrator 2"));
	assert.ok(out.includes("- ✅ Orchestrator 1"));
	assert.ok(!out.includes("### 🎛 Orchestrator 1"));
});

test("all orchestrators running -> all expanded, no collapsed bullets", () => {
	const s = {
		...base(),
		agents: [agent("w1", { orch: "o1" }), agent("w2", { orch: "o2" })],
		orchestrators: [orch("o1", 1, { state: "running", endedAt: undefined }), orch("o2", 2, { state: "running", endedAt: undefined })],
	};
	const out = render(s, O);
	assert.ok(out.includes("### 🎛 Orchestrator 1") && out.includes("### 🎛 Orchestrator 2"));
	assert.ok(!out.includes("- ✅ Orchestrator") && !out.includes("- ❌ Orchestrator"));
});

test("collapsed failed orchestrator prints a ❌ bullet", () => {
	const s = {
		...base(),
		agents: [agent("w1", { orch: "o1" }), agent("w2", { orch: "o2" })],
		orchestrators: [orch("o1", 1, { state: "failed" }), orch("o2", 2, { state: "failed" })],
	};
	const out = render(s, O);
	assert.ok(out.includes("- ❌ Orchestrator 1"));
	assert.ok(out.includes("### 🎛 Orchestrator 2 · ❌ failed"));
});

test("collapsed bullet omits minutes when endedAt is missing", () => {
	const s = {
		...base(),
		agents: [agent("w1", { orch: "o1" }), agent("w2", { orch: "o2" })],
		orchestrators: [orch("o1", 1, { endedAt: undefined }), orch("o2", 2)],
	};
	const out = render(s, O);
	assert.ok(out.split("\n").includes("- ✅ Orchestrator 1 · 2 workers"));
});

test("expanded header says 1 worker (singular)", () => {
	const s = {
		...base(),
		agents: [agent("w1", { orch: "o1" })],
		orchestrators: [orch("o1", 1, { state: "running", workers: 1, endedAt: undefined })],
	};
	const out = render(s, O);
	assert.ok(out.includes("### 🎛 Orchestrator 1 · ▶ running · 1 worker"));
});

test("orchestrators: [] falls back to the flat table", () => {
	const s = { ...base(), agents: [agent("a")], orchestrators: [] };
	const out = render(s, O);
	assert.ok(!out.includes("### 🎛"));
	assert.ok(!out.includes("### Direct subagents"));
	assert.ok(out.includes("| | Agent | Model | State | Task |"));
});

test("no Direct subagents heading when there are no direct rows", () => {
	const s = {
		...base(),
		agents: [agent("w1", { orch: "o1" })],
		orchestrators: [orch("o1", 1, { state: "running", endedAt: undefined })],
	};
	const out = render(s, O);
	assert.ok(!out.includes("### Direct subagents"));
});

test("a row whose orch id is unknown renders under Direct subagents", () => {
	const s = {
		...base(),
		agents: [agent("w1", { orch: "o1" }), agent("ghost", { orch: "missing" })],
		orchestrators: [orch("o1", 1, { state: "running", endedAt: undefined })],
	};
	const out = render(s, O);
	assert.ok(out.includes("### Direct subagents"));
	assert.ok(out.indexOf("| ghost |") > out.indexOf("| w1 |"));
});

test("bounded: one overall cap of 20 rows across worker and direct tables", () => {
	const agents: AgentRow[] = [];
	for (let i = 0; i < 5; i++) for (const o of ["o1", "o2"]) agents.push(agent(`${o}-${i}`, { orch: o }));
	for (let i = 0; i < 20; i++) agents.push(agent(`direct-${i}`));
	const s = {
		...base(),
		agents,
		orchestrators: [orch("o1", 1, { state: "running", workers: 5, endedAt: undefined }), orch("o2", 2, { state: "running", workers: 5, endedAt: undefined })],
	};
	const out = render(s, O);
	const rows = out.split("\n").filter((l) => /^\| [🟣🔵🟢🟡🟠🟤] /.test(l));
	assert.ok(rows.length <= 20, `rows ${rows.length}`);
	assert.ok(out.includes("_+10 older not shown_"));
	assert.ok(out.indexOf("_+10 older not shown_") > out.indexOf("### Direct subagents"));
	assert.ok(out.includes("| direct-19 |"));
	assert.ok(!out.includes("| o1-0 |"));
});

test("bounded: worst-case pipe-filled page stays under 12 KB", () => {
	const agents: AgentRow[] = [];
	const orchs: Orchestrator[] = [];
	for (let i = 1; i <= 12; i++) {
		orchs.push(orch(`o${i}`, i, { state: "running", workers: 8, endedAt: undefined }));
		for (let j = 0; j < 8; j++) agents.push(agent("|".repeat(40), { model: "|".repeat(40), orch: `o${i}`, task: "|".repeat(200) }));
	}
	const out = render({ ...base(), agents, orchestrators: orchs }, O);
	assert.ok(out.length < 12_000, `size ${out.length}`);
});

test("defang: runs of slashes, reference definitions and underscore-prefixed www stay inert", () => {
	assert.ok(!defang("///evil.example ////x").includes("//"));
	assert.ok(!defang("[r]: http:evil.example\n[r]: &#47;&#47;evil.example").includes("]:"));
	assert.ok(!defang("_www.evil.example").includes("www."));
	assert.ok(!esc("_www.evil.example").includes("www."));
});

test("banner states: waiting on questions, idle without one, running with one", () => {
	const idle = render(base(), O);
	assert.ok(idle.includes("> 💤 idle — no open question"));
	let s = askQuestion(base(), { question: "Push?", severity: "critical" }, O.now, 1).state;
	const waiting = render({ ...s, phase: "idle" }, O);
	assert.ok(waiting.includes("> ⏳ waiting on you: Q1"));
	assert.ok(!waiting.includes("no open question as of"));
	assert.ok(render({ ...s, phase: "running" }, O).includes("> ▶ running · ⏳ waiting on you: Q1"));
	assert.ok(render({ ...base(), phase: "ended" }, O).includes("session ended, nothing open"));
});

test("last agent message shows only while idle, tail-cut, redacted and escaped", () => {
	const lm = { text: `${"a".repeat(800)} # head | key sk-abcdefghijklmnop1234 done`, at: O.now - 1_680_000 };
	const out = render({ ...base(), lastMessage: lm }, O);
	assert.ok(out.includes("## 💬 Last agent message · 14:02"));
	assert.ok(out.includes("…"));
	assert.ok(out.includes("done"));
	assert.ok(out.includes("redacted") && !out.includes("sk-abcdefghijklmnop"));
	assert.ok(!/^\s*# head/m.test(out));
	assert.ok(!render({ ...base(), phase: "running", lastMessage: lm }, O).includes("Last agent message"));
	assert.ok(!render(base(), O).includes("Last agent message"));
});

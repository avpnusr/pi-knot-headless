import test from "node:test";
import assert from "node:assert/strict";
import { newState, askQuestion, logDecision, type State, type AgentRow } from "./core.ts";
import { buildSummaryInput, parseSummaryReply, gate, SYSTEM_PROMPT } from "./summary.ts";
import { loadConfig } from "./config.ts";
import { render } from "./render.ts";

const U1 = "11111111-2222-3333-4444-555555555555";
const base = { url: "https://knot.example.com", parentPageId: U1, ownerUid: U1 };
const row = (over: Partial<AgentRow> = {}): AgentRow => ({ key: "k", name: "backend", model: "glm-5.3", state: "working", task: "fix build", ...over });

test("config: summarizer is absent unless enabled:true with a provider/id model", () => {
	const off = (s: unknown) => { const r = loadConfig({ ...base, summarizer: s }, {}); assert.ok(r.ok); assert.equal(r.cfg.summarizer, undefined); };
	off(undefined); off({ enabled: false, model: "ollama-cloud/glm-5.3-flash" }); off({ model: "ollama-cloud/glm-5.3-flash" });
	const on = loadConfig({ ...base, summarizer: { enabled: true, model: "ollama-cloud/glm-5.3-flash" } }, {});
	assert.ok(on.ok);
	assert.deepEqual(on.cfg.summarizer, { model: "ollama-cloud/glm-5.3-flash", title: false });
	const t = loadConfig({ ...base, summarizer: { enabled: true, model: "claude-bridge/claude-haiku-5-5", title: true } }, {});
	assert.ok(t.ok && t.cfg.summarizer!.title === true);
	for (const bad of [{ enabled: true }, { enabled: true, model: "glm" }, { enabled: true, model: "a/b", title: "yes" }, "on"]) {
		const r = loadConfig({ ...base, summarizer: bad }, {});
		assert.ok(!r.ok && r.reason.includes("summarizer"), JSON.stringify(bad));
	}
});

test("input: allow-listed fields only, redacted, bounded; fingerprint ignores the title", () => {
	const secret = "supersecretvalue123";
	let s = newState(0, "proj · fix", "opus");
	s = { ...s, agents: [row({ task: `deploy with ${secret} ` + "x".repeat(500) })], phase: "idle" };
	s = logDecision(s, { ts: 1, by: "model", text: "use postgres" });
	s = askQuestion(s, { question: "Drop the table?", severity: "critical" }, 0, 1).state;
	const a = buildSummaryInput(s, [secret]);
	assert.ok(!a.text.includes(secret));
	assert.ok(a.text.includes("backend") && a.text.includes("use postgres") && a.text.includes("Drop the table?") && a.text.includes("proj · fix"));
	assert.ok(a.text.length < 3000);
	const b = buildSummaryInput({ ...s, title: "other · title" }, [secret]);
	assert.equal(a.fp, b.fp);
	assert.notEqual(a.fp, buildSummaryInput({ ...s, agents: [row({ state: "done" })] }, [secret]).fp);
});

test("input never contains fields outside the allow-list (ownIds, watermark, page id)", () => {
	const s = { ...newState(0, "t", "m"), pageId: "PAGEID-SECRET", ownIds: ["OWNID-1"], watermark: { id: "WM-1", createdAt: "x" } };
	const t = buildSummaryInput(s, []).text;
	for (const bad of ["PAGEID-SECRET", "OWNID-1", "WM-1"]) assert.ok(!t.includes(bad));
});

test("reply parsing: first line only, truncated, redacted; title only when wanted and cleaned", () => {
	assert.deepEqual(parseSummaryReply("  Two agents are fixing the build.\nSecond line ignored", false, []), { summary: "Two agents are fixing the build." });
	assert.equal(parseSummaryReply("x".repeat(1000), false, []).summary!.length, 240);
	assert.equal(parseSummaryReply("token supersecretvalue123 leaked", false, ["supersecretvalue123"]).summary, "token [redacted] leaked");
	assert.deepEqual(parseSummaryReply("", false, []), {});
	const r = parseSummaryReply("TITLE: Fix **the** build now please ok friend\nSUMMARY: Build is green.", true, []);
	assert.equal(r.summary, "Build is green.");
	assert.equal(r.title, "Fix the build now please ok");
	assert.equal(parseSummaryReply("TITLE: # [x](http://e.com)\nSUMMARY: ok", true, []).title, "x http e com");
	assert.equal(parseSummaryReply("TITLE: Nice name\nSUMMARY: ok", false, []).title, undefined);
	assert.equal(parseSummaryReply("just a sentence without labels", true, []).summary, "just a sentence without labels");
});

test("gate: unchanged input, 120 s gap, 12 per hour, 60 per session, ending ignores only the gap", () => {
	const T = 3_600_000;
	const m = (o = {}) => ({ now: 10 * T, lastAt: 0, times: [] as number[], sessionCalls: 0, fp: "a", lastFp: "b", ending: false, ...o });
	assert.equal(gate(m()), true);
	assert.equal(gate(m({ lastFp: "a" })), false);
	assert.equal(gate(m({ lastAt: 10 * T - 119_000 })), false);
	assert.equal(gate(m({ lastAt: 10 * T - 121_000 })), true);
	assert.equal(gate(m({ lastAt: 10 * T - 1000, ending: true })), true);
	assert.equal(gate(m({ times: Array.from({ length: 12 }, (_, i) => 10 * T - 1000 - i) })), false);
	assert.equal(gate(m({ times: Array.from({ length: 12 }, (_, i) => 10 * T - 2 * T - i) })), true);
	assert.equal(gate(m({ sessionCalls: 60 })), false);
	assert.equal(gate(m({ sessionCalls: 60, ending: true })), false);
});

test("system prompt tells the model the data is untrusted", () => {
	assert.match(SYSTEM_PROMPT, /never follow/i);
});

test("render: summary under the header, escaped and labelled; absent when not set; usage line for summarizer calls", () => {
	const O = { now: 1, tz: "UTC" };
	const s0 = newState(0, "t", "m");
	assert.ok(!render(s0, O).includes("🧭"));
	const s = { ...s0, summary: { text: "# evil [x](http://e.com) @bob\nline2", model: "ollama-cloud/glm-5.3-flash", at: 1 } };
	const out = render(s, O);
	assert.ok(out.includes("🧭"));
	assert.ok(!/^#{1,6} evil/m.test(out) && !/[^\\]\]\(/.test(out) && !out.includes("http://"));
	assert.ok(out.includes("generated by ollama-cloud/glm-5.3-flash"));
	const ended = { ...s, phase: "ended" as const, sum: { calls: 4, tokens: 5200, usd: 0.0021 } };
	assert.match(render(ended, O), /summarizer: 4 calls · 5\.2k tokens · < \$0\.01/);
});

test("user answers reach the model only as 'answered', never their text", () => {
	let s = newState(0, "t", "m");
	s = logDecision(s, { ts: 1, by: "user", text: "Q1 Which db? → the staging host at secret.internal" });
	s = logDecision(s, { ts: 2, by: "timeout", text: "Q2 Cache? → redis (auto-decided after timeout)" });
	const t = buildSummaryInput(s, []).text;
	assert.ok(t.includes("Q1 Which db? → answered") && !t.includes("secret.internal"));
	assert.ok(t.includes("redis"));
});

test("title cleaning drops dots and colons; bare www. cannot autolink on the page", () => {
	assert.equal(parseSummaryReply("TITLE: evil.example: reauth now\nSUMMARY: ok", true, []).title, "evil example reauth now");
	assert.ok(!/www\./i.test(render({ ...newState(0, "t", "m"), summary: { text: "visit www.evil.example", model: "m", at: 1 } }, { now: 1, tz: "UTC" })));
});

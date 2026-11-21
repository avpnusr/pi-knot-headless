import test from "node:test";
import assert from "node:assert/strict";
import { newState, logDecision, parseCost, nestedByAgent, fmtTokens, type State, type AgentRow } from "./core.ts";
import { render } from "./render.ts";

const O = { now: Date.UTC(2026, 10, 21, 14, 30), tz: "UTC" };
const base = (): State => newState(Date.UTC(2026, 10, 21, 14, 2), "demo · fix the build", "claude-opus-5-5");
const agent = (name: string, over: Partial<AgentRow> = {}): AgentRow => ({ key: name, name, model: "glm-5.3", state: "done", task: "t", ...over });
const ended = (over: Partial<State> = {}): State => ({ ...base(), phase: "ended", lastBeat: Date.UTC(2026, 10, 21, 15, 17), ...over });

test("logDecision counts model/user/timeout decisions, not system notes", () => {
	let s = base();
	for (const by of ["model", "model", "user", "timeout", "system"] as const) s = logDecision(s, { ts: 1, by, text: "x" });
	assert.deepEqual(s.counts, { model: 2, user: 1, timeout: 1 });
});

test("parseCost: total, lower bound, garbage", () => {
	const data = { total: { input: 15840, output: 389, cacheRead: 15168, cacheWrite: 0, cost: 0.0030255 }, unresolvedAsyncChildren: 0 };
	assert.deepEqual(parseCost(data, 5), { input: 15840, output: 389, cacheRead: 15168, cacheWrite: 0, usd: 0.0030255, lowerBound: false, at: 5 });
	assert.equal(parseCost({ ...data, unresolvedAsyncChildren: 2 }, 5)!.lowerBound, true);
	assert.equal(parseCost(undefined, 1), undefined);
	assert.equal(parseCost({ total: { input: "x" } }, 1), undefined);
	assert.equal(parseCost({ total: { input: 1, output: NaN, cost: Infinity } }, 1)!.usd, 0);
});

test("fmtTokens", () => {
	assert.deepEqual([999, 1500, 15_000, 1_234_567].map(fmtTokens), ["999", "1.5k", "15k", "1.2M"]);
});

test("ended page: outcome line with counts, usage line with list-price disclaimer", () => {
	let s = ended({ runs: 3, agents: [agent("a"), agent("b"), agent("c"), agent("d", { state: "failed" })], agentsDropped: 1, backgroundRunning: 0 });
	for (const by of ["model", "model", "user", "timeout"] as const) s = logDecision(s, { ts: 1, by, text: "x" });
	s = { ...s, cost: { input: 1_000_000, output: 84_000, cacheRead: 200_000, cacheWrite: 0, usd: 4.2, lowerBound: false, at: 1 } };
	const out = render(s, O);
	assert.match(out, /outcome: 3 runs · 5 subagents \(3 ✅, 1 ❌\) · 2 🤖 decisions · 1 👤 answer · 1 ⏱ timed out/);
	assert.match(out, /usage: 1\.2M tokens in · 84k out · ≈ \$4\.20 list price \(not your plan bill\)/);
});

test("usage: lower bound prefix, no dollars when cost is 0, absent when unknown", () => {
	const c = { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, usd: 0.5, lowerBound: true, at: 1 };
	assert.match(render(ended({ cost: c }), O), /usage: ≥ 5\.0k tokens in · 100 out · ≈ \$0\.50 list price/);
	const free = render(ended({ cost: { ...c, usd: 0, lowerBound: false } }), O);
	assert.match(free, /usage: 5\.0k tokens in · 100 out/);
	assert.ok(!free.includes("$"));
	assert.ok(!render(ended(), O).includes("usage:"));
});

test("running/idle pages do not show the outcome or usage lines", () => {
	const s = { ...base(), phase: "idle" as const, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 1, lowerBound: false, at: 1 } };
	const out = render(s, O);
	assert.ok(!out.includes("usage:") && !out.includes("outcome:"));
});

test("nested count shows on the row and in the ended summary; truncated source gets a plus", () => {
	const s = ended({ agents: [agent("security-reviewer", { nested: 3 }), agent("merge-gate", { nested: 16, nestedTruncated: true }), agent("plain")] });
	const out = render(s, O);
	assert.match(out, /\| security-reviewer \+3 nested \|/);
	assert.match(out, /\| merge-gate \+16\+ nested \|/);
	assert.match(out, /\| plain \|/);
	assert.match(out, /19\+ nested/);
});

test("nestedByAgent: counts descendant step nodes below each top-level step; truncation from omitted.children", () => {
	const step = (agent: string, children?: any[]) => ({ id: agent, kind: "step", label: agent, state: "running", agent, ...(children ? { children } : {}) });
	const snap = {
		omitted: { runs: 0, children: 0, byteLimitExceeded: false },
		runs: [{ id: "r1", kind: "run", label: "run", state: "running", children: [
			step("security-reviewer", [{ id: "n1", kind: "run", label: "x", state: "running", children: [step("a"), step("b")] }, { id: "n2", kind: "run", label: "y", state: "done", children: [step("c")] }]),
			step("explorer"),
		] }],
	};
	const m = nestedByAgent(snap);
	assert.deepEqual(m.get("security-reviewer"), { n: 3, truncated: false });
	assert.equal(m.has("explorer"), false);
	const t = nestedByAgent({ ...snap, omitted: { runs: 0, children: 2, byteLimitExceeded: false } });
	assert.equal(t.get("security-reviewer")!.truncated, true);
	assert.equal(nestedByAgent(undefined).size, 0);
	assert.equal(nestedByAgent({ runs: "nope" }).size, 0);
});

test("tiny dollar amounts read as < $0.01", () => {
	const c = { input: 44_000, output: 400, cacheRead: 0, cacheWrite: 0, usd: 0.0012, lowerBound: false, at: 1 };
	assert.match(render(ended({ cost: c }), O), /usage: 44k tokens in · 400 out · < \$0\.01 list price/);
});

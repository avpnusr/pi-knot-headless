import test from "node:test";
import assert from "node:assert/strict";
import { harness, FakeKnot, OWNER, BOT, PARENT } from "./fakepi.ts";
import { KnotAuthError } from "./knot.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalSettings } from "./extension.ts";

const critical = { question: "Drop the prod table?", options: ["yes", "no"], severity: "critical", why: "migration" };

test("inert inside subagent children: registers nothing", () => {
	const h = harness({ env: { PI_SUBAGENT_CHILD: "1" } });
	assert.equal(h.tools.size, 0);
	assert.equal(h.commands.size, 0);
	assert.equal(h.handlerCount(), 0);
	const h2 = harness({ env: { PI_SUBAGENT_RUNNER_PID: "9" } });
	assert.equal(h2.tools.size, 0);
});

test("print mode: no timer, no tool, no network", async () => {
	const h = harness();
	await h.start("startup", h.ctx({ mode: "print" }));
	assert.equal(h.intervals.length, 0);
	assert.equal(h.tools.size, 0);
	await h.handle.tick(true);
	assert.equal(h.knot.calls, 0);
});

test("missing or incomplete config (no url / no ownerUid): no tool, no timer, status says not configured", async () => {
	for (const settings of [{}, { "pi-knot-headless": { url: "https://knot.example.com", parentPageId: PARENT } }]) {
		const h = harness({ settings });
		await h.start();
		assert.equal(h.intervals.length, 0);
		assert.equal(h.tools.size, 0);
		assert.ok(h.status.includes("knot: not configured"));
	}
});

test("the tool is registered only when reporting is active", async () => {
	const h = harness();
	assert.equal(h.tools.size, 0);
	await h.start();
	assert.ok(h.tools.has("knot_ask"));
});

test("no page until a trigger", async () => {
	const h = harness();
	await h.start();
	await h.handle.tick(true);
	assert.equal(h.knot.calls, 0);
	assert.equal(h.intervals.length, 1);
});

test("minor: decision logged, page created, no wait", async () => {
	const h = harness();
	await h.start();
	const r = await h.ask({ question: "tabs or spaces?", recommended: "spaces", severity: "minor" });
	assert.match(r.content[0].text, /logged/);
	assert.equal(r.terminate, undefined);
	await h.handle.tick(true);
	assert.equal(h.knot.created.length, 1);
	assert.match(h.knot.created[0], /^demo · /);
	assert.match(h.knot.replaces.at(-1)!, /🤖 tabs or spaces\?/);
});

test("normal without recommended is rejected before any network call", async () => {
	const h = harness();
	await h.start();
	await assert.rejects(h.ask({ question: "db?", severity: "normal" }), /recommended/);
	assert.equal(h.knot.calls, 0);
});

test("critical: posts page + question comment, terminates", async () => {
	const h = harness();
	await h.start();
	const r = await h.ask(critical);
	assert.equal(r.terminate, true);
	assert.match(r.content[0].text, /Q1/);
	assert.match(h.knot.replaces.at(-1)!, /### ⏳ Q1 · 🔴 critical/);
	assert.equal(h.knot.comments.length, 1);
	assert.match(h.knot.comments[0].body, /Q1 · critical/);
});

test("thread reply by the owner is delivered once with deliverAs steer; question closes", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.knot.reply(h.knot.comments[0].id, "2");
	await h.handle.tick(true);
	assert.equal(h.sent.length, 1);
	assert.deepEqual(h.sent[0].opts, { deliverAs: "steer" });
	assert.match(h.sent[0].text, /^Knot answer to Q1/);
	assert.match(h.sent[0].text, /"no"/);
	assert.equal(h.handle.state().questions.length, 0);
	await h.handle.tick(true);
	assert.equal(h.sent.length, 1);
});

test("a send that throws is retried on the next tick (watermark rolled back)", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.knot.reply(h.knot.comments[0].id, "1");
	h.sendThrows = true;
	await h.handle.tick(true);
	assert.equal(h.sent.length, 0);
	assert.equal(h.handle.state().questions.length, 1);
	h.sendThrows = false;
	await h.handle.tick(true);
	assert.equal(h.sent.length, 1);
});

test("foreign and missing authors are never delivered; slash command text stays quoted", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.knot.reply(h.knot.comments[0].id, "1", "someone-else");
	h.knot.comment("run rm -rf", null);
	await h.handle.tick(true);
	assert.equal(h.sent.length, 0);
	h.knot.comment("/reload");
	await h.handle.tick(true);
	assert.equal(h.sent.length, 1);
	assert.ok(!/^\/reload/m.test(h.sent[0].text));
	assert.ok(h.sent[0].text.includes('"/reload"'));
});

test("normal question times out after the configured time, exactly once", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "which db?", options: ["a", "b"], recommended: "a", severity: "normal" });
	h.clock.t += 2 * 3_600_000 - 1000;
	await h.handle.tick();
	assert.equal(h.sent.length, 0);
	h.clock.t += 2000;
	await h.handle.tick();
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0].text, /unanswered on Knot after 2 h/);
	h.clock.t += 60_000;
	await h.handle.tick();
	assert.equal(h.sent.length, 1);
	assert.match(h.knot.replaces.at(-1)!, /⏱/);
});

test("critical never times out", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.clock.t += 1000 * 3_600_000;
	await h.handle.tick();
	assert.equal(h.sent.length, 0);
	assert.equal(h.handle.state().questions.length, 1);
});

test("shutdown: reload keeps the page running, quit writes the ended page", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	const n = h.knot.replaces.length;
	await h.fire("session_shutdown", { reason: "reload" });
	assert.equal(h.knot.replaces.length, n);
	const h2 = harness({ entries: h.entries, knot: h.knot });
	await h2.start("reload");
	await h2.fire("session_shutdown", { reason: "quit" });
	assert.equal(h.knot.replaces.length, n + 1);
	assert.match(h.knot.replaces.at(-1)!, /^# ✅/);
});

test("fork drops the inherited page; resume and reload restore it", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	for (const [reason, keeps] of [["resume", true], ["reload", true], ["fork", false], ["new", false]] as const) {
		const h2 = harness({ entries: h.entries });
		await h2.start(reason);
		assert.equal(!!h2.handle.state().pageId, keeps, reason);
	}
});

test("after a reload, comments that were already delivered are not delivered again", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.knot.reply(h.knot.comments[0].id, "1");
	await h.handle.tick(true);
	assert.equal(h.sent.length, 1);
	const h2 = harness({ entries: h.entries, knot: h.knot });
	await h2.start("reload");
	await h2.handle.tick(true);
	assert.equal(h2.sent.length, 0);
	h.knot.comment("new instruction");
	await h2.handle.tick(true);
	assert.equal(h2.sent.length, 1);
});

test("comments posted while pi was down are delivered once on start", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.knot.comment("while you were away");
	const h2 = harness({ entries: h.entries, knot: h.knot });
	await h2.start("resume");
	await h2.handle.tick(true);
	await h2.handle.tick(true);
	assert.equal(h2.sent.length, 1);
	assert.match(h2.sent[0].text, /while you were away/);
});

test("identical render is not written twice", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	const n = h.knot.replaces.length;
	await h.handle.tick(true);
	await h.handle.tick(true);
	assert.equal(h.knot.replaces.length, n);
});

test("Knot outage never throws, shows offline and recovers; auth error disables with one notice", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.knot.failWith = new Error("HTTP 500");
	await h.handle.tick(true);
	assert.equal(h.status.at(-1), "knot: offline");
	h.knot.failWith = undefined;
	await h.handle.tick(true);
	assert.equal(h.status.at(-1), undefined);
	h.knot.failWith = new KnotAuthError("Knot rejected the token (HTTP 401)");
	await h.handle.tick(true);
	await h.handle.tick(true);
	assert.equal(h.notes.length, 1);
	const calls = h.knot.calls;
	await h.handle.tick(true);
	assert.equal(h.knot.calls, calls);
});

test("critical question: if Knot is unreachable the tool fails and the question is not kept", async () => {
	const h = harness();
	await h.start();
	h.knot.failWith = new Error("HTTP 503");
	await assert.rejects(h.ask(critical), /not reachable/);
	assert.equal(h.handle.state().questions.length, 0);
	assert.equal(h.entries.at(-1).data.questions.length, 0); // the undo is persisted too
});

test("failed page write after the page exists: only the new question is undone, an answer delivered meanwhile stays delivered", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.knot.reply(h.knot.comments[0].id, "1");
	await h.handle.tick(true);
	assert.equal(h.sent.length, 1);
	h.knot.failReplace = new Error("HTTP 500");
	await assert.rejects(h.ask({ question: "another?", severity: "critical" }), /not reachable/);
	h.knot.failReplace = undefined;
	await h.handle.tick(true);
	assert.equal(h.sent.length, 1);
	assert.equal(h.handle.state().questions.length, 0);
});

test("ownerUid equal to the agent's own account is allowed but warned about, and its own comments are still not delivered", async () => {
	const h = harness({ settings: { "pi-knot-headless": { url: "https://knot.example.com", parentPageId: PARENT, ownerUid: BOT } } });
	await h.start();
	await h.ask(critical);
	await h.handle.tick(true);
	assert.equal(h.sent.length, 0);
	assert.ok(h.notes.some((n) => /own Knot account/.test(n)));
});

test("subagents: async start shows the row; it turns done when it leaves the fleet", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	h.fleet = { entries: [{ key: "k1", agent: "architect", model: "opus", goal: "design review" }], totalActive: 1 };
	h.pi.events.emit("subagent:async-started", {});
	await h.flush();
	await h.runTimeouts();
	let a = h.handle.state().agents;
	assert.equal(a.length, 1);
	assert.deepEqual([a[0].name, a[0].model, a[0].task, a[0].state], ["architect", "opus", "design review", "working"]);
	assert.equal(h.handle.state().backgroundRunning, 1);
	h.fleet = { entries: [], totalActive: 0 };
	h.pi.events.emit("subagent:jobs-changed", { version: 1 });
	await h.runTimeouts();
	a = h.handle.state().agents;
	assert.equal(a[0].state, "done");
	assert.equal(h.handle.state().backgroundRunning, 0);
});

test("a foreground subagent call creates the page; rows come from the fleet and finish with it", async () => {
	const h = harness();
	await h.start();
	h.fleet = { entries: [{ key: "foreground:r:0", agent: "explorer", model: "glm", role: "scout" }], totalActive: 1 };
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "t1", args: { agent: "explorer", task: "look around", async: false } });
	await h.handle.tick(true);
	assert.equal(h.knot.created.length, 1);
	await h.runTimeouts();
	assert.deepEqual(h.handle.state().agents.map((a) => [a.name, a.task, a.state]), [["explorer", "scout", "working"]]);
	h.fleet = { entries: [], totalActive: 0 };
	await h.fire("tool_execution_end", { toolName: "subagent", toolCallId: "t1", isError: false });
	await h.runTimeouts();
	assert.equal(h.handle.state().agents[0].state, "done");
});

test("subagent management calls (status, list) do not create a page", async () => {
	const h = harness();
	await h.start();
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "t1", args: { action: "status" } });
	await h.handle.tick(true);
	assert.equal(h.knot.calls, 0);
});

test("async-complete turns a row that jobs-changed already marked done into failed", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	h.fleet = { entries: [{ key: "k1", agent: "tests", model: "m" }], totalActive: 1 };
	h.pi.events.emit("subagent:jobs-changed", { version: 1 });
	await h.runTimeouts();
	h.fleet = { entries: [], totalActive: 0 };
	h.pi.events.emit("subagent:jobs-changed", { version: 1 });
	await h.runTimeouts();
	assert.equal(h.handle.state().agents[0].state, "done");
	h.pi.events.emit("subagent:async-complete", { results: [{ agent: "tests", status: "failed" }] });
	assert.equal(h.handle.state().agents[0].state, "failed");
});

test("a truncated fleet (omitted > 0) does not turn unseen working rows into done", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	h.fleet = { entries: [{ key: "a", agent: "one" }, { key: "b", agent: "two" }], totalActive: 2 };
	h.pi.events.emit("subagent:jobs-changed", { version: 1 });
	await h.runTimeouts();
	h.fleet = { entries: [{ key: "b", agent: "two" }], totalActive: 2, omitted: 1 } as any;
	h.pi.events.emit("subagent:jobs-changed", { version: 1 });
	await h.runTimeouts();
	assert.deepEqual(h.handle.state().agents.map((a) => a.state), ["working", "working"]);
});

test("model switch is logged once a page exists; run without logged decisions is flagged", async () => {
	const h = harness();
	await h.start();
	await h.fire("model_select", { model: { id: "sonnet" } });
	assert.equal(h.handle.state().decisions.length, 0);
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	await h.fire("model_select", { model: { id: "sonnet" } });
	assert.match(h.handle.state().decisions.at(-1)!.text, /model switched to sonnet/);
	await h.fire("agent_settled"); // end of the run that contained the decisions above
	await h.fire("agent_start");
	await h.fire("tool_execution_end", { toolName: "bash" });
	await h.fire("agent_start"); // a retry / continuation inside the same turn must not reset the counters
	await h.fire("agent_settled");
	assert.match(h.handle.state().decisions.at(-1)!.text, /no logged decisions/);
	assert.equal(h.handle.state().mutated, false);
});

test("a failing appendEntry or handler never propagates into pi", async () => {
	const h = harness();
	await h.start();
	h.throwOnAppend = true;
	const r = await h.ask({ question: "x", recommended: "y", severity: "minor" });
	assert.match(r.content[0].text, /logged/);
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "t", args: null });
});

test("secrets never reach the page, comments or log", async () => {
	const h = harness({ env: { KNOT_TOKEN: "tok-123456789" } });
	await h.start();
	await h.ask({ question: "use token tok-123456789 ?", recommended: "tok-123456789", severity: "critical", why: "Bearer abc.def" });
	const all = [...h.knot.replaces, ...h.knot.comments.map((c) => c.body), ...h.knot.created].join("\n");
	assert.ok(!all.includes("tok-123456789"));
	assert.ok(!all.includes("abc.def"));
});

test("/knot off stops all network activity; /knot status reports", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	await h.commands.get("knot").handler("off", h.ctx());
	const calls = h.knot.calls;
	await h.handle.tick(true);
	assert.equal(h.knot.calls, calls);
	await h.commands.get("knot").handler("status", h.ctx());
	assert.match(h.notes.at(-1)!, /off/);
});

test("the timer is registered once per session_start and uses the 20 s poll", async () => {
	const h = harness();
	await h.start();
	await h.start("reload");
	assert.equal(h.intervals.length, 2);
	assert.equal(((globalThis as any)[Symbol.for("pi-knot-headless.timer")]), h.intervals[1]);
});

test("normal questions still time out while Knot is down, after an auth failure and after /knot off", async () => {
	for (const how of ["outage", "off"] as const) {
		const h = harness();
		await h.start();
		await h.ask({ question: "db?", options: ["a", "b"], recommended: "a", severity: "normal" });
		if (how === "outage") h.knot.failWith = new Error("HTTP 500");
		else await h.commands.get("knot").handler("off", h.ctx());
		h.clock.t += 2 * 3_600_000 + 1000;
		await h.handle.tick();
		assert.equal(h.sent.length, 1, how);
		assert.match(h.sent[0].text, /proceed with: "a"/);
	}
});

test("after shutdown the old instance never touches Knot or pi again", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	await h.fire("session_shutdown", { reason: "reload" });
	const calls = h.knot.calls;
	h.knot.reply(h.knot.comments[0].id, "1");
	h.pi.events.emit("subagent:jobs-changed", { version: 1 });
	await h.runTimeouts();
	await h.handle.tick(true);
	assert.equal(h.knot.calls, calls);
	assert.equal(h.sent.length, 0);
});

test("only the global settings file is read: a project's .pi/settings.json cannot redirect the token", () => {
	const dir = mkdtempSync(join(tmpdir(), "khs-"));
	mkdirSync(join(dir, "agent"));
	writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ "pi-knot-headless": { url: "https://good.example" } }));
	const proj = join(dir, "proj", ".pi");
	mkdirSync(proj, { recursive: true });
	writeFileSync(join(proj, "settings.json"), JSON.stringify({ "pi-knot-headless": { url: "https://evil.example" } }));
	const prev = process.cwd();
	process.chdir(join(dir, "proj"));
	try {
		assert.deepEqual(readGlobalSettings({ PI_CODING_AGENT_DIR: join(dir, "agent") }), { url: "https://good.example" });
		assert.equal(readGlobalSettings({ PI_CODING_AGENT_DIR: join(dir, "nowhere") }), undefined);
	} finally {
		process.chdir(prev);
	}
});

test("question comments are defanged (no images, links, mentions) and stay under Knot's byte limit", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "see ![x](https://evil.example/p.png) @alice https://phish.example " + "é".repeat(3000), severity: "critical" });
	const body = h.knot.comments[0].body;
	assert.ok(!body.includes("![x]("));
	assert.ok(!body.includes("https://"));
	assert.ok(!/@[a-z]/.test(body));
	assert.ok(Buffer.byteLength(body) <= 3500);
});

test("cost is read after a run settles and shown on the ended page; counters feed the outcome line", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "tabs?", recommended: "spaces", severity: "minor" });
	await h.handle.tick(true);
	h.cost = { total: { input: 15840, output: 389, cacheRead: 15168, cacheWrite: 0, cost: 0.003 }, unresolvedAsyncChildren: 1 };
	await h.fire("agent_settled");
	await h.flush();
	assert.equal(h.handle.state().cost!.lowerBound, true);
	assert.equal(h.handle.state().runs, 1);
	await h.fire("session_shutdown", { reason: "quit" });
	const last = h.knot.replaces.at(-1)!;
	assert.match(last, /outcome: 1 run · 1 🤖 decision/);
	assert.match(last, /usage: ≥ 31k tokens in · 389 out/);
});

test("without pi-subagents (no RPC reply) the cost stays absent and nothing breaks", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	await h.fire("agent_settled");
	await h.runTimeouts();
	assert.equal(h.handle.state().cost, undefined);
});

test("nested count from the status snapshot lands on the matching row and survives the row finishing", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const step = (agent: string, children?: any[]) => ({ id: agent, kind: "step", label: agent, state: "running", agent, ...(children ? { children } : {}) });
	h.fleet = { entries: [{ key: "k1", agent: "security-reviewer", model: "opus" }], totalActive: 1 };
	h.snapshot = { omitted: { children: 0 }, runs: [{ id: "r", kind: "run", children: [step("security-reviewer", [{ id: "n", kind: "run", children: [step("a"), step("b"), step("c")] }])] }] };
	h.pi.events.emit("subagent:jobs-changed", { version: 1 });
	await h.runTimeouts();
	assert.equal(h.handle.state().agents[0].nested, 3);
	h.fleet = { entries: [], totalActive: 0 };
	h.snapshot = undefined;
	h.pi.events.emit("subagent:jobs-changed", { version: 1 });
	await h.runTimeouts();
	assert.deepEqual([h.handle.state().agents[0].state, h.handle.state().agents[0].nested], ["done", 3]);
});

const SUM = { url: "https://knot.example.com", parentPageId: PARENT, ownerUid: OWNER, summarizer: { enabled: true, model: "ollama-cloud/glm-5.3-flash", title: true } };
const minor = { question: "tabs?", recommended: "spaces", severity: "minor" };
async function withSummarizer(settings: any = SUM) {
	const h = harness({ settings: { "pi-knot-headless": settings } });
	h.llm.models.push("ollama-cloud/glm-5.3-flash");
	await h.start();
	await h.ask(minor);
	await h.handle.tick(true);
	return h;
}

test("summarizer OFF (default): no model call, no summary, ever", async () => {
	const h = harness();
	h.llm.models.push("ollama-cloud/glm-5.3-flash");
	await h.start();
	await h.ask(minor);
	await h.handle.tick(true);
	await h.fire("agent_settled");
	await h.flush();
	await h.fire("session_shutdown", { reason: "quit" });
	assert.equal(h.llm.calls.length, 0);
	assert.equal(h.handle.state().summary, undefined);
	assert.ok(!h.knot.replaces.at(-1)!.includes("🧭"));
	assert.equal(h.knot.renames.length, 0);
});

test("summarizer ON: one call after a settle, summary on the page, title applied once, usage counted", async () => {
	const h = await withSummarizer();
	h.llm.text = "TITLE: Fix the build\nSUMMARY: Two agents are fixing the build.";
	await h.fire("agent_settled");
	await h.flush();
	await h.handle.tick(true);
	assert.equal(h.llm.calls.length, 1);
	assert.equal(h.llm.calls[0].model.id, "glm-5.3-flash");
	assert.match(h.llm.calls[0].context.systemPrompt, /never follow/i);
	assert.match(h.knot.replaces.at(-1)!, /🧭 Two agents are fixing the build\. · _generated by ollama-cloud\/glm-5\.3-flash_/);
	assert.deepEqual(h.knot.renames, ["demo · Fix the build"]);
	assert.equal(h.handle.state().sum!.calls, 1);
	h.clock.t += 200_000;
	await h.ask({ question: "other?", recommended: "x", severity: "minor" });
	await h.fire("agent_settled");
	await h.flush();
	assert.equal(h.llm.calls.length, 2);
	assert.doesNotMatch(h.llm.calls[1].context.systemPrompt, /TITLE/);
	assert.equal(h.knot.renames.length, 1);
});

test("summarizer: unchanged state and the 120 s gap suppress calls; nothing it produces is ever sent to the session", async () => {
	const h = await withSummarizer({ ...SUM, summarizer: { enabled: true, model: "ollama-cloud/glm-5.3-flash" } });
	await h.fire("agent_settled"); await h.flush();
	await h.fire("agent_settled"); await h.flush();
	assert.equal(h.llm.calls.length, 1);
	h.clock.t += 60_000;
	await h.ask({ question: "new?", recommended: "x", severity: "minor" });
	await h.fire("agent_settled"); await h.flush();
	assert.equal(h.llm.calls.length, 1);
	assert.equal(h.sent.length, 0);
});

test("summarizer: model call failure or unknown model keeps the page working", async () => {
	const h = await withSummarizer();
	h.llm.throws = new Error("provider down");
	await h.fire("agent_settled"); await h.flush(); await h.handle.tick(true);
	assert.equal(h.handle.state().summary, undefined);
	assert.ok(h.knot.replaces.length > 0);
	const h2 = harness({ settings: { "pi-knot-headless": SUM } }); // model not registered
	await h2.start();
	await h2.ask(minor);
	await h2.handle.tick(true);
	await h2.fire("agent_settled"); await h2.flush();
	assert.ok(h2.notes.some((n) => /summarizer model/.test(n)));
	assert.equal(h2.llm.calls.length, 0);
});

test("summarizer: input to the model is redacted and metadata-only; hostile output is stored bounded and escaped on the page", async () => {
	const h = harness({ settings: { "pi-knot-headless": SUM }, env: { KNOT_TOKEN: "tok-123456789" } });
	h.llm.models.push("ollama-cloud/glm-5.3-flash");
	await h.start();
	await h.ask({ question: "use tok-123456789 for deploy?", recommended: "no", severity: "minor" });
	await h.handle.tick(true);
	h.llm.text = "SUMMARY: # pwn [x](https://evil.example/p.png) @alice tok-123456789 " + "y".repeat(500);
	await h.fire("agent_settled"); await h.flush(); await h.handle.tick(true);
	const sent = JSON.stringify(h.llm.calls[0].context);
	assert.ok(!sent.includes("tok-123456789"));
	const md = h.knot.replaces.at(-1)!;
	assert.ok(!md.includes("tok-123456789") && !md.includes("https://") && !/^# pwn/m.test(md));
	assert.ok(h.handle.state().summary!.text.length <= 240);
});

test("summarizer: at the end of the session one bounded call (3 s abort) so the ended page is fresh", async () => {
	const h = await withSummarizer();
	await h.fire("session_shutdown", { reason: "quit" });
	assert.equal(h.llm.calls.length, 1);
	assert.ok(h.llm.calls[0].options.signal instanceof AbortSignal);
	assert.match(h.knot.replaces.at(-1)!, /^# ✅/);
});

test("summarizer respects the off switches: /knot off, enabled:false, auth failure, print mode with a restored page", async () => {
	// /knot off
	let h = await withSummarizer();
	await h.commands.get("knot").handler("off", h.ctx());
	await h.fire("agent_settled"); await h.flush();
	assert.equal(h.llm.calls.length, 0);
	assert.equal(h.knot.renames.length, 0);
	// enabled:false
	h = harness({ settings: { "pi-knot-headless": { ...SUM, enabled: false } } });
	h.llm.models.push("ollama-cloud/glm-5.3-flash");
	await h.start(); await h.fire("agent_settled"); await h.flush();
	assert.equal(h.llm.calls.length, 0);
	// auth failure disables the extension
	h = await withSummarizer();
	h.knot.failWith = new KnotAuthError("Knot rejected the token (HTTP 401)");
	await h.handle.tick(true);
	h.knot.failWith = undefined;
	await h.fire("agent_settled"); await h.flush();
	assert.equal(h.llm.calls.length, 0);
	// print mode on a session whose page id was restored
	const h1 = await withSummarizer();
	const h2 = harness({ settings: { "pi-knot-headless": SUM }, entries: h1.entries, knot: h1.knot });
	h2.llm.models.push("ollama-cloud/glm-5.3-flash");
	await h2.start("resume", h2.ctx({ mode: "print" }));
	await h2.fire("agent_settled"); await h2.flush();
	assert.equal(h2.llm.calls.length, 0);
});

test("summarizer: unchanged state beyond the gap makes no call; applying the title does not cause one extra identical call", async () => {
	const h = await withSummarizer();
	h.llm.text = "TITLE: Fix build\nSUMMARY: Working on it.";
	await h.fire("agent_settled"); await h.flush();
	assert.equal(h.llm.calls.length, 1);
	assert.equal(h.knot.renames.length, 1);
	h.clock.t += 500_000;
	await h.fire("agent_settled"); await h.flush();
	assert.equal(h.llm.calls.length, 1); // same input, title already applied
});

test("summarizer: failed attempts count toward the per-session cap and the title is never applied while ending", async () => {
	const h = await withSummarizer({ ...SUM, summarizer: { enabled: true, model: "ollama-cloud/glm-5.3-flash", title: true } });
	h.llm.throws = new Error("down");
	await h.fire("agent_settled"); await h.flush();
	assert.equal(h.handle.state().sum!.attempts, 1);
	h.llm.throws = undefined;
	h.llm.text = "TITLE: Late title\nSUMMARY: Done.";
	await h.fire("session_shutdown", { reason: "quit" });
	assert.equal(h.knot.renames.length, 0);
});

test("a summarizer reply that arrives after shutdown is discarded (no state write, no rename)", async () => {
	const h = await withSummarizer();
	let release!: () => void;
	const gateP = new Promise<void>((r) => (release = r));
	const orig = h.ctx().modelRegistry.complete;
	void orig;
	h.llm.text = "TITLE: Late\nSUMMARY: Late summary.";
	// make the model call hang until we release it
	const hang = h.llm;
	const calls = hang.calls;
	const realCtx = h.ctx;
	h.ctx = (over: any = {}) => { const c = realCtx(over); const f = c.modelRegistry.complete; c.modelRegistry.complete = async (...a: any[]) => { await gateP; return f(...a); }; return c; };
	await h.start("reload");
	await h.fire("agent_settled", {}, h.ctx());
	await h.fire("session_shutdown", { reason: "reload" });
	release();
	await h.flush(); await h.flush();
	assert.equal(h.knot.renames.length, 0);
	assert.equal(h.handle.state().summary, undefined);
	void calls;
});

test("state saved by v0.1 (no counts) restores consistent counts; old summary is dropped when the summarizer is off", async () => {
	const h1 = harness();
	await h1.start();
	await h1.ask(minor);
	const saved = structuredClone(h1.entries.at(-1).data);
	delete saved.counts; delete saved.agentsDropped; saved.summary = { text: "old", model: "m", at: 1 };
	saved.agents = [{ key: "a", name: "a", model: "m", state: "done", task: "t" }];
	const h2 = harness({ entries: [{ type: "custom", customType: "knot-headless", data: saved }] });
	await h2.start("resume");
	assert.deepEqual(h2.handle.state().counts, { model: 1, user: 0, timeout: 0 });
	assert.equal(h2.handle.state().agentsDropped, 1);
	assert.equal(h2.handle.state().summary, undefined);
});

test("a closing session does not poll and swallow an answer after it ended", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	await h.fire("session_shutdown", { reason: "quit" });
	h.knot.reply(h.knot.comments[0].id, "1");
	await h.handle.tick(true);
	assert.equal(h.sent.length, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { harness, FakeKnot, OWNER, BOT, PARENT } from "./fakepi.ts";
import { KnotAuthError } from "./knot.ts";

const critical = { question: "Drop the prod table?", options: ["yes", "no"], severity: "critical", why: "migration" };

test("inert inside subagent children: registers nothing", () => {
	const h = harness({ env: { PI_SUBAGENT_CHILD: "1" } });
	assert.equal(h.tools.size, 0);
	assert.equal(h.commands.size, 0);
	assert.equal(h.handlerCount(), 0);
	const h2 = harness({ env: { PI_SUBAGENT_RUNNER_PID: "9" } });
	assert.equal(h2.tools.size, 0);
});

test("print mode: no timer, no network, tool answers 'not active'", async () => {
	const h = harness();
	await h.start("startup", h.ctx({ mode: "print" }));
	assert.equal(h.intervals.length, 0);
	const r = await h.ask(critical, h.ctx({ mode: "print" }));
	assert.match(r.content[0].text, /not active/);
	assert.equal(h.knot.calls, 0);
});

test("missing config: tool reports the reason, nothing starts", async () => {
	const h = harness({ settings: {} });
	await h.start();
	assert.equal(h.intervals.length, 0);
	assert.match((await h.ask(critical)).content[0].text, /"url"/);
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
	await h.fire("session_shutdown", { reason: "quit" });
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
});

test("owner defaults to the parent's creator; refuses when that is the agent itself", async () => {
	const settings = { "pi-knot-headless": { url: "https://knot.example.com", parentPageId: PARENT } };
	const ok = harness({ settings });
	await ok.start();
	await ok.ask(critical);
	ok.knot.reply(ok.knot.comments[0].id, "1");
	await ok.handle.tick(true);
	assert.equal(ok.sent.length, 1);

	const knot = new FakeKnot();
	knot.parentCreator = BOT;
	const bad = harness({ settings, knot });
	await bad.start();
	await assert.rejects(bad.ask(critical), /ownerUid|not reachable/);
	assert.ok(bad.notes.some((n) => /ownerUid/.test(n)));
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

test("foreground subagent tool call creates the page and a row that finishes", async () => {
	const h = harness();
	await h.start();
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "t1", args: { agent: "explorer", task: "look around" } });
	await h.handle.tick(true);
	assert.equal(h.knot.created.length, 1);
	assert.equal(h.handle.state().agents[0].state, "working");
	await h.fire("tool_execution_end", { toolName: "subagent", toolCallId: "t1", isError: false });
	assert.equal(h.handle.state().agents[0].state, "done");
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
	await h.fire("agent_start");
	await h.fire("tool_execution_end", { toolName: "bash" });
	await h.fire("agent_settled");
	assert.match(h.handle.state().decisions.at(-1)!.text, /no logged decisions/);
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

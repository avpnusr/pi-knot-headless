import test from "node:test";
import assert from "node:assert/strict";
import { harness, FakeKnot, OWNER, BOT, PARENT, makeRoute, ev, wfDir, WF_ID } from "./fakepi.ts";
import { KnotAuthError, KnotResponseError } from "./knot.ts";
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

test("knot_ask carries the skills rule in its prompt guidelines", async () => {
	const h = harness();
	await h.start();
	const g: string[] = h.tools.get("knot_ask").promptGuidelines;
	assert.ok(g.some((x) => x.startsWith("Skills do not change the knot_ask rules") && /ALSO go through knot_ask/.test(x)));
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

test("restore drops an invalid page id together with its comment cursor and thread ids", async () => {
	const h1 = harness();
	await h1.start();
	await h1.ask(critical);
	const saved = structuredClone(h1.entries.at(-1).data);
	saved.pageId = "../../admin";
	saved.selfOwned = true;
	const h2 = harness({ entries: [{ type: "custom", customType: "knot-headless", data: saved }] });
	await h2.start("resume");
	const st = h2.handle.state();
	assert.equal(st.pageId, undefined);
	assert.equal(st.watermark, undefined);
	assert.equal(st.selfOwned, undefined);
	assert.deepEqual(st.ownIds, []);
	assert.ok(st.questions.every((q) => q.threadId === undefined));
	await h2.ask({ question: "x", recommended: "y", severity: "minor" });
	await h2.handle.tick(true);
	assert.equal(h2.knot.created.length, 1);
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

test("restore uses the newest watermark and ownIds across the session, not only the current branch", async () => {
	const h1 = harness();
	await h1.start();
	await h1.ask(critical);
	const branch = structuredClone(h1.entries);
	h1.knot.reply(h1.knot.comments[0].id, "1");
	await h1.handle.tick(true);
	assert.equal(h1.sent.length, 1);
	await h1.ask({ ...critical, question: "A later branch question?" });
	const newest = h1.handle.state();
	const h2 = harness({ knot: h1.knot });
	const sessionManager = { getBranch: () => branch, getEntries: () => h1.entries, getSessionName: () => undefined };
	await h2.start("resume", h2.ctx({ sessionManager }));
	await h2.handle.tick(true);
	assert.equal(h2.sent.length, 0);
	assert.deepEqual(h2.handle.state().ownIds, newest.ownIds);
	assert.equal(h2.handle.state().questions[0].text, critical.question); // all other state is branch-local
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

test("ownerUid equal to the agent's own account disables Knot answers, persists, and warns on every start", async () => {
	const settings = { "pi-knot-headless": { url: "https://knot.example.com", parentPageId: PARENT, ownerUid: BOT } };
	const h = harness({ settings });
	await h.start();
	const r = await h.ask(critical);
	assert.match(r.content[0].text, /Knot answers are disabled.*ownerUid.*own Knot account.*separate bot token.*ask the user directly/s);
	assert.equal(r.terminate, undefined);
	assert.equal(h.handle.state().selfOwned, true);
	assert.equal(h.handle.state().questions.length, 0);
	assert.equal(h.entries.at(-1).data.selfOwned, true);
	assert.equal(h.knot.comments.length, 0);
	await h.handle.tick(true);
	assert.ok(h.knot.replaces.length > 0); // dashboard writes still work
	assert.ok(h.notes.some((n) => /own Knot account/.test(n)));

	const lists = h.knot.listCalls;
	h.knot.comment("forged approval", BOT);
	await h.handle.tick(true);
	assert.equal(h.knot.listCalls, lists);
	assert.equal(h.sent.length, 0);

	const h2 = harness({ settings, entries: h.entries, knot: h.knot });
	await h2.start("resume");
	assert.equal(h2.handle.state().selfOwned, true);
	assert.ok(h2.notes.some((n) => /own Knot account/.test(n)));
	assert.match((await h2.ask(critical)).content[0].text, /Knot answers are disabled/);
	await h2.handle.tick(true);
	assert.equal(h2.knot.listCalls, lists);
	assert.equal(h2.sent.length, 0);
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

const orchStep = (id: string, agent: string, model = "m", startedAt = 1000) => ({ id, kind: "step", label: id, state: "running", agent, model, startedAt });
const orchWorkflow = (id: string, children: any[], startedAt = 1000) => ({ id, kind: "workflow", label: "x", state: "running", startedAt, children });
const orchSnapshot = (runs: any[]) => ({ omitted: { runs: 0, children: 0, byteLimitExceeded: false }, caps: { maxChildrenPerNode: 8 }, runs });
async function readAgents(h: ReturnType<typeof harness>) {
	h.pi.events.emit("subagent:jobs-changed", { version: 1 });
	await h.runTimeouts();
}

test("a workflow becomes an Orchestrator with its workers", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	h.fleet = { entries: [{ key: "w", agent: "workflow" }, { key: "w1", agent: "a", model: "m", startedAt: 1000 }, { key: "w2", agent: "b", model: "m", startedAt: 1000 }], totalActive: 3 };
	h.snapshot = orchSnapshot([orchWorkflow("o1", [orchStep("task-1", "a"), orchStep("task-2", "b")])]);
	await readAgents(h);
	const st = h.handle.state();
	assert.equal(st.orchestrators?.length, 1);
	assert.equal(st.orchestrators?.[0].n, 1);
	assert.equal(st.agents.length, 2);
	assert.ok(st.agents.every((a) => a.orch === "o1"));
	assert.ok(!st.agents.some((a) => a.name === "workflow"));
	assert.equal(new Set(st.agents.map((a) => a.key)).size, 2);
	await h.handle.tick(true);
	assert.ok(h.knot.replaces.at(-1)!.includes("### 🎛 Orchestrator 1"));
});

test("scripted workflow workers show pi-subagents' step excerpt from status.json (no launch args involved)", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const w = wfDir({ steps: [{ agent: "a", workflowKey: "pass1", label: "pass1", sessionName: "a: check the parser" }, { agent: "b", workflowKey: "pass2", label: "pass2", sessionName: "b: write the tests" }] });
	h.fleet = { entries: [{ key: "w", agent: "workflow" }, { key: "w1", agent: "a", model: "m", startedAt: 1000 }, { key: "w2", agent: "b", model: "m", startedAt: 1000 }], totalActive: 3 };
	h.snapshot = orchSnapshot([orchWorkflow(WF_ID, [orchStep("pass1", "a"), orchStep("pass2", "b")])]);
	h.pi.events.emit("subagent:async-started", w.payload);
	await readAgents(h);
	assert.deepEqual(h.handle.state().agents.map((a) => a.task), ["check the parser", "write the tests"]);
	await h.handle.tick(true);
	assert.ok(h.knot.replaces.at(-1)!.includes("check the parser"));
});

test("task text comes from the launch arguments", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const startedAt = h.clock.t;
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "t1", args: { workflow: "parallel", args: { tasks: [{ agent: "a", task: "fix the parser" }, { agent: "b", task: "write tests" }] } } });
	h.fleet = { entries: [{ key: "w1", agent: "a", model: "m", startedAt }, { key: "w2", agent: "b", model: "m", startedAt }], totalActive: 2 };
	h.snapshot = orchSnapshot([orchWorkflow("o1", [orchStep("task-1", "a", "m", startedAt), orchStep("task-2", "b", "m", startedAt)], startedAt)]);
	await readAgents(h);
	assert.deepEqual(h.handle.state().agents.map((a) => a.task), ["fix the parser", "write tests"]);
});

test("a direct launch supplies task text to a new fleet row", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const startedAt = h.clock.t;
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "direct-1", args: { agent: "explorer", task: "find the parser" } });
	h.fleet = { entries: [{ key: "d1", agent: "explorer", model: "m", startedAt }], totalActive: 1 };
	await h.runTimeouts();
	assert.deepEqual(h.handle.state().agents.map((a) => [a.name, a.task]), [["explorer", "find the parser"]]);
});

test("a new direct row with a role consumes its launch without changing the displayed task", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const startedAt = h.clock.t;
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "direct-1", args: { agent: "explorer", task: "first search" } });
	h.fleet = { entries: [{ key: "d1", agent: "explorer", model: "m", role: "scout", startedAt }], totalActive: 1 };
	await h.runTimeouts();
	assert.equal(h.handle.state().agents[0].task, "scout");
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "direct-2", args: { agent: "explorer", task: "second search" } });
	h.fleet = { entries: [{ key: "d2", agent: "explorer", model: "m", startedAt }], totalActive: 1 };
	await h.runTimeouts();
	assert.equal(h.handle.state().agents.find((a) => a.key === "d2")!.task, "second search");
});

test("hostile direct arguments still trigger the page and fleet with empty task text", async () => {
	const h = harness();
	await h.start();
	h.fleet = { entries: [{ key: "d1", agent: "a", model: "m", startedAt: h.clock.t }], totalActive: 1 };
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "direct-1", args: { agent: "a", task: { toString: 1 } } });
	await h.handle.tick(true);
	assert.equal(h.knot.created.length, 1);
	await h.runTimeouts();
	assert.deepEqual(h.handle.state().agents.map((a) => [a.name, a.task]), [["a", ""]]);
});

test("two direct launches of one agent supply their task texts in FIFO order", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const startedAt = h.clock.t;
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "direct-1", args: { agent: "explorer", task: "first search" } });
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "direct-2", args: { agent: "explorer", task: "second search" } });
	h.fleet = { entries: [
		{ key: "d1", agent: "explorer", model: "m", startedAt },
		{ key: "d2", agent: "explorer", model: "m", startedAt },
	], totalActive: 2 };
	await h.runTimeouts();
	assert.deepEqual(h.handle.state().agents.map((a) => [a.key, a.task]), [["d1", "first search"], ["d2", "second search"]]);
});

test("a JSON string chain supplies task text to step ids in launch order", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const startedAt = h.clock.t;
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "chain-1", args: { chain: JSON.stringify([{ agent: "a", task: "first chain task" }, { agent: "b", task: "second chain task" }]) } });
	h.fleet = { entries: [], totalActive: 0 };
	h.snapshot = orchSnapshot([orchWorkflow("chain", [orchStep("step-one", "a", "m", startedAt), orchStep("step-two", "b", "m", startedAt)], startedAt)]);
	await readAgents(h);
	assert.deepEqual(h.handle.state().agents.map((a) => a.task), ["first chain task", "second chain task"]);
});

test("an empty failed workflow does not become an orchestrator", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	h.fleet = { entries: [], totalActive: 0 };
	h.snapshot = orchSnapshot([{ ...orchWorkflow("failed", []), state: "failed" }]);
	await readAgents(h);
	assert.deepEqual(h.handle.state().orchestrators, []);
	assert.deepEqual(h.handle.state().agents, []);
});

test("a failed workflow launch is removed before it can supply task text", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const startedAt = h.clock.t;
	await h.fire("tool_execution_start", { toolName: "subagent", toolCallId: "failed-call", args: { workflow: "parallel", args: { tasks: [{ agent: "a", task: "wrong-a" }, { agent: "b", task: "wrong-b" }] } } });
	await h.fire("tool_execution_end", { toolName: "subagent", toolCallId: "failed-call", isError: true });
	h.fleet = { entries: [{ key: "w1", agent: "a", model: "m", startedAt }, { key: "w2", agent: "b", model: "m", startedAt }], totalActive: 2 };
	h.snapshot = orchSnapshot([orchWorkflow("o1", [orchStep("task-1", "a", "m", startedAt), orchStep("task-2", "b", "m", startedAt)], startedAt)]);
	await readAgents(h);
	assert.deepEqual(h.handle.state().agents.map((a) => a.task), ["task-1", "task-2"]);
});

test("more than 30 orchestrator rows never displace direct rows or inflate agentsDropped", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	h.fleet = { entries: [{ key: "d1", agent: "direct-a", model: "m" }, { key: "d2", agent: "direct-b", model: "m" }], totalActive: 2 };
	h.snapshot = orchSnapshot(Array.from({ length: 8 }, (_, i) => orchWorkflow(`o${i}`, Array.from({ length: 4 }, (_, j) => orchStep(`task-${j + 1}`, `a${i}-${j}`)))));
	await readAgents(h);
	await readAgents(h);
	const st = h.handle.state();
	assert.equal(st.agents.filter((a) => a.orch).length, 32);
	assert.deepEqual(st.agents.filter((a) => !a.orch).map((a) => a.key), ["d1", "d2"]);
	assert.equal(st.agentsDropped, 0);
});

test("two workflows with the same task-N keys keep their own rows", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	h.fleet = { entries: [], totalActive: 0 };
	h.snapshot = orchSnapshot([
		orchWorkflow("o1", [orchStep("task-1", "a"), orchStep("task-2", "b")], 1000),
		orchWorkflow("o2", [orchStep("task-1", "c"), orchStep("task-2", "d")], 2000),
	]);
	await readAgents(h);
	const st = h.handle.state();
	assert.deepEqual(st.orchestrators?.map((o) => o.n), [1, 2]);
	assert.equal(st.agents.length, 4);
	assert.equal(new Set(st.agents.map((a) => a.key)).size, 4);
	assert.deepEqual(st.agents.map((a) => a.key).sort(), ["o1:task-1", "o1:task-2", "o2:task-1", "o2:task-2"]);
});

test("without a snapshot nothing changes", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	h.snapshot = undefined;
	h.fleet = { entries: [{ key: "w", agent: "workflow" }], totalActive: 1 };
	await readAgents(h);
	assert.deepEqual(h.handle.state().agents.map((a) => a.name), ["workflow"]);
	assert.equal(h.handle.state().orchestrators, undefined);
});

test("a finished orchestrator stays on the page", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	h.fleet = { entries: [{ key: "w1", agent: "a", model: "m", startedAt: 1000 }], totalActive: 1 };
	h.snapshot = orchSnapshot([orchWorkflow("o1", [orchStep("task-1", "a")])]);
	await readAgents(h);
	h.fleet = { entries: [], totalActive: 0 };
	h.snapshot = orchSnapshot([]);
	await readAgents(h);
	const st = h.handle.state();
	assert.equal(st.orchestrators?.length, 1);
	assert.equal(st.orchestrators?.[0].state, "done");
	assert.equal(st.agents.length, 1);
	assert.ok(st.agents.every((a) => a.state === "done"));
});

test("restore resets orchestrators but numbering continues", async () => {
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	const saved = structuredClone(h.entries.at(-1).data);
	saved.orchestrators = [{ id: "o1", n: 1, state: "done", workers: 1 }, { id: "o2", n: 2, state: "done", workers: 1 }];
	saved.nextOrch = 3;
	const resumed = harness({ entries: [{ type: "custom", customType: "knot-headless", data: saved }] });
	await resumed.start("resume");
	assert.deepEqual(resumed.handle.state().orchestrators, []);
	assert.equal(resumed.handle.state().nextOrch, 3);
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

test("nested count from the async-started route (real-life case: the snapshot has no nested runs) lands on the row and survives completion", async () => {
	const { writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const { sink, payload } = makeRoute();
	h.fleet = { entries: [{ key: "k1", agent: "security-reviewer", model: "opus" }], totalActive: 1 };
	h.snapshot = { omitted: { children: 0 }, runs: [{ id: "r", kind: "run", children: [{ id: "s", kind: "step", agent: "security-reviewer", state: "running", children: [] }] }] };
	h.pi.events.emit("subagent:async-started", payload);
	writeFileSync(join(sink, "1-a.json"), ev("subagent.nested.started", "c1"));
	writeFileSync(join(sink, "2-b.json"), ev("subagent.nested.started", "c2"));
	await h.runTimeouts();
	assert.equal(h.handle.state().agents[0].nested, 2);
	assert.ok(!JSON.stringify(h.handle.state()).includes("16c8c21f-token") && !JSON.stringify(h.handle.state()).includes(sink)); // nothing of the route is stored
	assert.ok(!h.knot.replaces.some((md) => md.includes("16c8c21f-token")));
	writeFileSync(join(sink, "3-c.json"), ev("subagent.nested.started", "c3")); // lands after the row left the fleet
	h.fleet = { entries: [], totalActive: 0 };
	h.pi.events.emit("subagent:async-complete", { id: "async1", results: [] });
	await h.runTimeouts();
	assert.deepEqual([h.handle.state().agents[0].state, h.handle.state().agents[0].nested], ["done", 3]);
});

test("cost is re-read after an async completion and at shutdown; nested usage lands on the page while running", async () => {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const h = harness();
	await h.start();
	await h.ask({ question: "x", recommended: "y", severity: "minor" });
	await h.handle.tick(true);
	const { sink, runsDir, payload } = makeRoute();
	h.cost = { total: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1 }, unresolvedAsyncChildren: 1 };
	h.pi.events.emit("subagent:async-started", payload);
	writeFileSync(join(sink, "1-a.json"), ev("subagent.nested.completed", "c1", { state: "complete", totalTokens: { input: 2, output: 297 } }));
	mkdirSync(join(runsDir, "c1"), { recursive: true });
	writeFileSync(join(runsDir, "c1", "status.json"), JSON.stringify({ totalCost: { costUsd: 0.5 } }));
	h.fleet = { entries: [{ key: "k1", agent: "security-reviewer", model: "opus" }], totalActive: 1 };
	await h.runTimeouts();
	assert.deepEqual(h.handle.state().nestedCost && [h.handle.state().nestedCost!.runs, h.handle.state().nestedCost!.output, h.handle.state().nestedCost!.usd], [1, 297, 0.5]);
	await h.handle.tick(true);
	assert.match(h.knot.replaces.at(-1)!, /## 💰 Usage so far[\s\S]*nested runs \(not in the usage above\): 1 · 2 in · 297 out/);
	// the async child finishes later: the completion event triggers a delayed cost re-read that now resolves it
	h.cost = { total: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.4 }, unresolvedAsyncChildren: 0 };
	h.pi.events.emit("subagent:async-complete", { id: "async1", results: [] });
	await h.runTimeouts();
	assert.deepEqual([h.handle.state().cost!.input, h.handle.state().cost!.lowerBound], [40, false]);
	// a final read at shutdown picks up usage that arrived after the last settle
	h.cost = { total: { input: 90, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.9 }, unresolvedAsyncChildren: 0 };
	await h.fire("session_shutdown", { reason: "quit" });
	assert.equal(h.handle.state().cost!.input, 90);
	assert.match(h.knot.replaces.at(-1)!, /usage: 90 tokens in/);
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

test("an in-flight poll response is discarded after shutdown without advancing the watermark", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.knot.reply(h.knot.comments[0].id, "1");
	const watermark = structuredClone(h.handle.state().watermark);
	let release!: () => void;
	h.knot.listGate = new Promise<void>((r) => (release = r));
	const polling = h.handle.tick(true);
	await h.flush();
	assert.equal(h.knot.listCalls, 1);
	await h.fire("session_shutdown", { reason: "reload" });
	release();
	await polling;
	assert.equal(h.sent.length, 0);
	assert.deepEqual(h.handle.state().watermark, watermark);
	assert.equal(h.handle.state().questions.length, 1);
});

test("selfOwned is re-derived from the stored page creator against the current ownerUid on every start", async () => {
	const botOwner = { "pi-knot-headless": { url: "https://knot.example.com", parentPageId: PARENT, ownerUid: BOT } };
	const h = harness({ settings: botOwner });
	await h.start();
	await h.ask(critical);
	assert.equal(h.handle.state().selfOwned, true);
	// ownerUid corrected later: inbound answers work again
	const fixed = harness({ entries: h.entries, knot: h.knot });
	await fixed.start("resume");
	assert.equal(fixed.handle.state().selfOwned, undefined);
	// ownerUid changed to the agent's own account later: inbound answers are switched off
	const normal = harness();
	await normal.start();
	await normal.ask(critical);
	assert.equal(normal.handle.state().selfOwned, undefined);
	const swapped = harness({ settings: botOwner, entries: normal.entries, knot: normal.knot });
	await swapped.start("resume");
	assert.equal(swapped.handle.state().selfOwned, true);
	assert.ok(swapped.notes.some((n) => /own Knot account/.test(n)));
});

test("restore ignores the session-wide watermark when the newest entry belongs to another page", async () => {
	const h1 = harness();
	await h1.start();
	await h1.ask(critical);
	const branch = structuredClone(h1.entries);
	const other = { ...structuredClone(h1.entries.at(-1)), data: { ...structuredClone(h1.entries.at(-1).data), pageId: "0eeeeeee-0000-4000-8000-000000000009", watermark: { id: "zzz", createdAt: "2099-01-01T00:00:00.000000Z" } } };
	const h2 = harness({ knot: h1.knot });
	const sessionManager = { getBranch: () => branch, getEntries: () => [...branch, other], getSessionName: () => undefined };
	await h2.start("resume", h2.ctx({ sessionManager }));
	assert.deepEqual(h2.handle.state().watermark, branch.at(-1).data.watermark);
});

test("an oversized/malformed comment list does not stop dashboard writes or mark Knot offline", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical);
	h.knot.listComments = async () => { throw new KnotResponseError("Knot comments response exceeds 2 MiB"); };
	const writes = h.knot.replaces.length;
	await h.ask({ question: "tabs or spaces?", recommended: "spaces", severity: "minor" });
	await h.handle.tick(true);
	assert.ok(h.knot.replaces.length > writes);
	assert.notEqual(h.status.at(-1), "knot: offline");
});

const say = (h: any, text: string) => h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }, { type: "toolCall", name: "x" }] } });

test("a run that ends asking in the chat is mirrored to Knot as an answerable question (even without a page yet)", async () => {
	const h = harness();
	await h.start();
	await h.fire("agent_start");
	await say(h, "Tests pass.");
	await say(h, "Tell me if you want me to push it.");
	await h.fire("agent_settled", { aborted: false });
	await h.flush(); await h.flush();
	const st = h.handle.state();
	assert.equal(st.questions.length, 1);
	assert.equal(st.questions[0].mirrored, true);
	assert.ok(h.knot.comments.some((c) => c.body.includes("Q1") && c.body.includes("want me to push it")));
	assert.ok(h.knot.replaces.at(-1)!.includes("waiting on you: Q1"));
	// the owner answers in the thread: delivered like any answer
	h.knot.reply(h.knot.comments[0].thread_id!, "yes");
	await h.handle.tick(true);
	assert.match(h.sent.at(-1)!.text, /Knot answer to Q1.*the user answered: "yes"/);
	assert.equal(h.handle.state().questions.length, 0);
});

const user = (h: any, text: string) => h.fire("message_end", { message: { role: "user", content: [{ type: "text", text }] } });

test("a mirrored question is dropped (and logged) only by a real user chat message, not by the extension's own steers or a bare agent_start", async () => {
	const h = harness();
	await h.start();
	await h.fire("agent_start");
	await say(h, "Shall I push?");
	await h.fire("agent_settled", { aborted: false });
	await h.flush(); await h.flush();
	assert.equal(h.handle.state().questions.length, 1);
	await h.fire("agent_start");
	await user(h, "Knot answer to Q9: \"x\" — the user answered: \"y\"");
	await user(h, "[Knot message from user] \"hello\"");
	await user(h, "Q9 \"x\" unanswered on Knot after 2 h; proceed with: \"y\"");
	await h.fire("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "output" }] } });
	assert.equal(h.handle.state().questions.length, 1, "own steers, tool results and agent_start must not drop it");
	assert.equal(h.handle.state().lastMessage?.text, "Shall I push?", "agent_start does not clear the last message");
	await user(h, "yes, push it"); // the user answered in the chat
	assert.equal(h.handle.state().questions.length, 0);
	assert.match(h.handle.state().decisions.at(-1)!.text, /Q1 dropped: you continued in the chat/);
	await say(h, "Pushed. All done.");
	await h.fire("agent_settled", { aborted: false });
	await h.flush(); await h.flush();
	const st = h.handle.state();
	assert.equal(st.questions.length, 0);
	assert.equal(st.lastMessage?.text, "Pushed. All done.");
	assert.ok(h.knot.replaces.at(-1)!.includes("Last message from the agent"));
});

test("a mirrored question survives a restart and stays answerable; the secret at the cut is redacted before slicing", async () => {
	const key = "sk-abcdefghijklmnop1234567890";
	const h = harness();
	await h.start();
	await h.fire("agent_start");
	await say(h, `${key} ${"y".repeat(150)} Should I push?`); // the 180-char cut lands inside the key
	await h.fire("agent_settled", { aborted: false });
	await h.flush(); await h.flush();
	const all = JSON.stringify(h.knot.comments) + h.knot.replaces.join("");
	assert.ok(!all.includes("1234567890"), "no fragment of the key reaches Knot");
	const h2 = harness({ entries: h.entries, knot: h.knot });
	await h2.start("resume");
	assert.equal(h2.handle.state().questions[0].mirrored, true);
	h.knot.reply(h.knot.comments[0].thread_id!, "go");
	await h2.handle.tick(true);
	assert.match(h2.sent.at(-1)!.text, /the user answered: "go"/);
});

test("no mirroring when aborted, when a knot_ask is already open, or when the message is a plain report", async () => {
	const h = harness();
	await h.start();
	await h.fire("agent_start");
	await say(h, "Shall I push?");
	await h.fire("agent_settled", { aborted: true });
	assert.equal(h.handle.state().questions.length, 0);
	await h.fire("agent_start");
	await say(h, "Report only.");
	await h.fire("agent_settled", { aborted: false });
	await h.flush();
	assert.equal(h.knot.comments.length, 0, "a plain report opens no question");
	await h.ask(critical);
	await h.fire("agent_start");
	await say(h, "Should I? (the real question is Q1)");
	await h.fire("agent_settled", { aborted: false });
	assert.equal(h.handle.state().questions.length, 1);
	assert.equal(h.handle.state().questions[0].mirrored, undefined);
});

// ---- comment cleanup (resolve finished threads) ----
const minorAsk = { question: "Which colour?", severity: "minor", recommended: "blue", why: "default" };
async function pageWithNotes(n: number, h = harness()) {
	await h.start();
	await h.ask(minorAsk); // creates the page, no comment of its own
	for (let i = 1; i <= n; i++) h.knot.comment(`note ${i}`);
	return h;
}

test("cleanup: resolves the oldest finished threads, 3 per poll, also on polls with nothing fresh; the newest 5 stay", async () => {
	const h = await pageWithNotes(10);
	await h.handle.tick(true);
	assert.equal(h.sent.length, 1);
	assert.deepEqual(h.knot.resolved, ["c1", "c2", "c3"]);
	await h.handle.tick(true); // nothing fresh
	assert.deepEqual(h.knot.resolved, ["c1", "c2", "c3", "c4", "c5"]);
	await h.handle.tick(true);
	assert.equal(h.knot.resolved.length, 5);
});

test("cleanup: a delivery that failed and rolled back resolves nothing, the retry does", async () => {
	const h = await pageWithNotes(10);
	h.sendThrows = true;
	await h.handle.tick(true);
	assert.deepEqual(h.knot.resolved, [], "the session never got these comments");
	h.sendThrows = false;
	await h.handle.tick(true);
	assert.deepEqual(h.knot.resolved, ["c1", "c2", "c3"]);
});

test("cleanup: not on a self-owned page and not after the session ended", async () => {
	const own = harness({ settings: { "pi-knot-headless": { url: "https://knot.example.com", parentPageId: PARENT, ownerUid: BOT } } });
	await pageWithNotes(10, own);
	await own.handle.tick(true);
	assert.equal(own.knot.resolveCalls, 0);
	const h = await pageWithNotes(10);
	await h.fire("session_shutdown", { reason: "quit" });
	await h.handle.tick(true);
	assert.equal(h.knot.resolveCalls, 0);
});

test("cleanup: a refused or failing resolve stays local: reporting stays on, the page is still written, the refused thread is not retried", async () => {
	for (const fail of ["refused", new Error("boom"), new KnotAuthError("no")] as const) {
		const h = await pageWithNotes(10);
		h.knot.failResolve = fail;
		const before = h.knot.replaces.length;
		await h.handle.tick(true);
		assert.equal(h.knot.resolveCalls, 1, "the batch stops at the first failure");
		assert.ok(h.knot.replaces.length > before, "page written in the same tick");
		assert.ok(!h.status.some((x) => x === "knot: disabled" || x === "knot: offline"), String(fail));
		await h.handle.tick(true);
		assert.equal(h.knot.resolveCalls, 2, "a refused id is skipped (next candidate tried), a thrown one is retried: one attempt per poll either way");
		assert.ok(h.handle.state().pageId);
	}
});

test("cleanup: a reply into a resolved thread is still delivered; a just-answered old question thread is not resolved", async () => {
	const h = harness();
	await h.start();
	await h.ask(critical); // thread c1, open question
	for (let i = 2; i <= 7; i++) h.knot.comment(`note ${i}`);
	await h.handle.tick(true);
	assert.deepEqual(h.knot.resolved, ["c2"], "c1 is an open question's thread");
	h.knot.reply("c1", "1"); // the answer: c1 becomes the newest activity
	await h.handle.tick(true);
	assert.ok(h.sent.at(-1)!.text.includes("the user answered"));
	assert.ok(!h.knot.resolved.includes("c1"));
	assert.deepEqual(h.knot.resolved, ["c2", "c3"]);
	h.knot.reply("c2", "late thought"); // thread c2 is resolved but the reply must arrive
	await h.handle.tick(true);
	assert.ok(h.sent.at(-1)!.text.includes("late thought"));
});

// ---- last message, always ----
test("the last message is set at every assistant message, also while running; a normal tick publishes it, nothing is saved per message", async () => {
	const h = harness();
	await h.start();
	await h.ask(minorAsk);
	await h.fire("agent_start");
	const saved = h.entries.length, writes = h.knot.replaces.length;
	for (let i = 1; i <= 5; i++) await say(h, `step ${i}`);
	assert.equal(h.entries.length, saved, "no appendEntry per message");
	assert.equal(h.handle.state().lastMessage?.text, "step 5");
	assert.ok(h.knot.replaces.length - writes <= 1, "no write storm");
	h.clock.t += 20_000;
	await h.handle.tick(); // normal tick, not forced: the write gap has passed
	const page = h.knot.replaces.at(-1)!;
	assert.ok(page.includes("## 💬 Last message from the agent · 10:00") && page.includes("step 5") && page.includes("▶ running"));
});

test("the first assistant message creates the page; inactive modes make no Knot call", async () => {
	const h = harness();
	await h.start();
	assert.equal(h.knot.created.length, 0);
	await say(h, "Hello, working on it.");
	await h.flush(); await h.flush();
	assert.equal(h.knot.created.length, 1);
	assert.ok(h.knot.replaces.at(-1)!.includes("Hello, working on it."));
	await say(h, "second");
	await h.flush();
	assert.equal(h.knot.created.length, 1, "only the first message creates a page");

	const p = harness();
	await p.start("startup", p.ctx({ mode: "print" }));
	await say(p, "hi");
	await p.flush();
	assert.equal(p.knot.calls, 0);

	const o = harness();
	await o.start();
	await o.commands.get("knot").handler("off", o.ctx());
	await say(o, "hi");
	await o.flush();
	assert.equal(o.knot.calls, 0);
});

test("the settled run keeps the full elided message (not a tail cut), persists it, and a resume restores it", async () => {
	const key = "sk-abcdefghijklmnop1234567890";
	const h = harness();
	await h.start();
	await h.fire("agent_start");
	await say(h, `${"a".repeat(590)} ${key} ${"b".repeat(1500)} THE END`); // the head cut (600) lands inside the key
	await h.fire("agent_settled", { aborted: false });
	await h.flush(); await h.flush();
	const t = h.handle.state().lastMessage!.text;
	assert.ok(t.startsWith("a".repeat(590)) && t.includes("…") && t.endsWith("THE END"), "head and tail kept");
	assert.ok(!t.includes("abcdefgh") && !t.includes("sk-"), "redacted before eliding");
	const h2 = harness({ entries: h.entries, knot: h.knot });
	await h2.start("resume");
	assert.equal(h2.handle.state().lastMessage?.text, t);
});

test("page creation on messages is retried at most once per poll interval while Knot is down", async () => {
	const h = harness();
	await h.start();
	h.knot.failWith = new Error("down");
	for (let i = 0; i < 6; i++) await say(h, `msg ${i}`);
	await h.flush(); await h.flush();
	assert.equal(h.knot.calls, 1, "one create attempt for six messages");
	h.clock.t += 20_000;
	await say(h, "later");
	await h.flush(); await h.flush();
	assert.equal(h.knot.calls, 2);
	h.knot.failWith = undefined;
	h.clock.t += 20_000;
	await say(h, "back");
	await h.flush(); await h.flush();
	assert.equal(h.knot.created.length, 1);
	assert.ok(h.knot.replaces.at(-1)!.includes("back"));
});

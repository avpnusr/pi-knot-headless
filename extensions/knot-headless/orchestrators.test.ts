import test from "node:test";
import assert from "node:assert/strict";
import { newState, type State, type AgentRow } from "./core.ts";
import {
	mapSnapState, orchestratorsFromSnapshot, claimWorkerEntries, launchFromArgs, addLaunch, applyOrchestrators,
	type SnapWorker, type SnapOrch, type Launch,
} from "./orchestrators.ts";

const step = (id: string, agent: string, model: string, state: string, extra: Record<string, unknown> = {}) =>
	({ id, kind: "step", label: id, state, agent, model, startedAt: 1_000, ...extra });
const wf = (id: string, children: any[], extra: Record<string, unknown> = {}) =>
	({ id, kind: "workflow", label: "x", state: "running", startedAt: 1_000, children, ...extra });
const snap = (runs: any[], extra: Record<string, unknown> = {}) =>
	({ omitted: { runs: 0, children: 0, byteLimitExceeded: false }, caps: { maxChildrenPerNode: 8 }, runs, ...extra });
const S = (): State => newState(1, "demo", "m");
const ent = (key: string, agent: string, model: string, startedAt?: number) => ({ key, agent, model, startedAt });
const wrk = (key: string, agent = "coder", model = "glm-5.3", startedAt = 1_000): SnapWorker =>
	({ key, label: key, agent, model, state: "working", startedAt, nested: 0, nestedTruncated: false });
const orch = (workers: SnapWorker[]): SnapOrch[] => [{ id: "o", state: "running", startedAt: 1_000, truncated: false, workers }];

test("mapSnapState table", () => {
	assert.equal(mapSnapState("running"), "working");
	assert.equal(mapSnapState("queued"), "waiting");
	assert.equal(mapSnapState("complete"), "done");
	assert.equal(mapSnapState("paused"), "paused");
	for (const v of ["failed", "partial", "stopped", "rejected"]) assert.equal(mapSnapState(v), "failed");
	assert.equal(mapSnapState("garbage"), "idle");
	assert.equal(mapSnapState(undefined), "idle");
});

test("orchestratorsFromSnapshot: undefined for garbage, [] without workflow nodes", () => {
	assert.equal(orchestratorsFromSnapshot(undefined), undefined);
	assert.equal(orchestratorsFromSnapshot({}), undefined);
	assert.equal(orchestratorsFromSnapshot({ runs: "x" }), undefined);
	assert.deepEqual(orchestratorsFromSnapshot(snap([])), []);
	assert.deepEqual(orchestratorsFromSnapshot(snap([{ id: "s", kind: "subagent", label: "a", state: "running" }])), []);
});

test("orchestratorsFromSnapshot maps workers", () => {
	const w = wf("o1", [
		step("task-1", "backend-developer", "glm-5.3", "complete"),
		step("task-2", "x", "m", "queued"),
		step("task-3", "z", "m", "running", { children: [
			{ id: "run", kind: "run", label: "r", state: "running", children: [step("n1", "aa", "m", "done")] },
			step("n2", "bb", "m", "done"),
		] }),
	]);
	const out = orchestratorsFromSnapshot(snap([w]))!;
	assert.equal(out.length, 1);
	assert.equal(out[0].id, "o1");
	assert.equal(out[0].state, "running");
	assert.equal(out[0].startedAt, 1_000);
	assert.equal(out[0].truncated, false);
	assert.deepEqual(out[0].workers.map((x) => x.key), ["task-1", "task-2", "task-3"]);
	assert.equal(out[0].workers[0].state, "done");
	assert.equal(out[0].workers[1].state, "waiting");
	assert.equal(out[0].workers[0].model, "glm-5.3");
	assert.equal(out[0].workers[2].nested, 2);
	assert.equal(out[0].workers[2].nestedTruncated, false);
	// the workflow's own child list hit the per-node cap
	const capped = orchestratorsFromSnapshot(snap([wf("o2", [step("task-1", "a", "m", "running"), step("task-2", "b", "m", "running")])], { caps: { maxChildrenPerNode: 2 } }))!;
	assert.equal(capped[0].truncated, true);
});

test("orchestratorsFromSnapshot skips run and worker nodes without a non-empty string id", () => {
	const out = orchestratorsFromSnapshot(snap([
		wf("", [step("task-1", "a", "m", "running")]),
		wf(undefined as any, [step("task-1", "a", "m", "running")]),
		wf("valid", [
			step("", "a", "m", "running"),
			{ ...step("missing", "a", "m", "running"), id: undefined },
			step("task-1", "a", "m", "running"),
		]),
	]))!;
	assert.deepEqual(out.map((o) => o.id), ["valid"]);
	assert.deepEqual(out[0].workers.map((w) => w.key), ["task-1"]);
});

test("claimWorkerEntries", () => {
	const entries = [ent("e1", "coder", "glm-5.3", 1_000), ent("e2", "coder", "glm-5.3", 1_000), ent("e3", "coder", "glm-5.3", 1_000)];
	// two workers among three identical entries: exactly two claimed
	const two = claimWorkerEntries(entries, orch([wrk("task-1"), wrk("task-2")]));
	assert.equal(two.size, 2);
	assert.ok(two.has("e1") && two.has("e2"));
	assert.ok(!two.has("e3"));
	// three workers start together: each entry claimed once, none duplicated
	const three = claimWorkerEntries(entries, orch([wrk("task-1"), wrk("task-2"), wrk("task-3")]));
	assert.equal(three.size, 3);
	// 5 minutes away is not the same worker
	assert.equal(claimWorkerEntries([ent("far", "coder", "glm-5.3", 1_000 + 300_000)], orch([wrk("task-1")])).size, 0);
	// another model is not the same worker
	assert.equal(claimWorkerEntries([ent("m", "coder", "other", 1_000)], orch([wrk("task-1")])).size, 0);
	// live finding: the fleet reports the model with a thinking suffix, the snapshot without
	assert.deepEqual([...claimWorkerEntries([ent("t", "coder", "glm-5.3:low", 1_000)], orch([wrk("task-1")]))], ["t"]);
	assert.deepEqual([...claimWorkerEntries([ent("t", "coder", "glm-5.3", 1_000)], orch([wrk("task-1", "coder", "glm-5.3:high")]))], ["t"]);
	assert.equal(claimWorkerEntries([ent("t", "coder", "glm-5.3-flash:low", 1_000)], orch([wrk("task-1")])).size, 0); // not a suffix of the same id
});

test("claimWorkerEntries ignores queued, done and missing start times", () => {
	const entry = ent("direct", "coder", "glm-5.3", 1_000);
	const queued = { ...wrk("task-1"), state: "waiting" as const, startedAt: undefined };
	assert.equal(claimWorkerEntries([entry], orch([queued])).size, 0);
	assert.equal(claimWorkerEntries([entry], orch([{ ...wrk("task-1"), state: "done" as const }])).size, 0);
	assert.equal(claimWorkerEntries([ent("direct", "coder", "glm-5.3")], orch([wrk("task-1")])).size, 0);
	assert.equal(claimWorkerEntries([entry], orch([{ ...wrk("task-1"), state: "paused" as const }])).size, 1);
});

test("applyOrchestrators first sight", () => {
	const so = orchestratorsFromSnapshot(snap([wf("o1", [step("task-1", "a", "m", "running"), step("task-2", "b", "m", "running")])]))!;
	const r = applyOrchestrators(S(), so, { launches: [{ at: 1, tasks: ["first task", "second task"], agents: ["a", "b"] }], now: 9_000, omitted: false });
	assert.equal(r.state.orchestrators![0].n, 1);
	assert.equal(r.state.orchestrators![0].workers, 2);
	assert.equal(r.state.nextOrch, 2);
	const row = r.state.agents.find((a) => a.key === "o1:task-1")!;
	assert.ok(row);
	assert.equal(row.orch, "o1");
	assert.equal(row.state, "working");
	assert.equal(row.task, "first task");
	assert.equal(r.state.agents.find((a) => a.key === "o1:task-2")!.task, "second task");
	// the matching launch is consumed
	assert.deepEqual(r.launches, []);
	// an empty launch is never consumed; a row without any text falls back to the step label
	const r2 = applyOrchestrators(S(), so, { launches: [{ at: 1, tasks: [], agents: [] }], now: 9_000, omitted: false });
	assert.deepEqual(r2.launches, [{ at: 1, tasks: [], agents: [] }]);
	assert.equal(r2.state.agents.find((a) => a.key === "o1:task-1")!.task, "task-1");
	assert.equal(r2.state.nextOrch, 2);
});

test("applyOrchestrators key collision", () => {
	const launches: Launch[] = [{ at: 1, tasks: ["two-a", "two-b"], agents: ["a", "b"] }, { at: 1, tasks: ["three-a", "three-b", "three-c"], agents: ["a", "b", "c"] }];
	const so = orchestratorsFromSnapshot(snap([
		wf("X", [step("task-1", "a", "m", "running"), step("task-2", "b", "m", "running"), step("task-3", "c", "m", "running")], { startedAt: 2_000 }),
		wf("Y", [step("task-1", "a", "m", "running"), step("task-2", "b", "m", "running")], { startedAt: 1_000 }),
	]))!;
	const r = applyOrchestrators(S(), so, { launches, now: 9_000, omitted: false });
	assert.deepEqual(r.state.agents.filter((a) => a.orch === "X").map((a) => a.task), ["three-a", "three-b", "three-c"]);
	assert.deepEqual(r.state.agents.filter((a) => a.orch === "Y").map((a) => a.task), ["two-a", "two-b"]);
	assert.equal(new Set(r.state.agents.map((a) => a.key)).size, 5);
	assert.deepEqual(r.launches, []);
});

test("a script workflow does not steal a same-count parallel workflow's launch", () => {
	const so = orchestratorsFromSnapshot(snap([
		wf("script", [step("task-1", "c", "m", "running"), step("task-2", "d", "m", "running")], { startedAt: 1_000 }),
		wf("parallel", [step("task-1", "a", "m", "running"), step("task-2", "b", "m", "running")], { startedAt: 2_000 }),
	]))!;
	const launches: Launch[] = [
		{ at: 900, tasks: [], agents: [] },
		{ at: 1_000, tasks: ["parallel-a", "parallel-b"], agents: ["a", "b"] },
	];
	const r = applyOrchestrators(S(), so, { launches, now: 9_000, omitted: false });
	assert.deepEqual(r.state.agents.filter((a) => a.orch === "script").map((a) => a.task), ["task-1", "task-2"]);
	assert.deepEqual(r.state.agents.filter((a) => a.orch === "parallel").map((a) => a.task), ["parallel-a", "parallel-b"]);
	assert.deepEqual(r.launches, [launches[0]]);
});

test("a launch with different worker agents does not match", () => {
	const so = orchestratorsFromSnapshot(snap([wf("o1", [step("task-1", "a", "m", "running"), step("task-2", "b", "m", "running")])]))!;
	const launch: Launch = { at: 1_000, tasks: ["wrong-a", "wrong-b"], agents: ["b", "a"] };
	const r = applyOrchestrators(S(), so, { launches: [launch], now: 9_000, omitted: false });
	assert.deepEqual(r.state.agents.map((a) => a.task), ["task-1", "task-2"]);
	assert.deepEqual(r.launches, [launch]);
});

test("a launch newer than the orchestrator start does not match", () => {
	const so = orchestratorsFromSnapshot(snap([wf("o1", [step("task-1", "a", "m", "running"), step("task-2", "b", "m", "running")], { startedAt: 1_000 })]))!;
	const launch: Launch = { at: 6_001, tasks: ["new-a", "new-b"], agents: ["a", "b"] };
	const r = applyOrchestrators(S(), so, { launches: [launch], now: 9_000, omitted: false });
	assert.deepEqual(r.state.agents.map((a) => a.task), ["task-1", "task-2"]);
	assert.deepEqual(r.launches, [launch]);
});

test("applyOrchestrators later reads", () => {
	const so = orchestratorsFromSnapshot(snap([wf("o1", [step("task-1", "a", "m", "running"), step("task-2", "b", "m", "running")])]))!;
	let r = applyOrchestrators(S(), so, { launches: [{ at: 1, tasks: ["first task", "second task"], agents: ["a", "b"] }], now: 9_000, omitted: false });
	// same snapshot again: numbering and task texts survive the rebuild
	r = applyOrchestrators(r.state, so, { launches: [], now: 20_000, omitted: false });
	assert.equal(r.state.orchestrators![0].n, 1);
	assert.equal(r.state.agents.find((a) => a.key === "o1:task-1")!.task, "first task");
	// vanished running orchestrator finishes, and so do its working rows
	r = applyOrchestrators(r.state, [], { launches: [], now: 30_000, omitted: false });
	assert.equal(r.state.orchestrators![0].state, "done");
	assert.equal(r.state.orchestrators![0].endedAt, 30_000);
	assert.ok(r.state.agents.every((a) => a.state === "done"));
	assert.equal(r.state.agents.find((a) => a.key === "o1:task-1")!.task, "first task");
	// the same vanishing read with a truncated snapshot must not decide anything
	const mid = applyOrchestrators(
		applyOrchestrators(S(), so, { launches: [{ at: 1, tasks: ["first task", "second task"], agents: ["a", "b"] }], now: 9_000, omitted: false }).state,
		[], { launches: [], now: 30_000, omitted: true },
	);
	assert.equal(mid.state.orchestrators![0].state, "running");
	assert.equal(mid.state.orchestrators![0].endedAt, undefined);
	assert.equal(mid.state.agents.find((a) => a.key === "o1:task-1")!.state, "working");
	// a direct row (no orch) is never touched
	const direct: AgentRow = { key: "d", name: "direct", model: "m", state: "failed", task: "keep me" };
	const withDirect = applyOrchestrators({ ...mid.state, agents: [...mid.state.agents, direct] }, [], { launches: [], now: 40_000, omitted: false });
	assert.deepEqual(withDirect.state.agents.find((a) => a.key === "d"), direct);
});

test("applyOrchestrators cap keeps a returning 13th orchestrator and stable numbers", () => {
	const so = orchestratorsFromSnapshot(snap(Array.from({ length: 21 }, (_, i) => wf(`o${i + 1}`, [step("task-1", "a", "m", "running")]))))!;
	const first = applyOrchestrators(S(), so, { launches: [], now: 9_000, omitted: false });
	assert.equal(first.state.orchestrators!.length, 21);
	assert.equal(first.state.nextOrch, 22);
	const second = applyOrchestrators(first.state, so, { launches: [], now: 20_000, omitted: false });
	assert.deepEqual(second.state.orchestrators, first.state.orchestrators);
	assert.equal(second.state.nextOrch, 22);
	assert.equal(second.state.agents.length, 21);
	// Only orchestrators absent from the current snapshot compete for the 20 retained slots.
	const gone = applyOrchestrators(second.state, [], { launches: [], now: 30_000, omitted: false });
	assert.equal(gone.state.orchestrators!.length, 20);
	assert.ok(!gone.state.orchestrators!.some((x) => x.n === 1));
	assert.equal(gone.state.nextOrch, 22);
});

test("launchFromArgs / addLaunch", () => {
	assert.deepEqual(launchFromArgs({ workflow: "parallel", args: { tasks: [{ agent: "a", task: "do x" }, { agent: "b", task: "do y" }] } }, 5, "call-1"), { at: 5, id: "call-1", tasks: ["do x", "do y"], agents: ["a", "b"] });
	assert.deepEqual(launchFromArgs({ workflow: true }, 5), { at: 5, tasks: [], agents: [] });
	assert.equal(launchFromArgs({ agent: "x", task: "y" }, 5), undefined);
	assert.equal(launchFromArgs({ workflow: "p", action: "status" }, 5), undefined);
	let list: Launch[] = [];
	for (let i = 0; i < 20; i++) list = addLaunch(list, { at: 1_000 + i, tasks: ["t"], agents: ["a"] }, 2_000);
	assert.equal(list.length, 16);
	assert.equal(list[0]!.at, 1_004); // the newest 16 are kept
	assert.deepEqual(addLaunch([{ at: 0, tasks: ["t"], agents: ["a"] }], { at: 600_001, tasks: ["n"], agents: ["a"] }, 600_001), [{ at: 600_001, tasks: ["n"], agents: ["a"] }]); // older than 10 min is dropped
});

test("launchFromArgs bounds tasks and agents", () => {
	const launch = launchFromArgs({ workflow: "parallel", args: { tasks: Array.from({ length: 70 }, () => ({ agent: "a".repeat(250), task: "t".repeat(250) })) } }, 5)!;
	assert.equal(launch.tasks.length, 64);
	assert.equal(launch.agents.length, 64);
	assert.ok(launch.tasks.every((t) => t === "t".repeat(200)));
	assert.ok(launch.agents.every((a) => a === "a".repeat(200)));
});

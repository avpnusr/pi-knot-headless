import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { openRoute, pollRoute, routeCounts } from "./nestedroute.ts";
import { makeRoute, ev, ROOT } from "./fakepi.ts";

test("openRoute accepts only <..>/nested-subagent-events/<root>-<token>/events", () => {
	const { payload, sink } = makeRoute();
	assert.ok(openRoute(payload));
	for (const bad of [undefined, {}, { nestedRoute: {} }, { nestedRoute: { rootRunId: ROOT, eventSink: "/etc" } }, { nestedRoute: { rootRunId: "../x", eventSink: sink } }, { nestedRoute: { rootRunId: "other", eventSink: sink } }, { nestedRoute: { rootRunId: ROOT, eventSink: `${sink}/../../..` } }]) {
		assert.equal(openRoute(bad), undefined, JSON.stringify(bad));
	}
});

test("pollRoute counts distinct children, steps count once each, repeats and later updates do not double count", () => {
	const { payload, sink } = makeRoute();
	const r = openRoute(payload)!;
	writeFileSync(join(sink, "1-a.json"), ev("subagent.nested.started", "c1"));
	writeFileSync(join(sink, "2-b.json"), ev("subagent.nested.started", "c2"));
	pollRoute(r);
	assert.deepEqual([...routeCounts([r])], [["security-reviewer", { n: 2, truncated: false }]]);
	writeFileSync(join(sink, "3-c.json"), ev("subagent.nested.completed", "c1", { state: "complete", steps: [{}, {}] })); // parallel child with 2 steps
	writeFileSync(join(sink, "4-d.json"), ev("subagent.nested.updated", "c2", { state: "complete" }));
	pollRoute(r); pollRoute(r);
	assert.equal(routeCounts([r]).get("security-reviewer")!.n, 3);
});

test("pollRoute skips symlinks, oversized, foreign-root, malformed and dot files; a missing dir is harmless", () => {
	const { payload, sink } = makeRoute();
	const r = openRoute(payload)!;
	writeFileSync(join(sink, "real-target.txt"), ev("subagent.nested.started", "evil"));
	symlinkSync(join(sink, "real-target.txt"), join(sink, "1-link.json"));
	writeFileSync(join(sink, "2-big.json"), ev("subagent.nested.started", "big", { pad: "x".repeat(70_000) }));
	writeFileSync(join(sink, "3-foreign.json"), ev("subagent.nested.started", "f", {}, "someone-else"));
	writeFileSync(join(sink, "4-bad.json"), "{not json");
	writeFileSync(join(sink, ".5-dot.json"), ev("subagent.nested.started", "dot"));
	writeFileSync(join(sink, "6-ok.json"), ev("subagent.nested.started", "ok"));
	pollRoute(r);
	assert.equal(routeCounts([r]).get("security-reviewer")!.n, 1);
	pollRoute({ ...r, dir: join(sink, "gone") }); // must not throw
});

test("pollRoute caps files per poll and marks the route truncated at the route cap", () => {
	const { payload, sink } = makeRoute();
	const r = openRoute(payload)!;
	for (let i = 0; i < 250; i++) writeFileSync(join(sink, `${String(i).padStart(4, "0")}-e.json`), ev("subagent.nested.started", `c${i}`));
	pollRoute(r);
	assert.equal(r.seen.size, 200);
	pollRoute(r);
	assert.equal(routeCounts([r]).get("security-reviewer")!.n, 250);
	r.seen = new Set(Array.from({ length: 5000 }, (_, i) => `s${i}`)); // route cap reached
	writeFileSync(join(sink, "9999-late.json"), ev("subagent.nested.started", "late"));
	pollRoute(r);
	assert.equal(routeCounts([r]).get("security-reviewer")!.truncated, true);
});
